//! What the server records about a watched router, as plain files in
//! `<data>/history/<router>/`, one file per kind and day (UTC):
//!
//! - `alerts.jsonl`: alerts (kept to the last few thousand)
//! - `wan-YYYY-MM-DD.jsonl`: internet traffic per minute `{t, down, up}` (bits/s)
//! - `devices-YYYY-MM-DD.json`: data used per device that day
//! - `log-YYYY-MM-DD.jsonl`: the router's system log
//! - `state.json`: what the alert checks remember between runs

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::alerts::{Alert, State};

const DAY_MS: u64 = 86_400_000;
const ALERTS_KEEP: usize = 2000;

/// "2026-10-25" for a unix time in ms (UTC).
pub fn day(ms: u64) -> String {
    // days since 1970-01-01 -> civil date (Howard Hinnant's algorithm)
    let z = (ms / DAY_MS) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceTotal {
    pub ip: String,
    pub name: String,
    pub down: u64,
    pub up: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LogLine {
    /// unix ms
    pub t: u64,
    /// syslog priority (0 emergency .. 7 debug)
    pub p: u8,
    /// program
    pub id: String,
    /// message
    pub m: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Saved {
    pub alerts: State,
    /// journalctl cursor, to continue the log where it stopped
    pub cursor: Option<String>,
    /// when the watcher last backed up the config / checked for a VyOS update (ms)
    pub last_backup: u64,
    pub last_update_check: u64,
    /// the newest VyOS version already alerted about
    pub update_seen: String,
    /// how far the intrusion detection alert log was read (bytes)
    pub ids_offset: u64,
    /// internet addresses blocked automatically after an attack: (address, until ms)
    pub ids_blocked: Vec<(String, u64)>,
    /// the newest commit already looked at ("YYYY-MM-DD HH:MM:SS", the router's clock)
    pub commit_seen: String,
    /// when the router last started (unix seconds, /proc/stat btime)
    pub boot_seen: String,
}

pub struct Store {
    dir: PathBuf,
}

fn safe(id: &str) -> String {
    let s: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@') {
                c
            } else {
                '_'
            }
        })
        .collect();
    // "." and ".." would point at the history folder itself or its parent
    if s.chars().all(|c| c == '.') {
        "_".repeat(s.len().max(1))
    } else {
        s
    }
}

fn append_lines<T: Serialize>(path: &Path, items: &[T]) {
    if items.is_empty() {
        return;
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let mut buf = String::new();
        for i in items {
            if let Ok(s) = serde_json::to_string(i) {
                buf.push_str(&s);
                buf.push('\n');
            }
        }
        let _ = f.write_all(buf.as_bytes());
    }
}

fn read_lines<T: for<'de> Deserialize<'de>>(path: &Path) -> Vec<T> {
    let Ok(f) = fs::File::open(path) else {
        return Vec::new();
    };
    BufReader::new(f)
        .lines()
        .map_while(Result::ok)
        .filter_map(|l| serde_json::from_str(&l).ok())
        .collect()
}

/// Days (as "YYYY-MM-DD") from `from` to `to` (unix ms), oldest first.
/// How long the daily data-per-device totals are kept (whatever VYGI_KEEP_DAYS says).
const USAGE_KEEP_DAYS: u64 = 400;

fn days(from: u64, to: u64) -> Vec<String> {
    let mut out = Vec::new();
    let mut t = from - from % DAY_MS;
    while t <= to {
        out.push(day(t));
        t += DAY_MS;
    }
    out
}

impl Store {
    pub fn new(base: &Path, router: &str) -> Self {
        let dir = base.join(safe(router));
        let _ = fs::create_dir_all(&dir);
        Store { dir }
    }

    pub fn load(&self) -> Saved {
        fs::read_to_string(self.dir.join("state.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, s: &Saved) {
        if let Ok(t) = serde_json::to_string(s) {
            let tmp = self.dir.join("state.json.tmp");
            if fs::write(&tmp, t).is_ok() {
                let _ = fs::rename(tmp, self.dir.join("state.json"));
            }
        }
    }

    pub fn add_alerts(&self, alerts: &[Alert]) {
        let path = self.dir.join("alerts.jsonl");
        append_lines(&path, alerts);
        // keep the file small: trim when it doubles
        if fs::metadata(&path)
            .map(|m| m.len() > 600_000)
            .unwrap_or(false)
        {
            let all: Vec<Alert> = read_lines(&path);
            let keep = &all[all.len().saturating_sub(ALERTS_KEEP)..];
            let _ = fs::remove_file(&path);
            append_lines(&path, keep);
        }
    }

    /// Alerts after `since` (unix ms), newest first.
    pub fn alerts(&self, since: u64, limit: usize) -> Vec<Alert> {
        let mut all: Vec<Alert> = read_lines(&self.dir.join("alerts.jsonl"));
        all.retain(|a| a.at > since);
        all.reverse();
        all.truncate(limit);
        all
    }

    pub fn add_wan(&self, t: u64, down: f64, up: f64) {
        append_lines(
            &self.dir.join(format!("wan-{}.jsonl", day(t))),
            &[serde_json::json!({ "t": t, "down": down.round(), "up": up.round() })],
        );
    }

    /// Internet traffic from `from` to `to`, averaged down to at most `points`
    /// samples: `[[t, down, up], ...]` (bits/s).
    pub fn wan(&self, from: u64, to: u64, points: usize) -> Vec<[f64; 3]> {
        let mut raw: Vec<[f64; 3]> = Vec::new();
        for d in days(from, to) {
            for v in read_lines::<serde_json::Value>(&self.dir.join(format!("wan-{d}.jsonl"))) {
                let t = v["t"].as_u64().unwrap_or(0);
                if t >= from && t <= to {
                    raw.push([
                        t as f64,
                        v["down"].as_f64().unwrap_or(0.0),
                        v["up"].as_f64().unwrap_or(0.0),
                    ]);
                }
            }
        }
        let points = points.max(1);
        if raw.len() <= points {
            return raw;
        }
        let size = raw.len().div_ceil(points);
        raw.chunks(size)
            .map(|c| {
                let n = c.len() as f64;
                [
                    c[c.len() / 2][0],
                    c.iter().map(|x| x[1]).sum::<f64>() / n,
                    c.iter().map(|x| x[2]).sum::<f64>() / n,
                ]
            })
            .collect()
    }

    /// Adds bytes per device (keyed by MAC, or IP when the MAC is unknown) to today's totals.
    pub fn add_devices(&self, t: u64, bytes: &HashMap<String, DeviceTotal>) {
        if bytes.is_empty() {
            return;
        }
        let path = self.dir.join(format!("devices-{}.json", day(t)));
        let mut totals: HashMap<String, DeviceTotal> = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        for (k, v) in bytes {
            let e = totals.entry(k.clone()).or_default();
            e.down += v.down;
            e.up += v.up;
            if !v.ip.is_empty() {
                e.ip.clone_from(&v.ip);
            }
            if !v.name.is_empty() {
                e.name.clone_from(&v.name);
            }
        }
        if let Ok(s) = serde_json::to_string(&totals) {
            let tmp = path.with_extension("json.tmp");
            if fs::write(&tmp, s).is_ok() {
                let _ = fs::rename(tmp, path);
            }
        }
    }

    /// Data per device over the days from `from` to `to`, biggest first: [(key, totals)].
    pub fn devices(&self, from: u64, to: u64, limit: usize) -> Vec<(String, DeviceTotal)> {
        let mut sum: HashMap<String, DeviceTotal> = HashMap::new();
        for d in days(from, to) {
            let day_totals: HashMap<String, DeviceTotal> =
                fs::read_to_string(self.dir.join(format!("devices-{d}.json")))
                    .ok()
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default();
            for (k, v) in day_totals {
                let e = sum.entry(k).or_default();
                e.down += v.down;
                e.up += v.up;
                if !v.ip.is_empty() {
                    e.ip = v.ip;
                }
                if !v.name.is_empty() {
                    e.name = v.name;
                }
            }
        }
        let mut list: Vec<(String, DeviceTotal)> = sum.into_iter().collect();
        list.sort_by_key(|(_, v)| std::cmp::Reverse(v.down + v.up));
        list.truncate(limit);
        list
    }

    /// Data used each day from `from` to `to`: `[(YYYY-MM-DD, down, up)]`, for
    /// one device (`key`) or all of them, days without a file left out.
    pub fn usage_days(&self, from: u64, to: u64, key: Option<&str>) -> Vec<(String, u64, u64)> {
        let mut out = Vec::new();
        for d in days(from, to) {
            let Ok(text) = fs::read_to_string(self.dir.join(format!("devices-{d}.json"))) else {
                continue;
            };
            let day_totals: HashMap<String, DeviceTotal> =
                serde_json::from_str(&text).unwrap_or_default();
            let (down, up) = day_totals
                .iter()
                .filter(|(k, _)| key.map_or(true, |want| k.as_str() == want))
                .fold((0, 0), |(a, b), (_, v)| (a + v.down, b + v.up));
            out.push((d, down, up));
        }
        out
    }

    pub fn add_logs(&self, lines: &[LogLine]) {
        let mut by_day: HashMap<String, Vec<&LogLine>> = HashMap::new();
        for l in lines {
            by_day.entry(day(l.t)).or_default().push(l);
        }
        for (d, ls) in by_day {
            append_lines(&self.dir.join(format!("log-{d}.jsonl")), &ls);
        }
    }

    /// Log lines from `from` to `to` containing `query` (any case), at
    /// `max_priority` or more important, newest first.
    pub fn logs(
        &self,
        query: &str,
        from: u64,
        to: u64,
        max_priority: u8,
        limit: usize,
    ) -> Vec<LogLine> {
        let q = query.trim().to_lowercase();
        let mut out = Vec::new();
        for d in days(from, to).into_iter().rev() {
            let mut lines: Vec<LogLine> = read_lines(&self.dir.join(format!("log-{d}.jsonl")));
            lines.reverse();
            for l in lines {
                if l.t < from || l.t > to || l.p > max_priority {
                    continue;
                }
                if !q.is_empty()
                    && !l.m.to_lowercase().contains(&q)
                    && !l.id.to_lowercase().contains(&q)
                {
                    continue;
                }
                out.push(l);
                if out.len() >= limit {
                    return out;
                }
            }
        }
        out
    }

    /// Deletes day files older than `keep_days`.
    pub fn cleanup(&self, now: u64, keep_days: u64) {
        let oldest = day(now.saturating_sub(keep_days * DAY_MS));
        // data used per device: a few KB a day, kept a year for the usage page
        let oldest_usage = day(now.saturating_sub(USAGE_KEEP_DAYS.max(keep_days) * DAY_MS));
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            // "<kind>-YYYY-MM-DD.<ext>"
            let date = name
                .split_once('-')
                .map(|(_, rest)| rest.split('.').next().unwrap_or(""));
            if let Some(d) = date {
                let limit = if name.starts_with("devices-") {
                    oldest_usage.as_str()
                } else {
                    oldest.as_str()
                };
                if d.len() == 10 && d < limit {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
    }
}

/// One finished connection (or identical ones that ended in the same minute).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct FlowRec {
    /// last seen (ms)
    pub t: u64,
    /// first seen (ms)
    pub f: u64,
    /// the side that opened it: a local device, or an internet address for a port forward
    pub s: String,
    /// where it went, as the device asked for it (or the device a port forward reached)
    pub d: String,
    /// destination port (0 for ping and the like)
    pub p: u16,
    pub pr: String,
    pub up: u64,
    pub down: u64,
    #[serde(default = "one")]
    pub n: u32,
}

fn one() -> u32 {
    1
}

/// A row of the Flows view: a connection that went through, or one a firewall rule blocked.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowRow {
    pub t: u64,
    pub first: u64,
    pub src: String,
    pub dst: String,
    pub port: u16,
    pub proto: String,
    pub blocked: bool,
    /// the firewall rule that logged a block, e.g. "ipv4-FWD-filter-3"
    pub rule: String,
    pub up: u64,
    pub down: u64,
    pub count: u32,
}

/// A VyOS firewall log line ("[ipv4-FWD-filter-3-D]IN=eth1 OUT=eth3 ... SRC=a DST=b ... PROTO=TCP SPT=1 DPT=443")
/// as a blocked-connection row. Only drops and rejects.
pub fn parse_fw_log(t: u64, msg: &str) -> Option<FlowRow> {
    let open = msg.find('[')?;
    let close = open + msg[open..].find(']')?;
    let tag = &msg[open + 1..close];
    let (rule, verdict) = tag.rsplit_once('-')?;
    if !rule.contains("-filter-") || !matches!(verdict, "D" | "R") {
        return None;
    }
    let field = |k: &str| {
        msg[close..]
            .split_whitespace()
            .find_map(|w| w.strip_prefix(k).and_then(|v| v.strip_prefix('=')))
            .map(str::to_string)
    };
    Some(FlowRow {
        t,
        first: t,
        src: field("SRC")?,
        dst: field("DST")?,
        port: field("DPT").and_then(|p| p.parse().ok()).unwrap_or(0),
        proto: field("PROTO").unwrap_or_default().to_lowercase(),
        blocked: true,
        rule: rule.to_string(),
        up: 0,
        down: 0,
        count: 1,
    })
}

impl Store {
    pub fn add_flows(&self, flows: &[FlowRec]) {
        let mut by_day: HashMap<String, Vec<&FlowRec>> = HashMap::new();
        for f in flows {
            by_day.entry(day(f.t)).or_default().push(f);
        }
        for (d, fs) in by_day {
            append_lines(&self.dir.join(format!("flows-{d}.jsonl")), &fs);
        }
    }

    /// Connections from `from` to `to`, newest first: finished ones (`kind`
    /// "allowed"), blocked attempts from the firewall log ("blocked"), or both.
    /// `query` matches an address, port, protocol or rule.
    pub fn flows(&self, from: u64, to: u64, query: &str, kind: &str, limit: usize) -> Vec<FlowRow> {
        let q = query.trim().to_lowercase();
        let matches = |r: &FlowRow| {
            q.is_empty()
                || [&r.src, &r.dst, &r.proto, &r.rule]
                    .iter()
                    .any(|s| s.to_lowercase().contains(&q))
                || r.port.to_string() == q
        };
        let mut out = Vec::new();
        for d in days(from, to).into_iter().rev() {
            let mut rows = Vec::new();
            if kind != "blocked" {
                let recs: Vec<FlowRec> = read_lines(&self.dir.join(format!("flows-{d}.jsonl")));
                rows.extend(recs.into_iter().map(|f| FlowRow {
                    t: f.t,
                    first: f.f,
                    src: f.s,
                    dst: f.d,
                    port: f.p,
                    proto: f.pr,
                    blocked: false,
                    rule: String::new(),
                    up: f.up,
                    down: f.down,
                    count: f.n,
                }));
            }
            if kind != "allowed" {
                let lines: Vec<LogLine> = read_lines(&self.dir.join(format!("log-{d}.jsonl")));
                // one attempt logs every retry: identical blocks within a minute are one row
                let mut blocked: Vec<FlowRow> = Vec::new();
                for r in lines.iter().filter_map(|l| parse_fw_log(l.t, &l.m)) {
                    match blocked.iter_mut().rev().find(|b| {
                        b.src == r.src
                            && b.dst == r.dst
                            && b.port == r.port
                            && b.proto == r.proto
                            && b.rule == r.rule
                            && r.t.abs_diff(b.first) < 60_000
                    }) {
                        Some(b) => {
                            b.count += 1;
                            b.t = b.t.max(r.t);
                            b.first = b.first.min(r.t);
                        }
                        None => blocked.push(r),
                    }
                }
                rows.extend(blocked);
            }
            rows.retain(|r| r.t >= from && r.t <= to && matches(r));
            rows.sort_by_key(|r| std::cmp::Reverse(r.t));
            for r in rows {
                out.push(r);
                if out.len() >= limit {
                    return out;
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn firewall_log_lines() {
        let r = parse_fw_log(5, "[ipv4-FWD-filter-3-D]IN=eth1 OUT=eth3 MAC=aa SRC=10.20.2.42 DST=93.184.216.34 LEN=60 TOS=0x00 PROTO=TCP SPT=40000 DPT=443 WINDOW=64240").unwrap();
        assert_eq!(
            (
                r.src.as_str(),
                r.dst.as_str(),
                r.port,
                r.proto.as_str(),
                r.rule.as_str(),
                r.blocked
            ),
            (
                "10.20.2.42",
                "93.184.216.34",
                443,
                "tcp",
                "ipv4-FWD-filter-3",
                true
            )
        );
        let ping = parse_fw_log(5, "kernel: [ipv4-INP-filter-9900-D] IN=eth3 SRC=1.2.3.4 DST=203.0.113.5 PROTO=ICMP TYPE=8").unwrap();
        assert_eq!((ping.port, ping.proto.as_str()), (0, "icmp"));
        assert!(
            parse_fw_log(5, "[ipv4-FWD-filter-5-A]IN=eth1 SRC=a DST=b").is_none(),
            "accepts aren't blocks"
        );
        assert!(parse_fw_log(5, "sshd[123]: Accepted password").is_none());
    }

    #[test]
    fn usage_per_day_kept_a_year() {
        let mut b = [0u8; 8];
        getrandom::fill(&mut b).unwrap();
        let dir = std::env::temp_dir().join(format!("vygi-usage-{}", hex::encode(b)));
        let st = Store::new(&dir, "r");
        let now = 1_792_962_427_161;
        let tot = |down, up| DeviceTotal {
            ip: "10.0.0.2".into(),
            name: String::new(),
            down,
            up,
        };
        for (age, a, bb) in [(0u64, 100u64, 10u64), (1, 200, 20), (60, 300, 30)] {
            let mut m = HashMap::new();
            m.insert("aa:aa".to_string(), tot(a, bb));
            m.insert("bb:bb".to_string(), tot(1, 1));
            st.add_devices(now - age * DAY_MS, &m);
        }
        let all = st.usage_days(now - 2 * DAY_MS, now, None);
        assert_eq!(
            all.iter().map(|d| (d.1, d.2)).collect::<Vec<_>>(),
            [(201, 21), (101, 11)]
        );
        let one = st.usage_days(now - 70 * DAY_MS, now, Some("aa:aa"));
        assert_eq!(one.iter().map(|d| d.1).collect::<Vec<_>>(), [300, 200, 100]);
        // a 30-day history limit still keeps the 60-day-old usage
        st.cleanup(now, 30);
        assert_eq!(st.usage_days(now - 70 * DAY_MS, now, None).len(), 3);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn flows_saved_and_listed() {
        let mut b = [0u8; 8];
        getrandom::fill(&mut b).unwrap();
        let dir = std::env::temp_dir().join(format!("vygi-flows-{}", hex::encode(b)));
        let st = Store::new(&dir, "r");
        let t = 1_792_962_427_161;
        st.add_flows(&[FlowRec {
            t,
            f: t - 60_000,
            s: "10.20.2.42".into(),
            d: "1.1.1.1".into(),
            p: 443,
            pr: "tcp".into(),
            up: 10,
            down: 20,
            n: 2,
        }]);
        st.add_logs(&[LogLine {
            t: t + 1,
            p: 4,
            id: "kernel".into(),
            m: "[ipv4-FWD-filter-3-D]IN=eth1 SRC=10.20.2.42 DST=9.9.9.9 PROTO=UDP SPT=1 DPT=53"
                .into(),
        }]);
        let all = st.flows(t - 3_600_000, t + 10, "", "", 10);
        assert_eq!(
            all.iter()
                .map(|r| (r.dst.as_str(), r.blocked))
                .collect::<Vec<_>>(),
            [("9.9.9.9", true), ("1.1.1.1", false)]
        );
        assert_eq!(st.flows(t - 3_600_000, t + 10, "", "allowed", 10).len(), 1);
        assert_eq!(st.flows(t - 3_600_000, t + 10, "443", "", 10).len(), 1);
        // retries of one blocked attempt are one row
        st.add_logs(&[2, 3].map(|i| {
            LogLine {
                t: t + i * 1000,
                p: 4,
                id: "kernel".into(),
                m: "[ipv4-FWD-filter-3-D]IN=eth1 SRC=10.20.2.42 DST=9.9.9.9 PROTO=UDP SPT=1 DPT=53"
                    .into(),
            }
        }));
        let b = st.flows(t - 3_600_000, t + 10_000, "", "blocked", 10);
        assert_eq!((b.len(), b[0].count), (1, 3));
        // log lines out of time order don't upset it
        st.add_logs(&[LogLine {
            t: t - 5000,
            p: 4,
            id: "kernel".into(),
            m: "[ipv4-FWD-filter-3-D]IN=eth1 SRC=10.20.2.42 DST=9.9.9.9 PROTO=UDP SPT=1 DPT=53"
                .into(),
        }]);
        assert_eq!(
            st.flows(t - 3_600_000, t + 10_000, "", "blocked", 10)[0].count,
            4
        );
    }

    use super::*;

    fn tmp() -> PathBuf {
        let mut b = [0u8; 8];
        getrandom::fill(&mut b).unwrap();
        std::env::temp_dir().join(format!("vygi-hist-{}", hex::encode(b)))
    }

    #[test]
    fn router_ids_stay_inside() {
        assert_eq!(safe(".."), "__");
        assert_eq!(safe("."), "_");
        assert_eq!(safe("../x"), ".._x");
        assert_eq!(safe("vyos@10.0.0.1"), "vyos@10.0.0.1");
    }

    #[test]
    fn dates() {
        assert_eq!(day(0), "1970-01-01");
        assert_eq!(day(1_792_918_222_080), "2026-10-25");
        assert_eq!(day(951_782_400_000), "2000-02-29");
        assert_eq!(
            days(DAY_MS - 1, 2 * DAY_MS + 5),
            vec!["1970-01-01", "1970-01-02", "1970-01-03"]
        );
    }

    #[test]
    fn traffic_devices_logs_alerts_and_cleanup() {
        let base = tmp();
        let s = Store::new(&base, "vyos@192.168.1.1");
        let t0 = 1_792_918_222_080;
        for i in 0..10u64 {
            s.add_wan(t0 + i * 60_000, 1000.0 * i as f64, 10.0);
        }
        assert_eq!(s.wan(t0, t0 + 10 * 60_000, 100).len(), 10);
        let five = s.wan(t0, t0 + 10 * 60_000, 5);
        assert_eq!(five.len(), 5);
        assert_eq!(five[0][1], 500.0); // average of 0 and 1000

        let dev = |ip: &str, down, up| DeviceTotal {
            ip: ip.into(),
            name: String::new(),
            down,
            up,
        };
        s.add_devices(
            t0,
            &HashMap::from([
                ("aa".into(), dev("192.168.1.5", 100, 10)),
                ("bb".into(), dev("192.168.1.6", 5, 5)),
            ]),
        );
        s.add_devices(
            t0 + 60_000,
            &HashMap::from([("aa".into(), dev("192.168.1.5", 50, 0))]),
        );
        let top = s.devices(t0, t0, 10);
        assert_eq!(top[0].0, "aa");
        assert_eq!((top[0].1.down, top[0].1.up), (150, 10));

        s.add_logs(&[
            LogLine {
                t: t0,
                p: 6,
                id: "sshd".into(),
                m: "Accepted password for vyos".into(),
            },
            LogLine {
                t: t0 + 1,
                p: 3,
                id: "kernel".into(),
                m: "eth1: link down".into(),
            },
        ]);
        assert_eq!(s.logs("", t0, t0 + 10, 7, 10).len(), 2);
        assert_eq!(s.logs("LINK", t0, t0 + 10, 7, 10)[0].id, "kernel");
        assert_eq!(s.logs("", t0, t0 + 10, 4, 10).len(), 1); // errors only

        let a = |at, text: &str| Alert {
            kind: "device".into(),
            text: text.into(),
            level: "info".into(),
            at,
        };
        s.add_alerts(&[a(1, "one"), a(2, "two")]);
        assert_eq!(s.alerts(1, 10), vec![a(2, "two")]);

        let mut saved = s.load();
        saved.cursor = Some("c1".into());
        s.save(&saved);
        assert_eq!(s.load().cursor.as_deref(), Some("c1"));

        s.cleanup(t0 + 40 * DAY_MS, 30);
        assert!(s.wan(t0, t0 + 10 * 60_000, 100).is_empty());
        assert!(s.load().cursor.is_some()); // state.json isn't a day file
        let _ = fs::remove_dir_all(base);
    }
}
