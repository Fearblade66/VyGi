//! Connect-time check-up, made for an app that is only open now and then:
//! - keeps a local backup history (a snapshot whenever the config changed),
//! - reports what changed since the last snapshot,
//! - gathers a quick health summary and whether there are unsaved changes.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::backup::running_boot;
use crate::connection::path;
use crate::error::{AppError, AppResult};
use crate::state::{Connection, Dirs, St, Win};
use crate::transactions::{commit, record_commit, status, TxStatus};

/// Snapshots kept per router; older ones are deleted.
const KEEP_SNAPSHOTS: usize = 30;
const CMDS_EXT: &str = ".commands.txt";
const BOOT_EXT: &str = ".config.boot";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Unix seconds; also the file name stem.
    id: u64,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    /// When the snapshot we compared against was taken (unix seconds).
    since: u64,
    added: Vec<String>,
    removed: Vec<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    mount: String,
    used_percent: u32,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    uptime_secs: Option<u64>,
    load: Vec<f64>,
    cpus: Option<u32>,
    mem_total_kb: Option<u64>,
    mem_available_kb: Option<u64>,
    disks: Vec<Disk>,
    /// Error-level journal lines from the last 24 h (newest last).
    errors: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkup {
    /// Whether a new snapshot was written (false = config unchanged since the last one).
    backup_saved: bool,
    backup_dir: String,
    snapshot_count: usize,
    /// None on the first connect to this router.
    changes: Option<Changes>,
    /// Running config differs from the boot config (None = couldn't tell).
    unsaved: Option<bool>,
    health: Health,
    /// Parts of the check that failed, for display.
    problems: Vec<String>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn router_dir(dirs: &Dirs, profile_id: &str) -> AppResult<PathBuf> {
    let safe: String = profile_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let dir = dirs.data.join("backups").join(safe);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Snapshot ids in `dir`, oldest first.
fn snapshot_ids(dir: &Path) -> AppResult<Vec<u64>> {
    let mut ids: Vec<u64> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.strip_suffix(CMDS_EXT)
                .and_then(|stem| stem.parse().ok())
        })
        .collect();
    ids.sort_unstable();
    Ok(ids)
}

/// Writes a file readable only by the current user (configs contain secrets).
fn write_private(path: &Path, contents: &str) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(contents.as_bytes())?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, contents)?;
        Ok(())
    }
}

fn command_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| l.starts_with("set ") || l.starts_with("delete "))
        .map(str::to_string)
        .collect()
}

/// `set` commands are independent lines, so a set difference is an exact diff.
fn diff_commands(old: &str, new: &str) -> (Vec<String>, Vec<String>) {
    let old_lines = command_lines(old);
    let new_lines = command_lines(new);
    let old_set: HashSet<&String> = old_lines.iter().collect();
    let new_set: HashSet<&String> = new_lines.iter().collect();
    let added = new_lines
        .iter()
        .filter(|l| !old_set.contains(l))
        .cloned()
        .collect();
    let removed = old_lines
        .iter()
        .filter(|l| !new_set.contains(l))
        .cloned()
        .collect();
    (added, removed)
}

/// config.boot text without comments/blank lines, for comparing two renderings.
fn normalize_boot(text: &str) -> Vec<&str> {
    let mut in_comment = false;
    text.lines()
        .map(str::trim_end)
        .filter(|l| {
            let t = l.trim_start();
            if in_comment {
                in_comment = !t.contains("*/");
                return false;
            }
            if t.starts_with("/*") {
                in_comment = !t.contains("*/");
                return false;
            }
            !t.is_empty() && !t.starts_with("//")
        })
        .collect()
}

const HEALTH_SCRIPT: &str = "cat /proc/uptime; echo @@; cat /proc/loadavg; echo @@; nproc; echo @@; \
     grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; echo @@; df -P / /config 2>/dev/null; echo @@; \
     sudo -n journalctl -p err -n 15 --since -24h -o short-iso --no-pager -q 2>/dev/null";

fn parse_health(out: &str) -> Health {
    let parts: Vec<&str> = out.split("@@").map(str::trim).collect();
    let part = |i: usize| parts.get(i).copied().unwrap_or("");
    let mut h = Health {
        uptime_secs: part(0)
            .split_whitespace()
            .next()
            .and_then(|v| v.parse::<f64>().ok())
            .map(|v| v as u64),
        load: part(1)
            .split_whitespace()
            .take(3)
            .filter_map(|v| v.parse().ok())
            .collect(),
        cpus: part(2).parse().ok(),
        ..Default::default()
    };
    for line in part(3).lines() {
        let mut it = line.split_whitespace();
        let (key, val) = (it.next(), it.next().and_then(|v| v.parse().ok()));
        match key {
            Some("MemTotal:") => h.mem_total_kb = val,
            Some("MemAvailable:") => h.mem_available_kb = val,
            _ => {}
        }
    }
    let mut seen = HashSet::new();
    for line in part(4).lines().skip(1) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() >= 6 && seen.insert(cols[0].to_string()) {
            if let Ok(p) = cols[4].trim_end_matches('%').parse() {
                h.disks.push(Disk {
                    mount: cols[5].to_string(),
                    used_percent: p,
                });
            }
        }
    }
    h.errors = part(5)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect();
    h
}

async fn take_snapshot(
    dirs: &Dirs,
    conn: &Connection,
    problems: &mut Vec<String>,
) -> AppResult<(bool, PathBuf, usize, Option<Changes>, Option<String>)> {
    let dir = router_dir(dirs, &conn.profile_id)?;
    let commands = conn.api.show(&path(&["configuration", "commands"])).await?;
    if command_lines(&commands).is_empty() {
        return Err(AppError::Api(
            "router returned no configuration commands".into(),
        ));
    }
    let boot = match running_boot(conn).await {
        Ok(b) => Some(b),
        Err(e) => {
            problems.push(format!("config.boot backup: {e}"));
            None
        }
    };

    let ids = snapshot_ids(&dir)?;
    let mut changes = None;
    let mut saved = true;
    if let Some(&last) = ids.last() {
        let prev =
            std::fs::read_to_string(dir.join(format!("{last}{CMDS_EXT}"))).unwrap_or_default();
        let (added, removed) = diff_commands(&prev, &commands);
        saved = !added.is_empty() || !removed.is_empty();
        changes = Some(Changes {
            since: last,
            added,
            removed,
        });
    }
    if saved {
        // Never overwrite: bump the id if two snapshots land in the same second.
        let mut id = now_secs();
        while ids.contains(&id) {
            id += 1;
        }
        write_private(&dir.join(format!("{id}{CMDS_EXT}")), &commands)?;
        if let Some(b) = &boot {
            write_private(&dir.join(format!("{id}{BOOT_EXT}")), b)?;
        }
        let mut all = snapshot_ids(&dir)?;
        while all.len() > KEEP_SNAPSHOTS {
            let old = all.remove(0);
            let _ = std::fs::remove_file(dir.join(format!("{old}{CMDS_EXT}")));
            let _ = std::fs::remove_file(dir.join(format!("{old}{BOOT_EXT}")));
        }
    }
    let count = snapshot_ids(&dir)?.len();
    Ok((saved, dir, count, changes, boot))
}

const ACCT: &str = "net.netfilter.nf_conntrack_acct";

/// Per-connection traffic counting (Clients' speeds) is a sysctl. VyOS can
/// lose the live value after a restart while the config still says 1, so
/// this applies the configured value when they differ. Returns whether it
/// had to (true) or not (false).
pub async fn sync_accounting(conn: &Connection) -> AppResult<bool> {
    let want = conn
        .api
        .return_value(&path(&["system", "sysctl", "parameter", ACCT, "value"]))
        .await
        .ok()
        .flatten();
    if want.as_deref() != Some("1") {
        return Ok(false);
    }
    let live = conn
        .ssh
        .exec_ok(&format!("/usr/sbin/sysctl -n {ACCT}"))
        .await?;
    if live.trim() == "1" {
        return Ok(false);
    }
    conn.ssh
        .exec_ok(&format!("sudo -n /usr/sbin/sysctl -w {ACCT}=1"))
        .await?;
    Ok(true)
}

/// Applies traffic counting now (after the config was set).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn accounting_sync(state: Win) -> AppResult<bool> {
    sync_accounting(&*state.conn().await?).await
}

/// The address the router sees VyGi connecting from (SSH and the API use the
/// same route), so a lock-down of the API can keep VyGi in.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn client_address(state: Win) -> AppResult<String> {
    let out = state.conn().await?.ssh.exec_ok("echo $SSH_CLIENT").await?;
    Ok(out
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string())
}

/// Saves a backup snapshot when the config changed since the last one (24/7 watching).
/// Returns whether a new snapshot was written.
pub async fn backup_if_changed(dirs: &Dirs, conn: &Connection) -> AppResult<bool> {
    let mut problems = Vec::new();
    Ok(take_snapshot(dirs, conn, &mut problems).await?.0)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn connect_checkup(app: St, state: Win) -> AppResult<Checkup> {
    let conn = state.conn().await?;
    let mut problems = Vec::new();

    let (backup_saved, dir, snapshot_count, changes, boot) =
        take_snapshot(&app.dirs, &conn, &mut problems).await?;

    // Unsaved = running config differs from what the router boots with.
    let unsaved = match (
        &boot,
        conn.ssh.exec_ok("sudo -n cat /config/config.boot").await,
    ) {
        (Some(running), Ok(saved)) => Some(normalize_boot(running) != normalize_boot(&saved)),
        (_, Err(e)) => {
            problems.push(format!("could not read the saved config: {e}"));
            None
        }
        (None, _) => None,
    };
    if let Some(u) = unsaved {
        state.tx.lock().await.unsaved = u;
    }

    if let Err(e) = sync_accounting(&conn).await {
        problems.push(format!("traffic counting: {e}"));
    }

    let health = match conn.ssh.exec(HEALTH_SCRIPT, Duration::from_secs(20)).await {
        Ok(out) => parse_health(&out.stdout),
        Err(e) => {
            problems.push(format!("health check: {e}"));
            Health::default()
        }
    };

    Ok(Checkup {
        backup_saved,
        backup_dir: dir.to_string_lossy().into_owned(),
        snapshot_count,
        changes,
        unsaved,
        health,
        problems,
    })
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn history_list(app: St, state: Win) -> AppResult<Vec<Snapshot>> {
    let conn = state.conn().await?;
    let dir = router_dir(&app.dirs, &conn.profile_id)?;
    let mut out: Vec<Snapshot> = snapshot_ids(&dir)?
        .into_iter()
        .map(|id| Snapshot {
            id,
            bytes: std::fs::metadata(dir.join(format!("{id}{CMDS_EXT}")))
                .map(|m| m.len())
                .unwrap_or(0),
        })
        .collect();
    out.reverse(); // newest first
    Ok(out)
}

/// What changed between snapshot `id` and the one before it.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn history_diff(app: St, state: Win, id: u64) -> AppResult<Changes> {
    let conn = state.conn().await?;
    let dir = router_dir(&app.dirs, &conn.profile_id)?;
    let ids = snapshot_ids(&dir)?;
    let pos = ids
        .iter()
        .position(|&i| i == id)
        .ok_or_else(|| AppError::Invalid(format!("no snapshot {id}")))?;
    let new = std::fs::read_to_string(dir.join(format!("{id}{CMDS_EXT}")))?;
    let (prev_id, old) = match pos.checked_sub(1).map(|p| ids[p]) {
        Some(p) => (
            p,
            std::fs::read_to_string(dir.join(format!("{p}{CMDS_EXT}")))?,
        ),
        None => (0, String::new()),
    };
    let (added, removed) = diff_commands(&old, &new);
    Ok(Changes {
        since: prev_id,
        added,
        removed,
    })
}

/// Loads snapshot `id` (config.boot) as the running config.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn history_restore(
    app: St,
    state: Win,
    id: u64,
    confirm_minutes: u32,
) -> AppResult<TxStatus> {
    let conn = state.conn().await?;
    let file = router_dir(&app.dirs, &conn.profile_id)?.join(format!("{id}{BOOT_EXT}"));
    let text = std::fs::read_to_string(&file).map_err(|_| {
        AppError::Invalid("this snapshot has no config.boot copy to restore".into())
    })?;
    let minutes = confirm_minutes.min(60);
    let msg = commit(&state, &conn, || {
        Box::pin(conn.api.load_config_text(&text, minutes))
    })
    .await?;
    record_commit(&state, minutes).await;
    Ok(status(&state, msg).await)
}

/// The running settings against the newest backup (24/7 watching, after a
/// restart): (backup id, added, removed), or None when they match or there's
/// no backup yet.
pub async fn compare_with_backup(
    dirs: &Dirs,
    conn: &Connection,
) -> AppResult<Option<(u64, Vec<String>, Vec<String>)>> {
    let dir = router_dir(dirs, &conn.profile_id)?;
    let Some(&last) = snapshot_ids(&dir)?.last() else {
        return Ok(None);
    };
    let prev = std::fs::read_to_string(dir.join(format!("{last}{CMDS_EXT}")))?;
    let now = conn.api.show(&path(&["configuration", "commands"])).await?;
    let (added, removed) = diff_commands(&prev, &now);
    Ok((!added.is_empty() || !removed.is_empty()).then_some((last, added, removed)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedBackup {
    id: u64,
    /// number of settings (command lines): a backup of a wiped router is much smaller
    lines: usize,
    /// has a config.boot copy, so it can be restored
    restorable: bool,
}

/// A saved router's backups, newest first (no connection needed).
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn router_backups(app: St, id: String) -> AppResult<Vec<SavedBackup>> {
    let dir = router_dir(&app.dirs, &app.profiles.find(&id)?.id())?;
    let mut out: Vec<SavedBackup> = snapshot_ids(&dir)?
        .into_iter()
        .map(|i| SavedBackup {
            id: i,
            lines: command_lines(
                &std::fs::read_to_string(dir.join(format!("{i}{CMDS_EXT}"))).unwrap_or_default(),
            )
            .len(),
            restorable: dir.join(format!("{i}{BOOT_EXT}")).exists(),
        })
        .collect();
    out.reverse();
    Ok(out)
}

/// Puts a backup back on a router whose API doesn't answer, over SSH:
/// copies its config.boot over, loads it, commits and saves.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn restore_over_ssh(
    app: St,
    id: String,
    snapshot: u64,
    trust_ssh: Option<String>,
) -> AppResult<()> {
    let profile = app.profiles.find(&id)?;
    let secrets = crate::security::load_secrets(&app.profiles.dir(), &profile)?
        .ok_or_else(|| AppError::Invalid("the router's password isn't saved".into()))?;
    let text = std::fs::read_to_string(
        router_dir(&app.dirs, &profile.id())?.join(format!("{snapshot}{BOOT_EXT}")),
    )
    .map_err(|_| AppError::Invalid("this backup has no config.boot copy to restore".into()))?;
    let ssh = crate::ssh::SshClient::connect(
        &profile.host,
        profile.ssh_port,
        &profile.ssh_user,
        &secrets.ssh_password,
        trust_ssh.or(profile.ssh_fingerprint.clone()),
    )
    .await?;
    const FILE: &str = "/tmp/vygi-restore.boot";
    let b64 = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(text.as_bytes())
    };
    ssh.exec_ok(&format!(": > {FILE}.b64")).await?;
    // one command line holds at most 128 KB
    for chunk in b64.as_bytes().chunks(60_000) {
        let chunk = std::str::from_utf8(chunk).unwrap_or_default();
        ssh.exec_ok(&format!("printf %s {chunk} >> {FILE}.b64"))
            .await?;
    }
    ssh.exec_ok(&format!(
        "base64 -d {FILE}.b64 > {FILE} && rm -f {FILE}.b64"
    ))
    .await?;
    let out = ssh
        .exec(
            &format!(
                "/bin/vbash -c 'source /opt/vyatta/etc/functions/script-template\n\
                 configure\n\
                 load {FILE}\n\
                 commit\n\
                 save\n\
                 exit'; rm -f {FILE}"
            ),
            Duration::from_secs(300),
        )
        .await?;
    let all = format!("{}\n{}", out.stdout, out.stderr);
    if all.contains("Commit failed") || all.contains("Load failed") {
        let detail: Vec<&str> = all
            .lines()
            .filter(|l| {
                let l = l.trim();
                !l.is_empty()
                    && !l.contains("locale")
                    && !l.starts_with("perl:")
                    && !l.contains("unable to resolve")
            })
            .collect();
        return Err(AppError::Api(format!(
            "the router didn't take the backup: {}",
            detail.join(" ").chars().take(400).collect::<String>()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_is_exact() {
        let old = "set a 1\nset b 2\nset c 3\n";
        let new = "set a 1\nset c 4\nset d 5\n";
        let (added, removed) = diff_commands(old, new);
        assert_eq!(added, vec!["set c 4", "set d 5"]);
        assert_eq!(removed, vec!["set b 2", "set c 3"]);
    }

    #[test]
    fn boot_normalization_ignores_comments() {
        let a = "interfaces {\n    ethernet eth0 {\n    }\n}\n// vyos-config-version: \"x@1\"\n";
        let b = "/* Warning: Do not remove */\ninterfaces {\n    ethernet eth0 {\n    }\n}\n\n";
        assert_eq!(normalize_boot(a), normalize_boot(b));
        assert_ne!(normalize_boot(a), normalize_boot("interfaces {\n}\n"));
    }

    #[test]
    fn health_parsing() {
        let out = "12345.67 9999.0\n@@\n0.10 0.20 0.30 1/100 42\n@@\n4\n@@\nMemTotal: 2000000 kB\nMemAvailable: 1500000 kB\n@@\n\
                   Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 91 9 91% /\n/dev/sda1 100 91 9 91% /\n@@\n\
                   2026-10-23T10:00:00+0000 gw01 kernel: eth2: link down\n";
        let h = parse_health(out);
        assert_eq!(h.uptime_secs, Some(12345));
        assert_eq!(h.load, vec![0.1, 0.2, 0.3]);
        assert_eq!(h.cpus, Some(4));
        assert_eq!(h.mem_available_kb, Some(1_500_000));
        assert_eq!(h.disks.len(), 1);
        assert_eq!(h.disks[0].used_percent, 91);
        assert_eq!(h.errors.len(), 1);
    }
}
