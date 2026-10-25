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

use crate::connection::path;
use crate::error::{AppError, AppResult};
use crate::state::{Connection, Win, WindowState};
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

pub(crate) async fn status(state: &WindowState, message: String) -> TxStatus {
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
/// pending ("Another confirm is pending"). If the pending change is this
/// window's own, being able to send this request proves it didn't cut us
/// off, so it is confirmed first. A change pending from elsewhere (another
/// window, the CLI) is never confirmed silently: the UI asks.
pub(crate) async fn commit<'a, F>(
    state: &WindowState,
    conn: &Connection,
    run: F,
) -> AppResult<String>
where
    F: Fn() -> CommitFuture<'a>,
{
    let ours = matches!(state.tx.lock().await.confirm_deadline, Some(d) if d > Instant::now());
    if ours {
        conn.api.confirm().await?;
        state.tx.lock().await.confirm_deadline = None;
        return Ok(format!("{AUTO_CONFIRMED}\n{}", run().await?));
    }
    // Check first: with a confirm pending, VyOS still applies a new commit and only
    // then fails to start its revert timer, so the change would go in unprotected.
    if confirm_pending(conn).await {
        return Err(AppError::ForeignPending);
    }
    match run().await {
        Err(AppError::Api(m)) if m.contains("confirm is pending") => Err(AppError::Api(
            "The change was applied, but its Safe Mode timer could not start because another change \
             started waiting for Confirm at the same moment. Check it, then Confirm or roll back."
                .into(),
        )),
        other => other,
    }
}

/// Whether a commit-confirm is waiting on the router (VyOS runs it as a systemd timer).
pub(crate) async fn confirm_pending(conn: &Connection) -> bool {
    conn.ssh
        .exec(
            "systemctl is-active commit-confirm.timer",
            Duration::from_secs(10),
        )
        .await
        .map(|o| o.stdout.trim() == "active")
        .unwrap_or(false)
}

pub(crate) async fn record_commit(state: &WindowState, confirm_minutes: u32) {
    let mut tx = state.tx.lock().await;
    tx.unsaved = true;
    tx.confirm_deadline = if confirm_minutes > 0 {
        Some(Instant::now() + Duration::from_secs(u64::from(confirm_minutes) * 60))
    } else {
        None // a plain commit also confirms a pending one
    };
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn tx_status(state: Win) -> AppResult<TxStatus> {
    Ok(status(&state, String::new()).await)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn get_config(state: Win, path: Vec<String>) -> AppResult<Value> {
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
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn run_show(state: Win, path: Vec<String>) -> AppResult<String> {
    state.conn().await?.api.show(&path).await
}

/// Applies set/delete commands. `confirm_minutes > 0` = Safe Mode.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn apply_changes(
    state: Win,
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
    // VyOS commits section by section: when one part fails, the parts before
    // it stay applied. Keep the last committed config (VyOS's own archive copy,
    // clean config.boot text) so a failure can be undone.
    // A failed commit doesn't reach the archive, so changes are detected on
    // the live config and undone from the archive copy.
    let before = match (
        conn.api.show_config(&[]).await,
        crate::backup::running_boot(&conn).await,
    ) {
        (Ok(live), Ok(text)) => Some((live, text)),
        _ => None,
    };
    let result = commit(&state, &conn, || {
        Box::pin(conn.api.configure(&commands, minutes))
    })
    .await;
    let msg = match result {
        Ok(msg) => msg,
        Err(e) => return Err(undo_partial(&state, &conn, before, e).await),
    };
    record_commit(&state, minutes).await;
    Ok(status(&state, msg).await)
}

/// After a failed commit: if the running config changed anyway (partially
/// applied), put back the config from before. Returns the error to report.
async fn undo_partial(
    state: &WindowState,
    conn: &Connection,
    before: Option<(Value, String)>,
    err: AppError,
) -> AppError {
    let Some((live, text)) = before.filter(|(_, t)| !t.trim().is_empty()) else {
        return err;
    };
    match conn.api.show_config(&[]).await {
        Ok(now) if now != live => {}
        _ => return err,
    }
    let undone = commit(state, conn, || {
        Box::pin(conn.api.load_config_text(&text, 0))
    })
    .await;
    // the inner message: `err` already says "Router API error"
    let first = match &err {
        AppError::Api(m) => m.clone(),
        other => other.to_string(),
    };
    match undone {
        Ok(_) => AppError::Api(format!(
            "{first}\n\nThe router had applied part of this change before the error. VyGi put the configuration back the way it was."
        )),
        Err(e2) => AppError::Api(format!(
            "{first}\n\nThe router applied part of this change and VyGi could not undo it ({e2}). Check System > Revisions / Rollback."
        )),
    }
}

/// Keeps the pending Safe Mode commit.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn confirm_commit(state: Win) -> AppResult<TxStatus> {
    let conn = state.conn().await?;
    let msg = conn.api.confirm().await?;
    state.tx.lock().await.confirm_deadline = None;
    Ok(status(&state, msg).await)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn save_config(state: Win) -> AppResult<TxStatus> {
    let conn = state.conn().await?;
    let msg = conn.api.save().await?;
    state.tx.lock().await.unsaved = false;
    Ok(status(&state, msg).await)
}

/// Text of `show system commit` (the revision list).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn list_revisions(state: Win) -> AppResult<String> {
    state
        .conn()
        .await?
        .api
        .show(&path(&["system", "commit"]))
        .await
}

/// Diff between revision `rev` and the one before it (or `rev2` if given).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn revision_diff(state: Win, rev: u32, rev2: Option<u32>) -> AppResult<String> {
    let mut p = path(&["system", "commit", "diff"]);
    p.push(rev.to_string());
    if let Some(r2) = rev2 {
        p = path(&["system", "commit", "file"]);
        p.extend([rev.to_string(), "compare".into(), r2.to_string()]);
    }
    state.conn().await?.api.show(&p).await
}

/// Loads revision `rev` as the running config, without rebooting.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn rollback_to(state: Win, rev: u32, confirm_minutes: u32) -> AppResult<TxStatus> {
    let minutes = check_minutes(confirm_minutes)?;
    let conn = state.conn().await?;
    let mut p = path(&["system", "commit", "file"]);
    p.push(rev.to_string());
    // Warnings the router prints (e.g. "sudo: unable to resolve host") would make it unloadable.
    let config_text = crate::backup::strip_noise(&conn.api.show(&p).await?);
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
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn set_revert_action(state: Win, action: String) -> AppResult<TxStatus> {
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
