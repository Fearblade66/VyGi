use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Instant;

use tokio::sync::{mpsc, Mutex};

use crate::error::{AppError, AppResult};
use crate::security::ProfileStore;
use crate::ssh::{SshClient, TermInput};
use crate::vyos_api::VyosApi;

/// A live connection to one router.
pub struct Connection {
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

pub struct AppState {
    conn: Mutex<Option<Arc<Connection>>>,
    pub profiles: ProfileStore,
    /// Open terminals and streams, by id.
    pub sessions: Mutex<HashMap<u32, mpsc::Sender<TermInput>>>,
    next_session: AtomicU32,
    pub tx: Mutex<TxState>,
}

impl AppState {
    pub fn new(profiles: ProfileStore) -> Self {
        Self {
            conn: Mutex::new(None),
            profiles,
            sessions: Mutex::new(HashMap::new()),
            next_session: AtomicU32::new(1),
            tx: Mutex::new(TxState::default()),
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
