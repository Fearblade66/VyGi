use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Instant;

use std::sync::Mutex as StdMutex;

use tauri::ipc::{CommandArg, CommandItem, InvokeError};
use tauri::{Manager, Runtime};
use tokio::sync::{mpsc, Mutex};

use crate::error::{AppError, AppResult};
use crate::security::ProfileStore;
use crate::ssh::{SshClient, TermInput};
use crate::vyos_api::VyosApi;

/// A live connection to one router.
pub struct Connection {
    /// `user@host`, used to file this router's local backups.
    pub profile_id: String,
    pub api: VyosApi,
    pub ssh: SshClient,
}

/// Commit bookkeeping for the toolbar badges.
#[derive(Default)]
pub struct TxState {
    /// When the pending commit-confirm will auto-revert, if any.
    pub confirm_deadline: Option<Instant>,
    /// Committed changes that have not been saved to the boot config.
    pub unsaved: bool,
}

/// App-wide state: saved routers plus one [`WindowState`] per app window,
/// so every window can be connected to a different router.
pub struct AppState {
    pub profiles: ProfileStore,
    windows: StdMutex<HashMap<String, Arc<WindowState>>>,
    /// Technitium tokens kept for this run only when the OS keychain is unavailable.
    pub dns_tokens: StdMutex<HashMap<String, String>>,
    /// GeoIP databases, loaded on first lookup.
    pub geo: StdMutex<Option<Arc<crate::geoip::GeoDb>>>,
}

impl AppState {
    pub fn new(profiles: ProfileStore) -> Self {
        Self {
            profiles,
            windows: StdMutex::new(HashMap::new()),
            dns_tokens: StdMutex::new(HashMap::new()),
            geo: StdMutex::new(None),
        }
    }

    pub fn window(&self, label: &str) -> Arc<WindowState> {
        let mut map = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(label.to_string()).or_default().clone()
    }

    /// Forgets a closed window and hands back its state for cleanup.
    pub fn remove_window(&self, label: &str) -> Option<Arc<WindowState>> {
        let mut map = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(label)
    }
}

/// The connection and everything tied to it, for one app window.
pub struct WindowState {
    conn: Mutex<Option<Arc<Connection>>>,
    /// Open terminals and streams, by id.
    pub sessions: Mutex<HashMap<u32, mpsc::Sender<TermInput>>>,
    next_session: AtomicU32,
    pub tx: Mutex<TxState>,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            conn: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            next_session: AtomicU32::new(1),
            tx: Mutex::new(TxState::default()),
        }
    }
}

/// Command argument resolving to the calling window's [`WindowState`].
pub struct Win(Arc<WindowState>);

impl std::ops::Deref for Win {
    type Target = WindowState;
    fn deref(&self) -> &WindowState {
        &self.0
    }
}

impl<'de, R: Runtime> CommandArg<'de, R> for Win {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        let webview = command.message.webview_ref();
        let app = webview
            .try_state::<AppState>()
            .ok_or_else(|| InvokeError::from("app state not ready"))?;
        Ok(Win(app.window(webview.window().label())))
    }
}

impl WindowState {
    /// Closes the connection and its terminals/streams.
    pub async fn disconnect(&self) {
        self.close_sessions().await;
        if let Some(old) = self.set_conn(None).await {
            old.ssh.disconnect().await;
        }
    }

    /// The active connection. The lock is released before returning, so
    /// callers never hold it across network calls.
    pub async fn conn(&self) -> AppResult<Arc<Connection>> {
        let guard = self.conn.lock().await;
        match guard.as_ref() {
            Some(c) if !c.ssh.is_closed() => Ok(c.clone()),
            _ => Err(AppError::NotConnected),
        }
    }

    pub async fn set_conn(&self, conn: Option<Arc<Connection>>) -> Option<Arc<Connection>> {
        let mut guard = self.conn.lock().await;
        std::mem::replace(&mut *guard, conn)
    }

    pub fn next_session_id(&self) -> u32 {
        self.next_session.fetch_add(1, Ordering::Relaxed)
    }

    /// Closes all terminals/streams (used on disconnect).
    pub async fn close_sessions(&self) {
        let mut sessions = self.sessions.lock().await;
        for (_, tx) in sessions.drain() {
            let _ = tx.send(TermInput::Close).await;
        }
    }
}
