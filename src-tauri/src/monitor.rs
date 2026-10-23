//! Live data read over SSH from Linux tools (JSON where available).

use serde::Deserialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::ssh::{shell_quote, validate_name, StreamEvent, TermInput};
use crate::state::AppState;

const SPLIT_MARK: &str = "@@VYGI@@";

/// Link state, type and byte/packet counters (`links`) plus addresses (`addrs`)
/// for every interface. The UI polls this and computes rates from counter deltas.
#[tauri::command]
pub async fn interface_stats(state: State<'_, AppState>) -> AppResult<Value> {
    let cmd = format!("ip -j -s -d link show && echo {SPLIT_MARK} && ip -j addr show");
    let out = state.conn().await?.ssh.exec_ok(&cmd).await?;
    let (links, addrs) = out
        .split_once(SPLIT_MARK)
        .ok_or_else(|| AppError::Ssh("unexpected `ip` output".into()))?;
    Ok(serde_json::json!({
        "links": serde_json::from_str::<Value>(links.trim())?,
        "addrs": serde_json::from_str::<Value>(addrs.trim())?,
    }))
}

/// Kernel routing table, optionally for one VRF.
#[tauri::command]
pub async fn routes(
    state: State<'_, AppState>,
    family: u8,
    vrf: Option<String>,
) -> AppResult<Value> {
    if family != 4 && family != 6 {
        return Err(AppError::Invalid("family must be 4 or 6".into()));
    }
    let mut cmd = format!("ip -j -{family} route show");
    if let Some(v) = vrf.as_deref().filter(|v| !v.is_empty() && *v != "default") {
        cmd.push_str(" vrf ");
        cmd.push_str(validate_name(v)?);
    }
    let out = state.conn().await?.ssh.exec_ok(&cmd).await?;
    if out.trim().is_empty() {
        return Ok(Value::Array(Vec::new()));
    }
    Ok(serde_json::from_str(&out)?)
}

/// `wg show all dump`: tab-separated interface and peer lines.
#[tauri::command]
pub async fn wireguard_dump(state: State<'_, AppState>) -> AppResult<String> {
    state
        .conn()
        .await?
        .ssh
        .exec_ok("sudo -n wg show all dump")
        .await
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamKind {
    /// Follow the system journal (JSON lines, so the UI can filter by priority).
    Syslog {
        lines: u32,
    },
    /// Packet capture, Winbox "Torch"-like.
    Capture {
        interface: String,
        filter: String,
    },
    Ping {
        target: String,
        count: u32,
    },
    Traceroute {
        target: String,
    },
}

fn stream_command(kind: &StreamKind) -> AppResult<String> {
    Ok(match kind {
        StreamKind::Syslog { lines } => {
            format!(
                "sudo -n journalctl -f -o json --no-pager -n {}",
                lines.min(&5000)
            )
        }
        StreamKind::Capture { interface, filter } => {
            let iface = validate_name(interface)?;
            let mut cmd = format!("sudo -n tcpdump -l -n -nn -i {iface} -c 20000");
            if !filter.trim().is_empty() {
                cmd.push(' ');
                cmd.push_str(&shell_quote(filter.trim()));
            }
            cmd
        }
        StreamKind::Ping { target, count } => {
            format!(
                "ping -c {} -- {}",
                (*count).clamp(1, 1000),
                shell_quote(check_target(target)?)
            )
        }
        StreamKind::Traceroute { target } => {
            format!("traceroute -n -- {}", shell_quote(check_target(target)?))
        }
    })
}

fn check_target(t: &str) -> AppResult<&str> {
    let t = t.trim();
    if t.is_empty() || t.starts_with('-') || t.len() > 253 {
        return Err(AppError::Invalid("bad target address".into()));
    }
    Ok(t)
}

#[tauri::command]
pub async fn open_stream(
    state: State<'_, AppState>,
    kind: StreamKind,
    on_data: Channel<StreamEvent>,
) -> AppResult<u32> {
    let cmd = stream_command(&kind)?;
    let conn = state.conn().await?;
    let tx = conn.ssh.open_stream(&cmd, on_data).await?;
    let id = state.next_session_id();
    state.sessions.lock().await.insert(id, tx);
    Ok(id)
}

#[tauri::command]
pub async fn open_terminal(
    state: State<'_, AppState>,
    cols: u32,
    rows: u32,
    on_data: Channel<StreamEvent>,
) -> AppResult<u32> {
    let conn = state.conn().await?;
    let tx = conn
        .ssh
        .open_shell(cols.max(10), rows.max(5), on_data)
        .await?;
    let id = state.next_session_id();
    state.sessions.lock().await.insert(id, tx);
    Ok(id)
}

async fn send_input(state: &AppState, id: u32, input: TermInput) -> AppResult<()> {
    let tx = state
        .sessions
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| AppError::Invalid(format!("session {id} is closed")))?;
    tx.send(input)
        .await
        .map_err(|_| AppError::Ssh(format!("session {id} has ended")))
}

#[tauri::command]
pub async fn term_write(state: State<'_, AppState>, id: u32, data: String) -> AppResult<()> {
    send_input(&state, id, TermInput::Data(data.into_bytes())).await
}

#[tauri::command]
pub async fn term_resize(
    state: State<'_, AppState>,
    id: u32,
    cols: u32,
    rows: u32,
) -> AppResult<()> {
    send_input(&state, id, TermInput::Resize { cols, rows }).await
}

#[tauri::command]
pub async fn close_session(state: State<'_, AppState>, id: u32) -> AppResult<()> {
    if let Some(tx) = state.sessions.lock().await.remove(&id) {
        let _ = tx.send(TermInput::Close).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_filter_is_quoted() {
        let cmd = stream_command(&StreamKind::Capture {
            interface: "eth0".into(),
            filter: "port 53; reboot".into(),
        })
        .unwrap_or_default();
        assert!(cmd.ends_with("'port 53; reboot'"));
    }

    #[test]
    fn rejects_option_injection() {
        assert!(stream_command(&StreamKind::Ping {
            target: "-f".into(),
            count: 3
        })
        .is_err());
        assert!(stream_command(&StreamKind::Capture {
            interface: "eth0 -w /x".into(),
            filter: String::new()
        })
        .is_err());
    }
}
