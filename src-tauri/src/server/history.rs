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
}

pub struct Store {
    dir: PathBuf,
}

fn safe(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@') {
                c
            } else {
                '_'
            }
        })
        .collect()
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
                if d.len() == 10 && d < oldest.as_str() {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let mut b = [0u8; 8];
        getrandom::fill(&mut b).unwrap();
        std::env::temp_dir().join(format!("vygi-hist-{}", hex::encode(b)))
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
