//! Safe Mode, commits, saving, and revision history.
//!
//! VyOS equivalents of Winbox concepts:
//! - Safe Mode  -> commit-confirm: the router reverts by itself unless confirmed.
//! - Rollback   -> load an older revision from `show system commit file N`.
//! - "Save"     -> VyOS commits are live but lost on reboot until saved.

use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::connection::path;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, Connection};
use crate::vyos_api::ConfigCommand;

/// Max commit-confirm window we allow from the UI.
const MAX_CONFIRM_MINUTES: u32 = 60;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxStatus {
    /// Seconds until the router auto-reverts, if a commit is waiting for confirmation.
    confirm_seconds_left: Option<u64>,
    unsaved: bool,
    message: String,
}

pub(crate) async fn status(state: &AppState, message: String) -> TxStatus {
    let mut tx = state.tx.lock().await;
    let now = Instant::now();
    if matches!(tx.confirm_deadline, Some(d) if d <= now) {
        tx.confirm_deadline = None; // router has reverted by now
    }
    TxStatus {
        confirm_seconds_left: tx
            .confirm_deadline
            .map(|d| d.saturating_duration_since(now).as_secs()),
        unsaved: tx.unsaved,
        message,
    }
}

fn check_minutes(m: u32) -> AppResult<u32> {
    if m > MAX_CONFIRM_MINUTES {
        return Err(AppError::Invalid(format!(
            "Safe Mode timeout must be 0-{MAX_CONFIRM_MINUTES} minutes"
        )));
    }
    Ok(m)
}

pub(crate) type CommitFuture<'a> = Pin<Box<dyn Future<Output = AppResult<String>> + Send + 'a>>;

pub(crate) const AUTO_CONFIRMED: &str = "Previous Safe Mode changes were confirmed automatically.";

/// Runs one commit. VyOS refuses a new commit while a commit-confirm is
/// pending ("Another confirm is pending"). Being able to send this request
/// proves the pending change didn't cut us off, so confirm it first.
pub(crate) async fn commit<'a, F>(state: &AppState, conn: &Connection, run: F) -> AppResult<String>
where
    F: Fn() -> CommitFuture<'a>,
{
    let pending = matches!(state.tx.lock().await.confirm_deadline, Some(d) if d > Instant::now());
    if pending {
        conn.api.confirm().await?;
        state.tx.lock().await.confirm_deadline = None;
        return Ok(format!("{AUTO_CONFIRMED}\n{}", run().await?));
    }
    match run().await {
        // Pending from another tool, or our timer state was lost.
        Err(AppError::Api(m)) if m.contains("confirm is pending") => {
            conn.api.confirm().await?;
            Ok(format!("{AUTO_CONFIRMED}\n{}", run().await?))
        }
        other => other,
    }
}

pub(crate) async fn record_commit(state: &AppState, confirm_minutes: u32) {
    let mut tx = state.tx.lock().await;
    tx.unsaved = true;
    tx.confirm_deadline = if confirm_minutes > 0 {
        Some(Instant::now() + Duration::from_secs(u64::from(confirm_minutes) * 60))
    } else {
        None // a plain commit also confirms a pending one
    };
}

#[tauri::command]
pub async fn tx_status(state: State<'_, AppState>) -> AppResult<TxStatus> {
    Ok(status(&state, String::new()).await)
}

#[tauri::command]
pub async fn get_config(state: State<'_, AppState>, path: Vec<String>) -> AppResult<Value> {
    let conn = state.conn().await?;
    match conn.api.show_config(&path).await {
        Ok(v) => Ok(v),
        // A path that isn't configured comes back as an error; the UI wants "empty".
        Err(AppError::Api(msg)) if msg.contains("empty") || msg.contains("does not exist") => {
            Ok(Value::Object(Default::default()))
        }
        Err(e) => Err(e),
    }
}

/// Runs an operational `show ...` command through the API.
#[tauri::command]
pub async fn run_show(state: State<'_, AppState>, path: Vec<String>) -> AppResult<String> {
    state.conn().await?.api.show(&path).await
}

/// Applies set/delete commands. `confirm_minutes > 0` = Safe Mode.
#[tauri::command]
pub async fn apply_changes(
    state: State<'_, AppState>,
    commands: Vec<ConfigCommand>,
    confirm_minutes: u32,
) -> AppResult<TxStatus> {
    if commands.is_empty() {
        return Err(AppError::Invalid("nothing to apply".into()));
    }
    for c in &commands {
        if !matches!(c.op.as_str(), "set" | "delete" | "comment") || c.path.is_empty() {
            return Err(AppError::Invalid(format!(
                "bad command {} {:?}",
                c.op, c.path
            )));
        }
    }
    let minutes = check_minutes(confirm_minutes)?;
    let conn = state.conn().await?;
    let msg = commit(&state, &conn, || {
        Box::pin(conn.api.configure(&commands, minutes))
    })
    .await?;
    record_commit(&state, minutes).await;
    Ok(status(&state, msg).await)
}

/// Keeps the pending Safe Mode commit.
#[tauri::command]
pub async fn confirm_commit(state: State<'_, AppState>) -> AppResult<TxStatus> {
    let conn = state.conn().await?;
    let msg = conn.api.confirm().await?;
    state.tx.lock().await.confirm_deadline = None;
    Ok(status(&state, msg).await)
}

#[tauri::command]
pub async fn save_config(state: State<'_, AppState>) -> AppResult<TxStatus> {
    let conn = state.conn().await?;
    let msg = conn.api.save().await?;
    state.tx.lock().await.unsaved = false;
    Ok(status(&state, msg).await)
}

/// Text of `show system commit` (the revision list).
#[tauri::command]
pub async fn list_revisions(state: State<'_, AppState>) -> AppResult<String> {
    state
        .conn()
        .await?
        .api
        .show(&path(&["system", "commit"]))
        .await
}

/// Diff between revision `rev` and the one before it (or `rev2` if given).
#[tauri::command]
pub async fn revision_diff(
    state: State<'_, AppState>,
    rev: u32,
    rev2: Option<u32>,
) -> AppResult<String> {
    let mut p = path(&["system", "commit", "diff"]);
    p.push(rev.to_string());
    if let Some(r2) = rev2 {
        p = path(&["system", "commit", "file"]);
        p.extend([rev.to_string(), "compare".into(), r2.to_string()]);
    }
    state.conn().await?.api.show(&p).await
}

/// Loads revision `rev` as the running config, without rebooting.
#[tauri::command]
pub async fn rollback_to(
    state: State<'_, AppState>,
    rev: u32,
    confirm_minutes: u32,
) -> AppResult<TxStatus> {
    let minutes = check_minutes(confirm_minutes)?;
    let conn = state.conn().await?;
    let mut p = path(&["system", "commit", "file"]);
    p.push(rev.to_string());
    let config_text = conn.api.show(&p).await?;
    if config_text.trim().is_empty() {
        return Err(AppError::Api(format!("revision {rev} is empty or missing")));
    }
    let msg = commit(&state, &conn, || {
        Box::pin(conn.api.load_config_text(&config_text, minutes))
    })
    .await?;
    record_commit(&state, minutes).await;
    Ok(status(&state, msg).await)
}

/// Sets what the router does when Safe Mode times out ("reload" is the gentle one).
#[tauri::command]
pub async fn set_revert_action(state: State<'_, AppState>, action: String) -> AppResult<TxStatus> {
    if action != "reload" && action != "reboot" {
        return Err(AppError::Invalid("action must be reload or reboot".into()));
    }
    let conn = state.conn().await?;
    let cmd = ConfigCommand {
        op: "set".into(),
        path: path(&["system", "config-management", "commit-confirm", "action"]),
        value: Some(action),
    };
    let cmds = [cmd];
    let msg = commit(&state, &conn, || Box::pin(conn.api.configure(&cmds, 0))).await?;
    record_commit(&state, 0).await;
    Ok(status(&state, msg).await)
}
