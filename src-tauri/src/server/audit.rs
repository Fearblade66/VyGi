//! Activity log (web server): who did what, when and from where. Logins,
//! API tokens, and every change made to a router from the UI or through the
//! API. One JSON line per entry in `<data>/audit/YYYY-MM.jsonl`, kept a year.
//! Secrets in router commands are replaced before they are written.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Mutex as StdMutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::vyos_api::ConfigCommand;

const KEEP_MONTHS: usize = 12;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub at: u64,
    /// "web session 1a2b3c4d", "token Claude", "server"
    pub who: String,
    pub ip: String,
    /// e.g. "login", "change", "token created"
    pub action: String,
    /// router the action was about, if any
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub router: String,
    pub detail: String,
    pub ok: bool,
}

pub struct Audit {
    dir: PathBuf,
    lock: StdMutex<()>,
}

/// "2026-10" for a unix-ms time.
fn month(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}")
}

/// Words in a config path that mean the next value is a secret.
fn secret_path(path: &[String]) -> bool {
    path.iter().any(|w| {
        w.contains("password")
            || w.contains("secret")
            || w.contains("preshared")
            || w == "key"
            || (w.ends_with("-key") && w != "public-key")
            || w.contains("token")
    })
}

/// "set firewall ipv4 … 'drop'" lines with secrets hidden.
pub fn command_lines(cmds: &[ConfigCommand]) -> Vec<String> {
    cmds.iter()
        .map(|c| {
            let mut path = c.path.clone();
            // a value can be the last path element (`set ... key VALUE`)
            if c.value.is_none() && path.len() > 1 && secret_path(&path[..path.len() - 1]) {
                let n = path.len();
                path[n - 1] = "<hidden>".into();
            }
            let value = match &c.value {
                Some(_) if secret_path(&c.path) => " '<hidden>'".to_string(),
                Some(v) => format!(" '{v}'"),
                None => String::new(),
            };
            format!("{} {}{}", c.op, path.join(" "), value)
        })
        .collect()
}

/// A change's detail: its description plus its commands (at most 40 lines).
pub fn change_detail(what: Option<&str>, cmds: &[ConfigCommand]) -> String {
    let lines = command_lines(cmds);
    let mut out = String::new();
    if let Some(w) = what.filter(|w| !w.trim().is_empty()) {
        out.push_str(w.trim());
        out.push('\n');
    }
    for l in lines.iter().take(40) {
        out.push_str(l);
        out.push('\n');
    }
    if lines.len() > 40 {
        out.push_str(&format!("… and {} more\n", lines.len() - 40));
    }
    out.trim_end().to_string()
}

impl Audit {
    pub fn new(data: &std::path::Path) -> Self {
        let dir = data.join("audit");
        let _ = fs::create_dir_all(&dir);
        Audit {
            dir,
            lock: StdMutex::new(()),
        }
    }

    pub fn log(&self, e: Entry) {
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let path = self.dir.join(format!("{}.jsonl", month(e.at)));
        if let (Ok(line), Ok(mut f)) = (
            serde_json::to_string(&e),
            OpenOptions::new().create(true).append(true).open(&path),
        ) {
            let _ = writeln!(f, "{line}");
        }
        // drop months beyond the last year
        if let Ok(rd) = fs::read_dir(&self.dir) {
            let mut files: Vec<PathBuf> = rd
                .filter_map(|x| x.ok().map(|x| x.path()))
                .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
                .collect();
            files.sort();
            while files.len() > KEEP_MONTHS {
                let _ = fs::remove_file(files.remove(0));
            }
        }
    }

    /// Newest first: at most `limit` entries older than `before` (ms; 0 = now)
    /// whose text contains `query` (case-insensitive).
    pub fn list(&self, before: u64, limit: usize, query: &str) -> Vec<Entry> {
        let q = query.trim().to_lowercase();
        let mut files: Vec<PathBuf> = fs::read_dir(&self.dir)
            .map(|rd| rd.filter_map(|x| x.ok().map(|x| x.path())).collect())
            .unwrap_or_default();
        files.retain(|p| p.extension().is_some_and(|x| x == "jsonl"));
        files.sort();
        let mut out = Vec::new();
        for f in files.iter().rev() {
            let Ok(file) = fs::File::open(f) else {
                continue;
            };
            let mut month: Vec<Entry> = BufReader::new(file)
                .lines()
                .map_while(Result::ok)
                .filter_map(|l| serde_json::from_str::<Entry>(&l).ok())
                .filter(|e| before == 0 || e.at < before)
                .filter(|e| {
                    q.is_empty()
                        || [&e.who, &e.ip, &e.action, &e.router, &e.detail]
                            .iter()
                            .any(|s| s.to_lowercase().contains(&q))
                })
                .collect();
            month.reverse();
            for e in month {
                out.push(e);
                if out.len() >= limit {
                    return out;
                }
            }
        }
        out
    }
}

/// Router commands from a JSON `commands` argument (for logging only).
pub fn commands_from(v: Option<&Value>) -> Vec<ConfigCommand> {
    v.cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(op: &str, path: &[&str], value: Option<&str>) -> ConfigCommand {
        ConfigCommand {
            op: op.into(),
            path: path.iter().map(|s| s.to_string()).collect(),
            value: value.map(str::to_string),
        }
    }

    #[test]
    fn months() {
        assert_eq!(month(0), "1970-01");
        assert_eq!(month(1_792_962_427_161), "2026-10");
        assert_eq!(month(951_782_400_000), "2000-02"); // 29 Feb 2000
    }

    #[test]
    fn secrets_hidden() {
        let lines = command_lines(&[
            cmd(
                "set",
                &["interfaces", "wireguard", "wg10", "private-key"],
                Some("SECRETKEY"),
            ),
            cmd(
                "set",
                &[
                    "system",
                    "login",
                    "user",
                    "vyos",
                    "authentication",
                    "plaintext-password",
                ],
                Some("hunter2"),
            ),
            cmd(
                "set",
                &[
                    "service", "https", "api", "keys", "id", "vygi", "key", "INPATH",
                ],
                None,
            ),
            cmd(
                "set",
                &["interfaces", "wireguard", "wg10", "peer", "p", "public-key"],
                Some("PUBKEY"),
            ),
            cmd(
                "delete",
                &["firewall", "ipv4", "forward", "filter", "rule", "10"],
                None,
            ),
        ]);
        let all = lines.join("\n");
        for s in ["SECRETKEY", "hunter2", "INPATH"] {
            assert!(!all.contains(s), "{s} leaked: {all}");
        }
        assert!(
            all.contains("PUBKEY") && all.contains("delete firewall ipv4 forward filter rule 10")
        );
    }

    #[test]
    fn log_and_list() {
        let mut b = [0u8; 8];
        getrandom::fill(&mut b).unwrap();
        let dir = std::env::temp_dir().join(format!("vygi-audit-{}", hex::encode(b)));
        let a = Audit::new(&dir);
        for (i, action) in ["login", "change", "token created"].iter().enumerate() {
            a.log(Entry {
                at: 1_792_962_427_161 + i as u64,
                who: "web session 1".into(),
                ip: "192.168.1.5".into(),
                action: action.to_string(),
                router: String::new(),
                detail: String::new(),
                ok: true,
            });
        }
        let l = a.list(0, 10, "");
        assert_eq!(
            l.iter().map(|e| e.action.as_str()).collect::<Vec<_>>(),
            ["token created", "change", "login"]
        );
        assert_eq!(a.list(0, 10, "TOKEN").len(), 1);
        assert_eq!(a.list(l[1].at, 10, "").len(), 1);
        assert_eq!(a.list(0, 2, "").len(), 2);
    }
}
