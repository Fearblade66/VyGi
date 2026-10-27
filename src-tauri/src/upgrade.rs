//! VyOS updates with an automatic way back. Before restarting into a new
//! image, VyGi leaves a note on the router (/config/vygi-rollback: the old
//! and new image) and a boot script. When the router starts the new image,
//! the script waits; if VyGi hasn't confirmed by then (it does as soon as it
//! reaches the router again), the router makes the old image the default and
//! restarts into it. /config is shared by all installed images, so the note
//! and the script survive the update.

use std::time::Duration;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::ssh::SshClient;
use crate::state::Win;

const NOTE: &str = "/config/vygi-rollback";
/// the image before the last confirmed update, for "Go back" later
const PREVIOUS: &str = "/config/vygi-previous-image";
const SCRIPT: &str = "/config/vygi-rollback.sh";
const HOOK: &str = "/config/scripts/vyos-postconfig-bootup.script";
const HOOK_LINE: &str = "[ -x /config/vygi-rollback.sh ] && /config/vygi-rollback.sh & # VyGi: go back to the old VyOS if an update isn't confirmed";

/// Runs at boot (from vyos-postconfig-bootup.script, as root).
const BOOT_SCRIPT: &str = r#"#!/bin/sh
# VyGi: after a VyOS update, go back to the old image unless VyGi confirms
# the new one works (it deletes /config/vygi-rollback when it reaches the router).
NOTE=/config/vygi-rollback
[ -f "$NOTE" ] || exit 0
. "$NOTE"
IMAGE_MANAGER=${IMAGE_MANAGER:-/usr/libexec/vyos/op_mode/image_manager.py}
REBOOT=${REBOOT:-/sbin/reboot}
running=$(python3 -c 'from vyos.system import image; print(image.get_running_image())' 2>/dev/null)
# only the first boot of the new image waits; anything else: the note is stale
if [ "$running" != "$NEW" ]; then rm -f "$NOTE"; exit 0; fi
sleep "${SECONDS_TO_WAIT:-600}"
[ -f "$NOTE" ] || exit 0
rm -f "$NOTE"
logger -t vygi "VyOS $NEW wasn't confirmed by VyGi in time: going back to $OLD"
"$IMAGE_MANAGER" --action set --image-name "$OLD" && "$REBOOT"
"#;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GuardStatus {
    /// an update is waiting for confirmation
    pub pending: bool,
    pub old: String,
    pub new: String,
    pub running: String,
    /// the image before the last update (kept after it's confirmed)
    pub previous: String,
}

fn valid_image(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-+".contains(c))
}

const IMAGES: &str = "python3 -c 'from vyos.system import image; print(image.get_running_image()); print(image.get_default_image())' 2>/dev/null";

async fn images(ssh: &SshClient) -> AppResult<(String, String)> {
    let out = ssh.exec_ok(IMAGES).await?;
    let mut lines = out.lines().map(str::trim);
    let running = lines.next().unwrap_or("").to_string();
    let default = lines.next().unwrap_or("").to_string();
    Ok((running, default))
}

fn parse_note(text: &str) -> (String, String) {
    let field = |k: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(&format!("{k}=")))
            .map(|v| v.trim().trim_matches('\'').to_string())
            .unwrap_or_default()
    };
    (field("OLD"), field("NEW"))
}

pub async fn status(ssh: &SshClient) -> AppResult<GuardStatus> {
    let note = ssh
        .exec_ok(&format!("sudo cat {NOTE} 2>/dev/null; true"))
        .await?;
    let previous = ssh
        .exec_ok(&format!("sudo cat {PREVIOUS} 2>/dev/null; true"))
        .await?
        .trim()
        .to_string();
    let (running, _) = images(ssh).await?;
    let (old, new) = parse_note(&note);
    Ok(GuardStatus {
        pending: !new.is_empty(),
        old,
        new,
        running,
        previous: if valid_image(&previous) {
            previous
        } else {
            String::new()
        },
    })
}

/// After installing an image (now the default): arm the way back to the running one.
pub async fn arm(ssh: &SshClient, seconds: u32) -> AppResult<GuardStatus> {
    let (running, default) = images(ssh).await?;
    if !valid_image(&running) || !valid_image(&default) {
        return Err(AppError::Invalid(
            "couldn't tell which VyOS images are installed".into(),
        ));
    }
    if running == default {
        return Err(AppError::Invalid(
            "the new image isn't the default boot image, so there's nothing to come back from"
                .into(),
        ));
    }
    let script = BOOT_SCRIPT.replace(
        "${SECONDS_TO_WAIT:-600}",
        &format!("${{SECONDS_TO_WAIT:-{seconds}}}"),
    );
    let note = format!("OLD='{running}'\nNEW='{default}'\n");
    let cmd = format!(
        "printf %s {s} | sudo tee {SCRIPT} >/dev/null && sudo chmod 755 {SCRIPT} && \
         printf %s {n} | sudo tee {NOTE} >/dev/null && \
         (sudo grep -qF 'vygi-rollback.sh' {HOOK} 2>/dev/null || echo {h} | sudo tee -a {HOOK} >/dev/null) && \
         sudo chmod 755 {HOOK} && echo armed",
        s = crate::ssh::shell_quote(&script),
        n = crate::ssh::shell_quote(&note),
        h = crate::ssh::shell_quote(HOOK_LINE),
    );
    let out = ssh.exec(&cmd, Duration::from_secs(30)).await?;
    if !out.stdout.contains("armed") {
        return Err(AppError::Invalid(format!(
            "couldn't set up the way back: {}",
            out.stderr.trim()
        )));
    }
    Ok(GuardStatus {
        pending: true,
        old: running,
        new: default,
        running: String::new(),
        previous: String::new(),
    })
}

/// VyGi reached the router running the new image: keep it.
pub async fn confirm_if_pending(ssh: &SshClient) -> AppResult<Option<String>> {
    let st = status(ssh).await?;
    if st.pending && st.running == st.new {
        ssh.exec_ok(&format!(
            "printf %s {o} | sudo tee {PREVIOUS} >/dev/null; sudo rm -f {NOTE}",
            o = crate::ssh::shell_quote(&st.old)
        ))
        .await?;
        return Ok(Some(st.new));
    }
    Ok(None)
}

// ---- commands

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn update_guard_arm(state: Win, minutes: Option<u32>) -> AppResult<GuardStatus> {
    let conn = state.conn().await?;
    arm(&conn.ssh, minutes.unwrap_or(10).clamp(3, 60) * 60).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn update_guard_status(state: Win) -> AppResult<GuardStatus> {
    status(&state.conn().await?.ssh).await
}

/// Keep the new image (or, if still waiting to restart, cancel the way back).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn update_guard_confirm(state: Win) -> AppResult<Option<String>> {
    let conn = state.conn().await?;
    confirm_if_pending(&conn.ssh).await
}

/// Go back to the old image now (default boot + restart).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn update_rollback_now(state: Win) -> AppResult<String> {
    let conn = state.conn().await?;
    let st = status(&conn.ssh).await?;
    let old = if st.pending { st.old } else { st.previous };
    if !valid_image(&old) || old == st.running {
        return Err(AppError::Invalid("no update to go back from".into()));
    }
    let cmd = format!(
        "sudo rm -f {NOTE} {PREVIOUS}; sudo /usr/libexec/vyos/op_mode/image_manager.py --action set --image-name {o} && (sleep 2; sudo /sbin/reboot) >/dev/null 2>&1 & echo ok",
        o = crate::ssh::shell_quote(&old)
    );
    conn.ssh.exec(&cmd, Duration::from_secs(60)).await?;
    Ok(old)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_round_trip() {
        let (o, n) = parse_note("OLD='2026.10.01-0021-rolling'\nNEW='2026.10.26-0027-rolling'\n");
        assert_eq!(o, "2026.10.01-0021-rolling");
        assert_eq!(n, "2026.10.26-0027-rolling");
        assert_eq!(parse_note(""), (String::new(), String::new()));
        assert!(valid_image("2026.10.26-0027-rolling"));
        assert!(!valid_image("a'; rm -rf /"));
        assert!(BOOT_SCRIPT.contains("${SECONDS_TO_WAIT:-600}"));
    }
}
