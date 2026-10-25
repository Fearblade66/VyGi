//! Config backup to a local file and restore from one.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::connection::path;
use crate::error::{AppError, AppResult};
use crate::state::{Connection, Win};
use crate::transactions::{commit, record_commit, status, TxStatus};

/// Refuse to load anything this big; real configs are a few hundred KB.
const MAX_IMPORT_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    /// config.boot syntax, can be restored with `import_config`.
    Boot,
    /// `set ...` lines, for reading or pasting into a terminal.
    Commands,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    bytes: usize,
    /// Without the version footer, restoring on another VyOS version may mis-migrate.
    has_version_footer: bool,
}

/// The running config as a full config.boot. Revision 0 of the commit archive
/// includes the version footer that migrations rely on; fall back to the raw
/// config tree if the archive is unavailable.
pub(crate) async fn running_boot(conn: &Connection) -> AppResult<String> {
    match conn
        .api
        .show(&path(&["system", "commit", "file", "0"]))
        .await
    {
        Ok(t) if !t.trim().is_empty() => Ok(strip_noise(&t)),
        _ => conn.api.show_config_raw().await.map(|t| strip_noise(&t)),
    }
}

/// Drops warnings some systems print before the config (e.g. sudo/hostname,
/// perl locale), which would make the text unloadable.
pub(crate) fn strip_noise(text: &str) -> String {
    let noise = |l: &str| {
        let t = l.trim_start();
        t.starts_with("sudo: ")
            || t.starts_with("perl: warning")
            || t.starts_with("LANGUAGE =")
            || t.starts_with("LC_ALL =")
            || t.starts_with("LC_CTYPE =")
            || t.starts_with("LANG =")
            || t.starts_with("are supported and installed")
    };
    let mut out: String = text
        .lines()
        .filter(|l| !noise(l))
        .collect::<Vec<_>>()
        .join("\n");
    if text.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Writes the running config to `file` (a path the user picked in a save dialog).
#[tauri::command]
pub async fn export_config(
    state: Win,
    file: PathBuf,
    format: ExportFormat,
) -> AppResult<ExportResult> {
    let conn = state.conn().await?;
    let text = match format {
        ExportFormat::Boot => running_boot(&conn).await?,
        ExportFormat::Commands => conn.api.show(&path(&["configuration", "commands"])).await?,
    };
    if text.trim().is_empty() {
        return Err(AppError::Api(
            "router returned an empty configuration".into(),
        ));
    }
    std::fs::write(&file, &text)?;
    Ok(ExportResult {
        bytes: text.len(),
        has_version_footer: text.contains("vyos-config-version"),
    })
}

/// Writes text the UI produced (e.g. a WireGuard client config) to a file the user picked.
#[tauri::command]
pub fn save_text_file(file: PathBuf, contents: String) -> AppResult<()> {
    std::fs::write(file, contents)?;
    Ok(())
}

/// Replaces the running config with the contents of a config.boot file.
#[tauri::command]
pub async fn import_config(state: Win, file: PathBuf, confirm_minutes: u32) -> AppResult<TxStatus> {
    if std::fs::metadata(&file)?.len() > MAX_IMPORT_BYTES {
        return Err(AppError::Invalid(
            "file is too large to be a VyOS config".into(),
        ));
    }
    let text = std::fs::read_to_string(&file)?;
    check_boot_format(&text)?;
    let conn = state.conn().await?;
    let minutes = confirm_minutes.min(60);
    let msg = commit(&state, &conn, || {
        Box::pin(conn.api.load_config_text(&text, minutes))
    })
    .await?;
    record_commit(&state, minutes).await;
    Ok(status(&state, msg).await)
}

/// Rejects files that are obviously not config.boot syntax.
fn check_boot_format(text: &str) -> AppResult<()> {
    let first = text.lines().map(str::trim).find(|l| {
        !l.is_empty() && !l.starts_with("//") && !l.starts_with("/*") && !l.starts_with('#')
    });
    match first {
        None => Err(AppError::Invalid("the file is empty".into())),
        Some(l) if l.starts_with("set ") || l.starts_with("delete ") => Err(AppError::Invalid(
            "this is a `set` commands export. Only config.boot-format backups can be restored here; \
             paste command exports into a terminal in configure mode instead."
                .into(),
        )),
        Some(l) if !l.contains('{') => Err(AppError::Invalid(
            "this does not look like a VyOS config.boot file".into(),
        )),
        Some(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_system_noise() {
        let t = "sudo: unable to resolve host vyos: System error\nfirewall {\n}\n// Release version: 1\n";
        assert_eq!(strip_noise(t), "firewall {\n}\n// Release version: 1\n");
        assert_eq!(strip_noise("a {\n}"), "a {\n}");
    }

    #[test]
    fn detects_formats() {
        assert!(check_boot_format("interfaces {\n ethernet eth0 {\n }\n}\n").is_ok());
        assert!(check_boot_format("/* comment */\nsystem {\n}\n").is_ok());
        assert!(check_boot_format("set system host-name x\n").is_err());
        assert!(check_boot_format("\n\n").is_err());
        assert!(check_boot_format("hello world").is_err());
    }
}
