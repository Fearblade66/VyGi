//! Intrusion detection: Suricata in a container on the router (VyOS has no
//! IDS of its own). VyGi sets up the container config through the API (the
//! UI builds the commands); this module does what needs SSH: folders, the
//! image, rule updates, and reading alerts from Suricata's `fast.log`
//! (alerts only, one line each), rotating its logs so the disk can't fill.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::error::AppResult;
use crate::state::{Connection, Win};

/// Pinned image (Suricata's official container build by its maintainer).
pub const IMAGE: &str = "docker.io/jasonish/suricata:8.0.6";
pub const NAME: &str = "vygi-ids";
const DIR: &str = "/config/vygi-ids";
const FAST: &str = "/config/vygi-ids/log/fast.log";
/// Logs bigger than this are moved aside (one old copy kept).
const ROTATE_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IdsAlert {
    /// unix ms (Suricata in the container logs UTC)
    pub t: u64,
    pub sid: String,
    pub msg: String,
    pub class: String,
    /// 1 = most serious .. 4
    pub priority: u8,
    pub proto: String,
    pub src: String,
    pub sport: u16,
    pub dst: String,
    pub dport: u16,
    /// dropped by Suricata (inline mode); VyGi runs it as detection only
    pub dropped: bool,
}

/// One `fast.log` line:
/// `10/26/2026-21:03:07.123456  [**] [1:2010935:3] ET SCAN ... [**] [Classification: ...] [Priority: 2] {TCP} 1.2.3.4:51234 -> 203.0.113.5:1433`
pub fn parse_fast(line: &str) -> Option<IdsAlert> {
    let (stamp, rest) = line.trim().split_once(char::is_whitespace)?;
    let t = parse_stamp(stamp)?;
    let dropped = rest.contains("[Drop]");
    let after = rest.split_once("[**]")?.1;
    let (head, tail) = after.split_once("[**]")?;
    let head = head.trim();
    let (gid_sid, msg) = head.strip_prefix('[')?.split_once(']')?;
    let sid = gid_sid.split(':').nth(1).unwrap_or(gid_sid).to_string();
    let field = |k: &str| {
        tail.split_once(&format!("[{k}: "))
            .and_then(|(_, v)| v.split_once(']'))
            .map(|(v, _)| v.trim().to_string())
    };
    let (proto_part, ends) = tail.split_once('{')?.1.split_once('}')?;
    let (from, to) = ends.trim().split_once(" -> ")?;
    let addr = |s: &str| -> (String, u16) {
        let s = s.trim();
        match s.rsplit_once(':') {
            Some((a, p)) if p.chars().all(|c| c.is_ascii_digit()) => (
                a.trim_matches(['[', ']']).to_string(),
                p.parse().unwrap_or(0),
            ),
            _ => (s.to_string(), 0),
        }
    };
    let (src, sport) = addr(from);
    let (dst, dport) = addr(to);
    Some(IdsAlert {
        t,
        sid,
        msg: msg.trim().to_string(),
        class: field("Classification").unwrap_or_default(),
        priority: field("Priority").and_then(|p| p.parse().ok()).unwrap_or(3),
        proto: proto_part.to_lowercase(),
        src,
        sport,
        dst,
        dport,
        dropped,
    })
}

/// "10/26/2026-21:03:07.123456" (UTC) -> unix ms.
fn parse_stamp(s: &str) -> Option<u64> {
    let (date, time) = s.split_once('-')?;
    let mut d = date.split('/');
    let (mo, da, yr): (i64, i64, i64) = (
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
    );
    let mut tm = time.split(':');
    let (h, mi): (i64, i64) = (tm.next()?.parse().ok()?, tm.next()?.parse().ok()?);
    let sec: f64 = tm.next()?.parse().ok()?;
    // days from civil (Howard Hinnant)
    let y = if mo <= 2 { yr - 1 } else { yr };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let ms = ((days * 86_400 + h * 3600 + mi * 60) as f64 + sec) * 1000.0;
    (ms >= 0.0).then_some(ms as u64)
}

pub fn parse_fast_text(text: &str) -> Vec<IdsAlert> {
    text.lines().filter_map(parse_fast).collect()
}

/// Shell snippet: move a log aside when it's too big and tell Suricata to reopen its logs.
fn rotate_snippet() -> String {
    format!(
        "for f in {DIR}/log/fast.log {DIR}/log/eve.json {DIR}/log/suricata.log; do s=$(sudo stat -c %s $f 2>/dev/null || echo 0); if [ $s -gt {ROTATE_BYTES} ]; then sudo mv -f $f $f.old; r=1; fi; done; [ -n \"$r\" ] && sudo podman kill --signal HUP {NAME} >/dev/null 2>&1; true"
    )
}

/// Folders and the image, before the container config is committed. Slow the
/// first time (the image is a few hundred MB).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn ids_prepare(state: Win) -> AppResult<String> {
    let conn = state.conn().await?;
    let cmd = format!(
        "sudo mkdir -p {DIR}/log {DIR}/lib && (sudo podman image exists {IMAGE} || sudo podman pull -q {IMAGE}) >/dev/null 2>&1 && echo ready || echo failed"
    );
    let out = conn.ssh.exec(&cmd, Duration::from_secs(900)).await?;
    if out.stdout.trim().ends_with("ready") {
        Ok("ready".into())
    } else {
        Err(crate::error::AppError::Api(format!(
            "The router couldn't download Suricata ({IMAGE}). It needs internet access and about 1 GB of free disk space.{}",
            if out.stderr.trim().is_empty() { String::new() } else { format!(" ({})", out.stderr.trim()) }
        )))
    }
}

/// { running, status, image, rules, logBytes }
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn ids_status(state: Win) -> AppResult<Value> {
    let conn = state.conn().await?;
    let cmd = format!(
        "echo \"status:$(sudo podman ps --filter name=^{NAME}$ --format '{{{{.Status}}}}' 2>/dev/null)\"; \
         sudo podman image exists {IMAGE} && echo image:yes || echo image:no; \
         echo \"rules:$(sudo grep -c '^alert' {DIR}/lib/rules/suricata.rules 2>/dev/null || echo 0)\"; \
         echo \"rulesAt:$(sudo stat -c %Y {DIR}/lib/rules/suricata.rules 2>/dev/null || echo 0)\"; \
         echo \"log:$(sudo stat -c %s {FAST} 2>/dev/null || echo 0)\""
    );
    let out = conn.ssh.exec_ok(&cmd).await?;
    let get = |k: &str| {
        out.lines()
            .find_map(|l| l.strip_prefix(&format!("{k}:")))
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let status = get("status");
    Ok(json!({
        "running": status.starts_with("Up"),
        "status": status,
        "image": get("image") == "yes",
        "rules": get("rules").parse::<u64>().unwrap_or(0),
        "rulesAt": get("rulesAt").parse::<u64>().unwrap_or(0) * 1000,
        "logBytes": get("log").parse::<u64>().unwrap_or(0),
    }))
}

/// Downloads the current free ruleset (Emerging Threats Open) and restarts Suricata with it.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn ids_update_rules(state: Win) -> AppResult<String> {
    let conn = state.conn().await?;
    let cmd = format!("sudo podman exec {NAME} suricata-update --no-test -q 2>&1 | tail -3; sudo podman restart {NAME} >/dev/null 2>&1 && echo restarted");
    let out = conn.ssh.exec(&cmd, Duration::from_secs(600)).await?;
    if out.stdout.contains("restarted") {
        Ok(out.stdout.replace("restarted", "").trim().to_string())
    } else {
        Err(crate::error::AppError::Api(format!(
            "Couldn't update the rules: {}",
            [out.stdout.trim(), out.stderr.trim()].join(" ").trim()
        )))
    }
}

/// The newest alerts (up to `limit`), newest first. Also rotates big logs.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn ids_alerts(state: Win, limit: u32) -> AppResult<Vec<IdsAlert>> {
    let conn = state.conn().await?;
    let n = limit.clamp(1, 5000);
    let cmd = format!(
        "{}; sudo tail -n {n} {FAST} 2>/dev/null; true",
        rotate_snippet()
    );
    let out = conn.ssh.exec_ok(&cmd).await?;
    let mut list = parse_fast_text(&out);
    list.reverse();
    Ok(list)
}

/// For the 24/7 watcher: alerts written since byte `offset` of fast.log, and
/// the new offset (0 again after a rotation). Ok(None) when IDS isn't set up.
pub async fn new_alerts(conn: &Connection, offset: u64) -> AppResult<Option<(Vec<IdsAlert>, u64)>> {
    let cmd = format!(
        "[ -d {DIR}/log ] || {{ echo none; exit 0; }}; {}; s=$(sudo stat -c %s {FAST} 2>/dev/null || echo 0); echo \"size:$s\"; \
         if [ $s -gt {offset} ]; then sudo tail -c +$(({offset}+1)) {FAST} | head -c 2000000; fi",
        rotate_snippet()
    );
    let out = conn.ssh.exec_ok(&cmd).await?;
    if out.trim() == "none" {
        return Ok(None);
    }
    let size: u64 = out
        .lines()
        .find_map(|l| l.strip_prefix("size:"))
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    // smaller than before: the log was rotated; start from the top next time
    if size < offset {
        return Ok(Some((Vec::new(), 0)));
    }
    Ok(Some((parse_fast_text(&out), size)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_log_lines() {
        let a = parse_fast("10/26/2026-21:03:07.123456  [**] [1:2010935:3] ET SCAN Suspicious inbound to MSSQL port 1433 [**] [Classification: Potentially Bad Traffic] [Priority: 2] {TCP} 45.33.12.9:51234 -> 203.0.113.5:1433").unwrap();
        assert_eq!(a.sid, "2010935");
        assert_eq!(a.msg, "ET SCAN Suspicious inbound to MSSQL port 1433");
        assert_eq!(
            (a.class.as_str(), a.priority, a.proto.as_str()),
            ("Potentially Bad Traffic", 2, "tcp")
        );
        assert_eq!(
            (a.src.as_str(), a.sport, a.dst.as_str(), a.dport),
            ("45.33.12.9", 51234, "203.0.113.5", 1433)
        );
        assert_eq!(a.t, 1_793_048_587_123);
        let d = parse_fast("10/26/2026-21:03:08.000001  [Drop] [**] [1:2400001:1] ET DROP Spamhaus DROP Listed Traffic [**] [Classification: Misc Attack] [Priority: 1] {ICMP} 1.2.3.4:8 -> 10.0.0.1:0").unwrap();
        assert!(d.dropped && d.priority == 1 && d.proto == "icmp");
        let v6 = parse_fast("01/02/2026-00:00:00.000000  [**] [1:1:1] test [**] [Priority: 3] {UDP} 2001:0db8:0000:0000:0000:0000:0000:0001:546 -> ff02:0000:0000:0000:0000:0000:0001:0002:547").unwrap();
        assert_eq!(
            (v6.src.as_str(), v6.sport, v6.dport),
            ("2001:0db8:0000:0000:0000:0000:0000:0001", 546, 547)
        );
        assert!(parse_fast("garbage").is_none());
        assert_eq!(
            parse_fast_text(
                "x\n10/26/2026-21:03:07.1  [**] [1:1:1] a [**] {TCP} 1.1.1.1:1 -> 2.2.2.2:2\n"
            )
            .len(),
            1
        );
    }
}
