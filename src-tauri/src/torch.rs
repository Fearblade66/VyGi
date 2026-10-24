//! Torch: live per-flow traffic rates on one interface, like Winbox Torch.
//!
//! Runs `tcpdump -i any -e` filtered to the interface's ifindex, so every line
//! carries the packet direction (In/Out) and frame length. Lines are
//! aggregated here into one table per second and sent to the UI.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use russh::ChannelMsg;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::mpsc;

use crate::error::{AppError, AppResult};
use crate::ssh::{shell_quote, validate_name, TermInput};
use crate::state::AppState;

/// Bytes of the Linux "cooked v2" capture header included in tcpdump's length.
const SLL2_HEADER: u64 = 20;
const MAX_FLOWS: usize = 300;

#[derive(Debug, PartialEq)]
struct Packet {
    out: bool,
    proto: String,
    src: String,
    sport: String,
    dst: String,
    dport: String,
    bytes: u64,
}

/// Splits "10.0.0.1.443" / "fe80::1.546" into address and port (when there is one).
fn split_port(endpoint: &str, has_ports: bool) -> (String, String) {
    let e = endpoint.trim_end_matches(':');
    if has_ports {
        if let Some((a, p)) = e.rsplit_once('.') {
            if p.chars().all(|c| c.is_ascii_digit())
                && (a.contains(':') || a.matches('.').count() == 3)
            {
                return (a.to_string(), p.to_string());
            }
        }
    }
    (e.to_string(), String::new())
}

/// Parses one line of `tcpdump -l -n -nn -t -e -i any` output.
fn parse_line(line: &str) -> Option<Packet> {
    let mut it = line.split_whitespace();
    let _iface = it.next()?;
    let out = it.next()? == "Out";
    let rest: Vec<&str> = it.collect();
    let et = rest.iter().position(|t| *t == "ethertype")?;
    let ethertype = *rest.get(et + 1)?;
    let len_pos = rest.iter().skip(et).position(|t| *t == "length")? + et;
    let bytes: u64 = rest.get(len_pos + 1)?.trim_end_matches(':').parse().ok()?;
    let bytes = bytes.saturating_sub(SLL2_HEADER);
    let payload = &rest[len_pos + 2..];

    if ethertype != "IPv4" && ethertype != "IPv6" {
        // ARP, LLDP, ...: one row per ethertype.
        return Some(Packet {
            out,
            proto: ethertype.to_ascii_lowercase(),
            src: String::new(),
            sport: String::new(),
            dst: String::new(),
            dport: String::new(),
            bytes,
        });
    }
    // payload: "SRC > DST: <proto info>"
    if payload.len() < 3 || payload[1] != ">" {
        return None;
    }
    let info = payload[3..].join(" ");
    let proto = if info.starts_with("Flags [") {
        "tcp"
    } else if info.starts_with("UDP") || info.contains(" UDP,") {
        "udp"
    } else if info.starts_with("ICMP6") {
        "icmp6"
    } else if info.starts_with("ICMP") {
        "icmp"
    } else if info.starts_with("GREv") || info.contains("GRE") {
        "gre"
    } else if info.starts_with("ESP") {
        "esp"
    } else {
        // DNS and other UDP protocols are decoded by name; ports present means udp/tcp.
        "ip"
    };
    let has_ports = matches!(proto, "tcp" | "udp" | "ip");
    let (src, sport) = split_port(payload[0], has_ports);
    let (dst, dport) = split_port(payload[2], has_ports);
    let proto = if proto == "ip" && !sport.is_empty() {
        "udp"
    } else {
        proto
    };
    Some(Packet {
        out,
        proto: proto.into(),
        src,
        sport,
        dst,
        dport,
        bytes,
    })
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowRate {
    proto: String,
    /// Endpoint the outgoing packets come from (the far side for a LAN port).
    src: String,
    sport: String,
    dst: String,
    dport: String,
    tx_bps: u64,
    rx_bps: u64,
    tx_pps: u64,
    rx_pps: u64,
}

#[derive(Serialize, Clone)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum TorchEvent {
    #[serde(rename_all = "camelCase")]
    Update {
        flows: Vec<FlowRate>,
        tx_bps: u64,
        rx_bps: u64,
    },
    Closed {
        message: String,
    },
}

#[derive(Default)]
struct Counter {
    tx_bytes: u64,
    rx_bytes: u64,
    tx_pkts: u64,
    rx_pkts: u64,
}

type Key = (String, String, String, String, String);

/// Folds a packet into the table. Incoming packets are stored reversed so both
/// directions of a conversation land on the same row (Tx = out, Rx = in).
fn add(table: &mut HashMap<Key, Counter>, p: Packet) {
    let key = if p.out {
        (p.proto, p.src, p.sport, p.dst, p.dport)
    } else {
        (p.proto, p.dst, p.dport, p.src, p.sport)
    };
    let c = table.entry(key).or_default();
    if p.out {
        c.tx_bytes += p.bytes;
        c.tx_pkts += 1;
    } else {
        c.rx_bytes += p.bytes;
        c.rx_pkts += 1;
    }
}

fn snapshot(table: &mut HashMap<Key, Counter>, secs: f64) -> TorchEvent {
    let rate = |v: u64| (v as f64 / secs).round() as u64;
    let mut flows: Vec<FlowRate> = table
        .drain()
        .map(|((proto, src, sport, dst, dport), c)| FlowRate {
            proto,
            src,
            sport,
            dst,
            dport,
            tx_bps: rate(c.tx_bytes * 8),
            rx_bps: rate(c.rx_bytes * 8),
            tx_pps: rate(c.tx_pkts),
            rx_pps: rate(c.rx_pkts),
        })
        .collect();
    flows.sort_by_key(|f| std::cmp::Reverse(f.tx_bps + f.rx_bps));
    let tx_bps = flows.iter().map(|f| f.tx_bps).sum();
    let rx_bps = flows.iter().map(|f| f.rx_bps).sum();
    flows.truncate(MAX_FLOWS);
    TorchEvent::Update {
        flows,
        tx_bps,
        rx_bps,
    }
}

#[tauri::command]
pub async fn open_torch(
    state: State<'_, AppState>,
    interface: String,
    filter: String,
    hide_port: Option<u16>,
    on_data: Channel<TorchEvent>,
) -> AppResult<u32> {
    let iface = validate_name(&interface)?.to_string();
    let conn = state.conn().await?;
    let idx = conn
        .ssh
        .exec_ok(&format!("cat /sys/class/net/{iface}/ifindex"))
        .await
        .map_err(|_| AppError::Invalid(format!("{iface} does not exist on the router")))?;
    let idx: u32 = idx
        .trim()
        .parse()
        .map_err(|_| AppError::Invalid("bad ifindex".into()))?;
    let mut expr = format!("ifindex {idx}");
    if let Some(p) = hide_port {
        expr.push_str(&format!(" and not port {p}"));
    }
    if !filter.trim().is_empty() {
        expr.push_str(&format!(" and ({})", filter.trim()));
    }
    let cmd = format!(
        "sudo -n tcpdump -l -n -nn -t -e -s 96 -i any {} 2>&1",
        shell_quote(&expr)
    );
    let mut channel = conn.ssh.exec_channel(&cmd).await?;

    let (tx, mut rx) = mpsc::channel::<TermInput>(8);
    let id = state.next_session_id();
    state.sessions.lock().await.insert(id, tx);

    tauri::async_runtime::spawn(async move {
        let mut table: HashMap<Key, Counter> = HashMap::new();
        let mut buf = String::new();
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        let mut last = Instant::now();
        let mut error_text = String::new();
        loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        buf.push_str(&String::from_utf8_lossy(&data));
                        while let Some(pos) = buf.find('\n') {
                            let line: String = buf.drain(..=pos).collect();
                            match parse_line(&line) {
                                Some(p) => add(&mut table, p),
                                None if line.starts_with("tcpdump:") && !line.contains("listening on")
                                    && !line.contains("verbose output") && !line.contains("data link type") => {
                                    error_text = line.trim().to_string();
                                }
                                None => {}
                            }
                        }
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    Some(_) => {}
                },
                _ = tick.tick() => {
                    let secs = last.elapsed().as_secs_f64().max(0.001);
                    last = Instant::now();
                    if on_data.send(snapshot(&mut table, secs)).is_err() {
                        let _ = channel.close().await;
                        break;
                    }
                }
                input = rx.recv() => if matches!(input, Some(TermInput::Close) | None) {
                    let _ = channel.close().await;
                    break;
                },
            }
        }
        let _ = on_data.send(TorchEvent::Closed {
            message: error_text,
        });
    });
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pkt(
        out: bool,
        proto: &str,
        src: &str,
        sport: &str,
        dst: &str,
        dport: &str,
        bytes: u64,
    ) -> Packet {
        Packet {
            out,
            proto: proto.into(),
            src: src.into(),
            sport: sport.into(),
            dst: dst.into(),
            dport: dport.into(),
            bytes,
        }
    }

    #[test]
    fn parses_real_lines() {
        // Captured on the VyOS 2026.10.23 test router.
        assert_eq!(
            parse_line("eth2  In  ifindex 4 16:c0:9b:cb:5a:b8 ethertype IPv4 (0x0800), length 104: 10.20.2.3 > 10.20.2.2: ICMP echo request, id 45, seq 1389, length 64"),
            Some(pkt(false, "icmp", "10.20.2.3", "", "10.20.2.2", "", 84))
        );
        assert_eq!(
            parse_line("eth0  Out ifindex 2 66:69:fb:28:2e:a5 ethertype IPv4 (0x0800), length 120: 172.17.0.2.443 > 172.17.0.1.51234: Flags [P.], seq 1:53, ack 1, win 501, length 52"),
            Some(pkt(true, "tcp", "172.17.0.2", "443", "172.17.0.1", "51234", 100))
        );
        assert_eq!(
            parse_line("eth1  Out ifindex 3 ce:64:b5:9e:ba:01 ethertype IPv4 (0x0800), length 92: 10.20.1.2.40000 > 1.1.1.1.53: 1234+ A? example.com. (29)"),
            Some(pkt(true, "udp", "10.20.1.2", "40000", "1.1.1.1", "53", 72))
        );
        assert_eq!(
            parse_line("eth2  Out ifindex 4 22:4d:f7:d2:56:70 ethertype IPv6 (0x86dd), length 110: fe80::1.546 > ff02::1:2.547: UDP, length 32").map(|p| (p.src, p.sport, p.dport)),
            Some(("fe80::1".into(), "546".into(), "547".into()))
        );
        assert_eq!(parse_line("eth2  Out ifindex 4 22:4d:f7:d2:56:70 ethertype ARP (0x0806), length 62: Request who-has 10.20.2.3 tell 10.20.2.2, length 28").map(|p| p.proto), Some("arp".into()));
        assert_eq!(
            parse_line("tcpdump: listening on any, link-type LINUX_SLL2"),
            None
        );
    }

    #[test]
    fn aggregates_both_directions() {
        let mut t = HashMap::new();
        add(
            &mut t,
            pkt(true, "tcp", "1.1.1.1", "443", "10.0.0.5", "5000", 1000),
        );
        add(
            &mut t,
            pkt(false, "tcp", "10.0.0.5", "5000", "1.1.1.1", "443", 100),
        );
        add(
            &mut t,
            pkt(true, "tcp", "1.1.1.1", "443", "10.0.0.5", "5000", 1000),
        );
        let TorchEvent::Update {
            flows,
            tx_bps,
            rx_bps,
        } = snapshot(&mut t, 2.0)
        else {
            panic!()
        };
        assert_eq!(flows.len(), 1);
        assert_eq!(
            (flows[0].tx_bps, flows[0].rx_bps, flows[0].tx_pps),
            (8000, 400, 1)
        );
        assert_eq!((tx_bps, rx_bps), (8000, 400));
        assert!(t.is_empty());
    }
}
