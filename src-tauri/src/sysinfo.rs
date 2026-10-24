//! System status and diagnostics for the Resources, Neighbors, Connections,
//! IP Scan, Processes and Images windows, and the dashboard.
//!
//! Prefers VyOS op-mode scripts' `--raw` JSON output; falls back to plain
//! Linux tools where VyOS has no JSON form.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::ssh::{shell_quote, SshClient};
use crate::state::AppState;

const OP_MODE: &str = "/usr/libexec/vyos/op_mode";

/// Runs `<op_mode>/<script> <args> --raw`. Returns `None` when VyOS says the
/// feature isn't configured/available (it exits 1 with a message on stdout).
pub(crate) async fn op_raw(ssh: &SshClient, script: &str, args: &str) -> AppResult<Option<Value>> {
    let cmd = format!("sudo -n {OP_MODE}/{script} {args} --raw");
    let out = ssh.exec(&cmd, Duration::from_secs(30)).await?;
    let text = out.stdout.trim();
    if out.exit_code == Some(0) || out.exit_code.is_none() {
        if text.is_empty() {
            return Ok(None);
        }
        return serde_json::from_str(text).map(Some).map_err(|_| {
            AppError::Ssh(format!("{script}: unexpected output: {}", first_line(text)))
        });
    }
    let lower = text.to_ascii_lowercase();
    if [
        "not configured",
        "not available",
        "not running",
        "not found",
        "not enabled",
    ]
    .iter()
    .any(|p| lower.contains(p))
    {
        return Ok(None);
    }
    Err(AppError::Ssh(format!(
        "{script} failed: {}",
        first_line(if text.is_empty() {
            out.stderr.trim()
        } else {
            text
        })
    )))
}

fn first_line(s: &str) -> String {
    s.lines()
        .next()
        .unwrap_or_default()
        .chars()
        .take(300)
        .collect()
}

/// DHCP server leases (empty when no DHCP server is configured).
#[tauri::command]
pub async fn dhcp_leases(state: State<'_, AppState>, family: u8) -> AppResult<Value> {
    let fam = match family {
        4 => "inet",
        6 => "inet6",
        _ => return Err(AppError::Invalid("family must be 4 or 6".into())),
    };
    let conn = state.conn().await?;
    let args = format!("show_server_leases --family {fam}");
    match op_raw(&conn.ssh, "dhcp.py", &args).await {
        Ok(v) => Ok(v.unwrap_or(Value::Array(Vec::new()))),
        // Some VyOS builds crash producing JSON (timedelta not serializable);
        // the human-readable table still works, so parse that instead.
        Err(_) => {
            let out = conn
                .ssh
                .exec(
                    &format!("sudo -n {OP_MODE}/dhcp.py {args}"),
                    Duration::from_secs(30),
                )
                .await?;
            Ok(Value::Array(
                parse_table(&out.stdout)
                    .into_iter()
                    .map(lease_from_row)
                    .collect(),
            ))
        }
    }
}

/// Parses VyOS's tabulate output ("Col A   Col B" / "-----  -----" / rows),
/// using the dash underline to find column boundaries.
fn parse_table(text: &str) -> Vec<Vec<(String, String)>> {
    let lines: Vec<&str> = text.lines().collect();
    let Some(dash) = lines.iter().position(|l| {
        let t = l.trim();
        !t.is_empty() && t.chars().all(|c| c == '-' || c == ' ')
    }) else {
        return Vec::new();
    };
    if dash == 0 {
        return Vec::new();
    }
    let rule = lines[dash];
    let mut spans = Vec::new();
    let mut start = None;
    for (i, c) in rule
        .char_indices()
        .chain(std::iter::once((rule.len(), ' ')))
    {
        match (c == '-', start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                spans.push((s, i));
                start = None;
            }
            _ => {}
        }
    }
    let cut = |l: &str, (a, b): (usize, usize), last: bool| -> String {
        let a = a.min(l.len());
        let b = if last { l.len() } else { b.min(l.len()) };
        l.get(a..b).unwrap_or("").trim().to_string()
    };
    let header = lines[dash - 1];
    let names: Vec<String> = spans
        .iter()
        .enumerate()
        .map(|(i, s)| cut(header, *s, i + 1 == spans.len()))
        .collect();
    lines[dash + 1..]
        .iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            spans
                .iter()
                .enumerate()
                .map(|(i, s)| (names[i].clone(), cut(l, *s, i + 1 == spans.len())))
                .collect()
        })
        .collect()
}

/// Maps a `show dhcp server leases` table row to the `--raw` JSON field names.
fn lease_from_row(row: Vec<(String, String)>) -> Value {
    let mut m = serde_json::Map::new();
    for (k, v) in row {
        let key = match k.to_ascii_lowercase().as_str() {
            "ip address" => "ip",
            "mac address" => "mac",
            "state" => "state",
            "lease start" => "start",
            "lease expiration" => "end",
            "remaining" => "remaining",
            "pool" => "pool",
            "hostname" => "hostname",
            "origin" => "origin",
            _ => continue,
        };
        let v = if v == "-" { String::new() } else { v };
        m.insert(key.into(), Value::String(v));
    }
    Value::Object(m)
}

// ---------------------------------------------------------------- resources

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Load {
    /// Raw `cpu` line counters from /proc/stat; the UI diffs two samples for CPU %.
    cpu_times: Vec<u64>,
    load: Vec<f64>,
    mem_total_kb: Option<u64>,
    mem_available_kb: Option<u64>,
    uptime_secs: Option<u64>,
    /// Degrees Celsius, one per thermal zone.
    temperatures: Vec<f64>,
}

const LOAD_SCRIPT: &str = "head -1 /proc/stat; echo @@; cat /proc/loadavg; echo @@; \
     grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; echo @@; cat /proc/uptime; echo @@; \
     cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null; true";

fn parse_load(out: &str) -> Load {
    let parts: Vec<&str> = out.split("@@").map(str::trim).collect();
    let part = |i: usize| parts.get(i).copied().unwrap_or("");
    let mut l = Load {
        cpu_times: part(0)
            .split_whitespace()
            .skip(1)
            .filter_map(|v| v.parse().ok())
            .collect(),
        load: part(1)
            .split_whitespace()
            .take(3)
            .filter_map(|v| v.parse().ok())
            .collect(),
        uptime_secs: part(3)
            .split_whitespace()
            .next()
            .and_then(|v| v.parse::<f64>().ok())
            .map(|v| v as u64),
        temperatures: part(4)
            .lines()
            .filter_map(|v| v.trim().parse::<f64>().ok())
            .map(|milli| milli / 1000.0)
            .collect(),
        ..Default::default()
    };
    for line in part(2).lines() {
        let mut it = line.split_whitespace();
        let (key, val) = (it.next(), it.next().and_then(|v| v.parse().ok()));
        match key {
            Some("MemTotal:") => l.mem_total_kb = val,
            Some("MemAvailable:") => l.mem_available_kb = val,
            _ => {}
        }
    }
    l
}

/// Fast-changing numbers, polled every couple of seconds.
#[tauri::command]
pub async fn system_load(state: State<'_, AppState>) -> AppResult<Load> {
    let conn = state.conn().await?;
    let out = conn.ssh.exec(LOAD_SCRIPT, Duration::from_secs(15)).await?;
    Ok(parse_load(&out.stdout))
}

/// Slow-changing facts: version, CPU model/count, storage.
#[tauri::command]
pub async fn system_info(state: State<'_, AppState>) -> AppResult<Value> {
    let conn = state.conn().await?;
    let version = op_raw(&conn.ssh, "version.py", "show")
        .await
        .unwrap_or(None);
    let cpu = op_raw(&conn.ssh, "cpu.py", "show").await.unwrap_or(None);
    let storage = op_raw(&conn.ssh, "storage.py", "show")
        .await
        .unwrap_or(None);
    let cpus = cpu.as_ref().and_then(Value::as_array).map(Vec::len);
    let model = cpu
        .as_ref()
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("modelname"))
        .cloned();
    Ok(json!({ "version": version, "cpus": cpus, "cpuModel": model, "storage": storage }))
}

// ---------------------------------------------------------------- neighbors

/// ARP / NDP table (`ip -j neigh`).
#[tauri::command]
pub async fn neighbors(state: State<'_, AppState>) -> AppResult<Value> {
    let out = state.conn().await?.ssh.exec_ok("ip -j neigh show").await?;
    let t = out.trim();
    if t.is_empty() {
        return Ok(Value::Array(Vec::new()));
    }
    Ok(serde_json::from_str(t)?)
}

/// LLDP neighbors (empty when `service lldp` isn't configured).
#[tauri::command]
pub async fn lldp_neighbors(state: State<'_, AppState>) -> AppResult<Value> {
    let conn = state.conn().await?;
    Ok(op_raw(&conn.ssh, "lldp.py", "show_neighbors")
        .await?
        .unwrap_or(Value::Null))
}

// ---------------------------------------------------------------- connections

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Flow {
    proto: String,
    state: String,
    src: String,
    dst: String,
    sport: String,
    dport: String,
    /// Reply direction source (differs from `dst` when NAT applied).
    reply_src: String,
    reply_dst: String,
    packets: u64,
    bytes: u64,
    timeout: u64,
    assured: bool,
}

/// Parses one `conntrack -L -o extended` line.
fn parse_flow(line: &str) -> Option<Flow> {
    let toks: Vec<&str> = line.split_whitespace().collect();
    // "ipv4 2 tcp 6 431999 ESTABLISHED src=.. ..." (state is absent for udp/icmp)
    let proto = toks.get(2)?.to_string();
    let timeout = toks.get(4).and_then(|t| t.parse().ok()).unwrap_or(0);
    let state = toks
        .get(5)
        .filter(|t| !t.contains('='))
        .map(|s| s.to_string())
        .unwrap_or_default();
    let mut f = Flow {
        proto,
        state,
        src: String::new(),
        dst: String::new(),
        sport: String::new(),
        dport: String::new(),
        reply_src: String::new(),
        reply_dst: String::new(),
        packets: 0,
        bytes: 0,
        timeout,
        assured: line.contains("[ASSURED]"),
    };
    let (mut srcs, mut dsts, mut sports, mut dports) = (0, 0, 0, 0);
    for t in &toks {
        let Some((k, v)) = t.split_once('=') else {
            continue;
        };
        match k {
            "src" => {
                if srcs == 0 {
                    f.src = v.into()
                } else if srcs == 1 {
                    f.reply_src = v.into()
                }
                srcs += 1;
            }
            "dst" => {
                if dsts == 0 {
                    f.dst = v.into()
                } else if dsts == 1 {
                    f.reply_dst = v.into()
                }
                dsts += 1;
            }
            "sport" => {
                if sports == 0 {
                    f.sport = v.into()
                }
                sports += 1;
            }
            "dport" => {
                if dports == 0 {
                    f.dport = v.into()
                }
                dports += 1;
            }
            "packets" => f.packets += v.parse().unwrap_or(0),
            "bytes" => f.bytes += v.parse().unwrap_or(0),
            _ => {}
        }
    }
    if f.src.is_empty() {
        return None;
    }
    Some(f)
}

/// Connection tracking table (newest 5000 entries).
#[tauri::command]
pub async fn connections(state: State<'_, AppState>) -> AppResult<Vec<Flow>> {
    let out = state
        .conn()
        .await?
        .ssh
        .exec(
            "sudo -n conntrack -L -o extended 2>/dev/null | head -5000",
            Duration::from_secs(30),
        )
        .await?;
    Ok(out.stdout.lines().filter_map(parse_flow).collect())
}

// ---------------------------------------------------------------- tools

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Latency {
    target: String,
    loss_percent: Option<f64>,
    avg_ms: Option<f64>,
}

fn parse_ping(out: &str) -> (Option<f64>, Option<f64>) {
    let loss = out
        .lines()
        .find(|l| l.contains("packet loss"))
        .and_then(|l| l.split(',').find(|p| p.contains("packet loss")))
        .and_then(|p| p.trim().split('%').next())
        .and_then(|v| v.trim().parse().ok());
    let avg = out
        .lines()
        .find(|l| l.contains("min/avg/max"))
        .and_then(|l| l.split('=').nth(1))
        .and_then(|v| v.trim().split('/').nth(1))
        .and_then(|v| v.parse().ok());
    (loss, avg)
}

/// Quick 3-packet ping from the router (internet health on the dashboard).
#[tauri::command]
pub async fn ping_latency(state: State<'_, AppState>, target: String) -> AppResult<Latency> {
    let t = target.trim();
    if t.is_empty() || t.starts_with('-') || t.len() > 253 {
        return Err(AppError::Invalid("bad target".into()));
    }
    let cmd = format!("ping -c 3 -i 0.3 -W 2 -- {}", shell_quote(t));
    let out = state
        .conn()
        .await?
        .ssh
        .exec(&cmd, Duration::from_secs(15))
        .await?;
    let (loss, avg) = parse_ping(&out.stdout);
    Ok(Latency {
        target: t.to_string(),
        loss_percent: loss,
        avg_ms: avg,
    })
}

/// Expands an IPv4 CIDR into host addresses (max 1024).
fn scan_targets(cidr: &str) -> AppResult<Vec<String>> {
    let (ip, bits) = cidr
        .trim()
        .split_once('/')
        .ok_or_else(|| AppError::Invalid("use a network like 192.168.1.0/24".into()))?;
    let bits: u32 = bits
        .parse()
        .map_err(|_| AppError::Invalid("bad prefix length".into()))?;
    if !(22..=32).contains(&bits) {
        return Err(AppError::Invalid(
            "scan /22 or smaller (max 1024 addresses)".into(),
        ));
    }
    let addr: std::net::Ipv4Addr = ip
        .parse()
        .map_err(|_| AppError::Invalid("bad IPv4 address".into()))?;
    let mask = if bits == 0 {
        0
    } else {
        u32::MAX << (32 - bits)
    };
    let net = u32::from(addr) & mask;
    let size = 1u32 << (32 - bits);
    let (first, last) = if bits >= 31 {
        (net, net + size - 1)
    } else {
        (net + 1, net + size - 2)
    };
    Ok((first..=last)
        .map(|n| std::net::Ipv4Addr::from(n).to_string())
        .collect())
}

/// Pings every address in a subnet (64 at a time) and returns those that answered,
/// plus the neighbor table so the UI can show MAC addresses.
#[tauri::command]
pub async fn ip_scan(state: State<'_, AppState>, network: String) -> AppResult<Value> {
    let targets = scan_targets(&network)?;
    // Addresses are generated by us from a parsed integer, so they are safe to inline.
    let cmd = format!(
        "printf '%s\\n' {} | xargs -P 64 -I{{}} sh -c 'ping -c1 -W1 {{}} >/dev/null 2>&1 && echo {{}}'; echo @@; ip -j neigh show",
        targets.join(" ")
    );
    let out = state
        .conn()
        .await?
        .ssh
        .exec(&cmd, Duration::from_secs(120))
        .await?;
    let (alive, neigh) = out.stdout.split_once("@@").unwrap_or((&out.stdout, "[]"));
    let alive: Vec<&str> = alive
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let neigh: Value = serde_json::from_str(neigh.trim()).unwrap_or(Value::Array(Vec::new()));
    Ok(json!({ "alive": alive, "scanned": targets.len(), "neighbors": neigh }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pid: u32,
    user: String,
    cpu: f64,
    mem: f64,
    rss_kb: u64,
    elapsed: String,
    command: String,
}

/// Top processes by CPU (Winbox "Profile").
#[tauri::command]
pub async fn processes(state: State<'_, AppState>) -> AppResult<Vec<Process>> {
    let out = state
        .conn()
        .await?
        .ssh
        .exec_ok("ps -eo pid=,user=,pcpu=,pmem=,rss=,etime=,comm= --sort=-pcpu | head -40")
        .await?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let c: Vec<&str> = l.split_whitespace().collect();
            if c.len() < 7 {
                return None;
            }
            Some(Process {
                pid: c[0].parse().ok()?,
                user: c[1].into(),
                cpu: c[2].parse().unwrap_or(0.0),
                mem: c[3].parse().unwrap_or(0.0),
                rss_kb: c[4].parse().unwrap_or(0),
                elapsed: c[5].into(),
                command: c[6..].join(" "),
            })
        })
        .collect())
}

// ---------------------------------------------------------------- images / power

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    name: String,
    default_boot: bool,
    running: bool,
}

/// Parses the `/image show` table ("Name  Default boot  Running" + dashes + rows),
/// using the header's column positions because blank cells are just spaces.
fn parse_images(text: &str) -> Vec<Image> {
    let mut lines = text.lines();
    let Some(header) = lines.by_ref().find(|l| l.contains("Default boot")) else {
        return Vec::new();
    };
    let def_col = header.find("Default boot").unwrap_or(usize::MAX);
    let run_col = header.find("Running").unwrap_or(usize::MAX);
    let cell = |l: &str, from: usize, to: usize| -> String {
        let bytes = l.as_bytes();
        let (a, b) = (from.min(bytes.len()), to.min(bytes.len()));
        String::from_utf8_lossy(&bytes[a..b]).trim().to_string()
    };
    lines
        .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with("---"))
        .map(|l| Image {
            name: cell(l, 0, def_col),
            default_boot: cell(l, def_col, run_col).eq_ignore_ascii_case("yes"),
            running: cell(l, run_col, usize::MAX).eq_ignore_ascii_case("yes"),
        })
        .filter(|i| !i.name.is_empty())
        .collect()
}

#[tauri::command]
pub async fn image_list(state: State<'_, AppState>) -> AppResult<Vec<Image>> {
    let text = state
        .conn()
        .await?
        .api
        .image(json!({ "op": "show" }), 60)
        .await?;
    Ok(parse_images(&text))
}

/// Downloads and installs a new image (can take many minutes).
#[tauri::command]
pub async fn image_add(state: State<'_, AppState>, url: String) -> AppResult<String> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(AppError::Invalid(
            "the image URL must start with https://".into(),
        ));
    }
    state
        .conn()
        .await?
        .api
        .image(json!({ "op": "add", "url": url }), 1800)
        .await
}

#[tauri::command]
pub async fn image_set_default(state: State<'_, AppState>, name: String) -> AppResult<String> {
    state
        .conn()
        .await?
        .api
        .image(json!({ "op": "set_default", "name": name }), 60)
        .await
}

#[tauri::command]
pub async fn image_delete(state: State<'_, AppState>, name: String) -> AppResult<String> {
    state
        .conn()
        .await?
        .api
        .image(json!({ "op": "delete", "name": name }), 120)
        .await
}

/// Reboots or powers off the router now.
#[tauri::command]
pub async fn power(state: State<'_, AppState>, action: String) -> AppResult<String> {
    let endpoint = match action.as_str() {
        "reboot" => "/reboot",
        "poweroff" => "/poweroff",
        _ => {
            return Err(AppError::Invalid(
                "action must be reboot or poweroff".into(),
            ))
        }
    };
    let conn = state.conn().await?;
    let msg = conn.api.power(endpoint, &action).await?;
    state.close_sessions().await;
    Ok(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dhcp_table_fallback() {
        // Real output of `show dhcp server leases` on VyOS 2026.10.23 rolling.
        let t = "IP Address    MAC address        State    Lease start          Lease expiration     Remaining       Pool    Hostname    Origin\n------------  -----------------  -------  -------------------  -------------------  --------------  ------  ----------  --------\n10.20.2.100   16:c0:9b:cb:5a:b8  active   2026-10-24 22:21:02  2026-10-25 21:21:02  1 day, 1:58:51  LAN     -           local\n";
        let rows: Vec<Value> = parse_table(t).into_iter().map(lease_from_row).collect();
        assert_eq!(
            rows,
            vec![
                json!({"ip": "10.20.2.100", "mac": "16:c0:9b:cb:5a:b8", "state": "active", "start": "2026-10-24 22:21:02",
                        "end": "2026-10-25 21:21:02", "remaining": "1 day, 1:58:51", "pool": "LAN", "hostname": "", "origin": "local"})
            ]
        );
        assert!(parse_table("DHCP server is not configured\n").is_empty());
    }

    #[test]
    fn flows() {
        let tcp = "ipv4     2 tcp      6 431999 ESTABLISHED src=192.168.1.10 dst=1.1.1.1 sport=50000 dport=443 packets=12 bytes=3000 src=1.1.1.1 dst=203.0.113.7 sport=443 dport=50000 packets=10 bytes=9000 [ASSURED] mark=0 use=1";
        let f = parse_flow(tcp).unwrap_or_else(|| panic!("tcp"));
        assert_eq!(
            (
                f.proto.as_str(),
                f.state.as_str(),
                f.src.as_str(),
                f.dport.as_str()
            ),
            ("tcp", "ESTABLISHED", "192.168.1.10", "443")
        );
        assert_eq!(
            (f.reply_dst.as_str(), f.bytes, f.packets, f.assured),
            ("203.0.113.7", 12000, 22, true)
        );
        let udp = "ipv4     2 udp      17 25 src=192.168.1.10 dst=9.9.9.9 sport=5353 dport=53 src=9.9.9.9 dst=192.168.1.10 sport=53 dport=5353 mark=0 use=1";
        let u = parse_flow(udp).unwrap_or_else(|| panic!("udp"));
        assert_eq!((u.state.as_str(), u.timeout, u.bytes), ("", 25, 0));
        assert!(
            parse_flow("conntrack v1.4.7 (conntrack-tools): 0 flow entries have been shown.")
                .is_none()
        );
    }

    #[test]
    fn ping_summary() {
        let out = "3 packets transmitted, 3 received, 0% packet loss, time 602ms\nrtt min/avg/max/mdev = 9.1/10.25/11.0/0.5 ms\n";
        assert_eq!(parse_ping(out), (Some(0.0), Some(10.25)));
        assert_eq!(
            parse_ping("3 packets transmitted, 0 received, 100% packet loss, time 2ms\n"),
            (Some(100.0), None)
        );
    }

    #[test]
    fn scan_ranges() {
        assert_eq!(
            scan_targets("192.168.1.0/24").map(|v| v.len()).ok(),
            Some(254)
        );
        assert_eq!(
            scan_targets("10.0.0.5/30").ok(),
            Some(vec!["10.0.0.5".to_string(), "10.0.0.6".to_string()])
        );
        assert!(scan_targets("10.0.0.0/16").is_err());
        assert!(scan_targets("10.0.0.0/24; rm -rf /").is_err());
    }

    #[test]
    fn images() {
        let t = "Name                      Default boot    Running\n------------------------  --------------  ---------\n1.5-rolling-202610230026  Yes             Yes\n1.5-rolling-202609010000                  Yes\n";
        assert_eq!(
            parse_images(t),
            vec![
                Image {
                    name: "1.5-rolling-202610230026".into(),
                    default_boot: true,
                    running: true
                },
                Image {
                    name: "1.5-rolling-202609010000".into(),
                    default_boot: false,
                    running: true
                },
            ]
        );
        assert!(parse_images(
            "Name    Default boot    Running\n------  --------------  ---------\n"
        )
        .is_empty());
    }

    #[test]
    fn load_parsing() {
        let out = "cpu  100 0 50 1000 5 0 2 0 0 0\n@@\n0.50 0.40 0.30 1/200 99\n@@\nMemTotal: 1000 kB\nMemAvailable: 600 kB\n@@\n3600.5 100.0\n@@\n45000\n51500\n";
        let l = parse_load(out);
        assert_eq!(l.cpu_times, vec![100, 0, 50, 1000, 5, 0, 2, 0, 0, 0]);
        assert_eq!(l.load, vec![0.5, 0.4, 0.3]);
        assert_eq!(
            (l.mem_total_kb, l.mem_available_kb, l.uptime_secs),
            (Some(1000), Some(600), Some(3600))
        );
        assert_eq!(l.temperatures, vec![45.0, 51.5]);
    }
}
