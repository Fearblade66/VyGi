//! What changed on the router since the last check, as alerts. The same
//! rules (and words) as the app's src/lib/alerts.js, for the server's 24/7
//! watching.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

const FAILS_FOR_DOWN: u32 = 2; // checks in a row before "down" (one lost ping isn't an outage)
const MAX_DEVICE_ALERTS: usize = 5;
const VPN_FRESH_SECS: u64 = 180;

/// Which kinds are on unless the user changed them.
pub fn default_on(kind: &str) -> bool {
    // "ids-block" isn't an alert: it's the opt-in automatic blocking of attackers
    kind != "vpn" && kind != "ids-block"
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct State {
    fails: u32,
    first_fail: Option<u64>,
    down_since: Option<u64>,
    known: Option<Vec<String>>,
    ddns_bad: Vec<String>,
    uptime: Option<u64>,
    vpn_on: Option<Vec<String>>,
    watch_fails: HashMap<String, u32>,
    watch_down: HashMap<String, u64>,
}

#[derive(Clone, Debug)]
pub struct Device {
    pub mac: String,
    pub ip: String,
    pub name: String,
}

#[derive(Clone, Debug)]
pub struct Peer {
    pub key: String,
    pub name: String,
    pub handshake: u64,
}

#[derive(Clone, Debug)]
pub struct Watched {
    pub key: String,
    pub name: String,
    pub ok: Option<bool>,
}

/// One look at the router; `None` = not checked this time.
#[derive(Default)]
pub struct Snapshot {
    pub at: u64, // unix ms
    pub internet_ok: Option<bool>,
    pub devices: Option<Vec<Device>>,
    pub ddns: Option<Vec<(String, String)>>, // (host, status)
    pub uptime: Option<u64>,
    pub vpn: Option<Vec<Peer>>,
    pub watch: Option<Vec<Watched>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Alert {
    pub kind: String,
    pub text: String,
    pub level: String,
    pub at: u64,
}

fn is_ddns_bad(status: &str) -> bool {
    let s = status.to_ascii_lowercase();
    [
        "fail",
        "bad",
        "abuse",
        "noconnect",
        "nohost",
        "notfqdn",
        "error",
        "911",
        "dnserr",
    ]
    .iter()
    .any(|w| s.contains(w))
}

pub fn duration(ms: u64) -> String {
    let m = ms / 60_000;
    if m < 1 {
        return "less than a minute".into();
    }
    if m < 60 {
        return format!("{m} min");
    }
    let hrs = m / 60;
    if hrs < 48 {
        return if m % 60 > 0 {
            format!("{hrs} h {} min", m % 60)
        } else {
            format!("{hrs} h")
        };
    }
    format!("{} days", hrs / 24)
}

/// Compares `now` with `prev`; returns the new state and what to report.
pub fn evaluate(prev: &State, now: &Snapshot) -> (State, Vec<Alert>) {
    let mut st = prev.clone();
    let mut out = Vec::new();
    let mut add = |kind: &str, text: String, level: &str| {
        out.push(Alert {
            kind: kind.into(),
            text,
            level: level.into(),
            at: now.at,
        })
    };

    match now.internet_ok {
        Some(true) => {
            if let Some(since) = prev.down_since {
                add(
                    "internet",
                    format!(
                        "Internet is back (down for {}).",
                        duration(now.at.saturating_sub(since))
                    ),
                    "ok",
                );
            }
            st.fails = 0;
            st.down_since = None;
        }
        Some(false) => {
            st.fails = prev.fails + 1;
            if st.fails == FAILS_FOR_DOWN && prev.down_since.is_none() {
                st.down_since = Some(prev.first_fail.unwrap_or(now.at));
                add(
                    "internet",
                    "Internet is down: the router can't reach the internet.".into(),
                    "bad",
                );
            }
            if st.fails == 1 {
                st.first_fail = Some(now.at);
            }
        }
        None => {}
    }

    if let Some(devices) = &now.devices {
        let known: HashSet<&String> = prev.known.iter().flatten().collect();
        let mut seen = HashSet::new();
        let fresh: Vec<&Device> = devices
            .iter()
            .filter(|d| !d.mac.is_empty() && !known.contains(&d.mac) && seen.insert(d.mac.clone()))
            .collect();
        if prev.known.is_some() {
            for d in fresh.iter().take(MAX_DEVICE_ALERTS) {
                let what = [d.ip.as_str(), d.mac.as_str()]
                    .iter()
                    .filter(|s| !s.is_empty())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ");
                let name = if d.name.is_empty() {
                    "unnamed device"
                } else {
                    d.name.as_str()
                };
                add(
                    "device",
                    format!("New device joined: {name} ({what})."),
                    "info",
                );
            }
            if fresh.len() > MAX_DEVICE_ALERTS {
                add(
                    "device",
                    format!("…and {} more new devices.", fresh.len() - MAX_DEVICE_ALERTS),
                    "info",
                );
            }
        }
        let mut all: Vec<String> = prev.known.clone().unwrap_or_default();
        all.extend(fresh.iter().map(|d| d.mac.clone()));
        st.known = Some(all);
    }

    if let Some(ddns) = &now.ddns {
        let bad: HashSet<&String> = prev.ddns_bad.iter().collect();
        let mut now_bad = Vec::new();
        for (host, status) in ddns {
            if is_ddns_bad(status) {
                now_bad.push(host.clone());
                if !bad.contains(host) {
                    add("ddns", format!("Dynamic DNS couldn't update {host} ({status}). Devices using this name may not find your router."), "bad");
                }
            } else if bad.contains(host) && !status.is_empty() {
                add(
                    "ddns",
                    format!("Dynamic DNS for {host} is working again."),
                    "ok",
                );
            }
        }
        st.ddns_bad = now_bad;
    }

    if let Some(up) = now.uptime {
        if prev.uptime.is_some_and(|p| up < p) {
            add(
                "reboot",
                format!("The router restarted (up for {}).", duration(up * 1000)),
                "warn",
            );
        }
        st.uptime = Some(up);
    }

    if let Some(vpn) = &now.vpn {
        let was: HashSet<&String> = prev.vpn_on.iter().flatten().collect();
        let on: Vec<&Peer> = vpn
            .iter()
            .filter(|p| {
                p.handshake > 0 && (now.at / 1000).saturating_sub(p.handshake) < VPN_FRESH_SECS
            })
            .collect();
        if prev.vpn_on.is_some() {
            for p in &on {
                if !was.contains(&p.key) {
                    let name = if p.name.is_empty() {
                        "A VPN device"
                    } else {
                        p.name.as_str()
                    };
                    add("vpn", format!("{name} connected to the VPN."), "info");
                }
            }
        }
        st.vpn_on = Some(on.iter().map(|p| p.key.clone()).collect());
    }

    if let Some(watch) = &now.watch {
        let mut fails = prev.watch_fails.clone();
        let mut down = prev.watch_down.clone();
        for w in watch {
            match w.ok {
                Some(true) => {
                    if let Some(since) = down.remove(&w.key) {
                        add(
                            "watch",
                            format!(
                                "{} is reachable again (down for {}).",
                                w.name,
                                duration(now.at.saturating_sub(since))
                            ),
                            "ok",
                        );
                    }
                    fails.remove(&w.key);
                }
                Some(false) => {
                    let f = fails.entry(w.key.clone()).or_insert(0);
                    *f += 1;
                    if *f == FAILS_FOR_DOWN && !down.contains_key(&w.key) {
                        down.insert(w.key.clone(), now.at);
                        add("watch", format!("{} isn't answering.", w.name), "bad");
                    }
                }
                None => {}
            }
        }
        let keys: HashSet<&String> = watch.iter().map(|w| &w.key).collect();
        fails.retain(|k, _| keys.contains(k));
        down.retain(|k, _| keys.contains(k));
        st.watch_fails = fails;
        st.watch_down = down;
    }

    (st, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(steps: Vec<Snapshot>) -> Vec<Vec<String>> {
        let mut st = State::default();
        steps
            .iter()
            .map(|s| {
                let (n, a) = evaluate(&st, s);
                st = n;
                a.into_iter()
                    .map(|a| format!("{}: {}", a.kind, a.text))
                    .collect()
            })
            .collect()
    }

    #[test]
    fn internet_outage_and_recovery() {
        let min = 60_000;
        let s = |at, ok| Snapshot {
            at,
            internet_ok: Some(ok),
            ..Default::default()
        };
        let out = run(vec![
            s(0, true),
            s(min, false),
            s(2 * min, false),
            s(3 * min, false),
            s(6 * min, true),
            s(7 * min, false),
            s(8 * min, true),
        ]);
        assert!(out[1].is_empty());
        assert_eq!(
            out[2],
            vec!["internet: Internet is down: the router can't reach the internet."]
        );
        assert!(out[3].is_empty());
        assert_eq!(out[4], vec!["internet: Internet is back (down for 5 min)."]);
        assert!(out[5].is_empty() && out[6].is_empty());
    }

    #[test]
    fn devices_learned_then_reported() {
        let d = |mac: &str, ip: &str, name: &str| Device {
            mac: mac.into(),
            ip: ip.into(),
            name: name.into(),
        };
        let a = d("aa:aa:aa:aa:aa:01", "192.168.1.10", "nas");
        let b = d("aa:aa:aa:aa:aa:02", "192.168.1.11", "");
        let s = |at, v: Vec<Device>| Snapshot {
            at,
            devices: Some(v),
            ..Default::default()
        };
        let out = run(vec![
            s(0, vec![a.clone()]),
            s(1, vec![a.clone(), b.clone()]),
            s(2, vec![a, b]),
        ]);
        assert!(out[0].is_empty());
        assert_eq!(
            out[1],
            vec!["device: New device joined: unnamed device (192.168.1.11, aa:aa:aa:aa:aa:02)."]
        );
        assert!(out[2].is_empty());
    }

    #[test]
    fn ddns_reboot_vpn_watch() {
        let ddns = |at, st: &str| Snapshot {
            at,
            ddns: Some(vec![("home.example.com".into(), st.into())]),
            ..Default::default()
        };
        let out = run(vec![
            ddns(0, "good"),
            ddns(1, "badauth"),
            ddns(2, "badauth"),
            ddns(3, "good"),
        ]);
        assert_eq!(out[1].len(), 1);
        assert!(out[1][0].contains("couldn't update home.example.com (badauth)"));
        assert!(out[2].is_empty());
        assert_eq!(
            out[3],
            vec!["ddns: Dynamic DNS for home.example.com is working again."]
        );

        let snap = |at, up, hs| Snapshot {
            at,
            uptime: Some(up),
            vpn: Some(vec![Peer {
                key: "k1".into(),
                name: "phone".into(),
                handshake: hs,
            }]),
            ..Default::default()
        };
        let out = run(vec![
            snap(0, 5000, 0),
            snap(60_000, 5060, 50),
            snap(120_000, 30, 110),
        ]);
        assert!(out[0].is_empty());
        assert_eq!(out[1], vec!["vpn: phone connected to the VPN."]);
        assert_eq!(
            out[2],
            vec!["reboot: The router restarted (up for less than a minute)."]
        );

        let w = |at, ok| Snapshot {
            at,
            watch: Some(vec![Watched {
                key: "nas".into(),
                name: "NAS".into(),
                ok,
            }]),
            ..Default::default()
        };
        let out = run(vec![
            w(0, Some(true)),
            w(60_000, Some(false)),
            w(120_000, Some(false)),
            w(180_000, None),
            w(420_000, Some(true)),
        ]);
        assert!(out[1].is_empty());
        assert_eq!(out[2], vec!["watch: NAS isn't answering."]);
        assert!(out[3].is_empty());
        assert_eq!(
            out[4],
            vec!["watch: NAS is reachable again (down for 5 min)."]
        );
    }

    #[test]
    fn durations() {
        assert_eq!(duration(90 * 60_000), "1 h 30 min");
        assert_eq!(duration(3 * 86_400_000), "3 days");
        assert_eq!(duration(30_000), "less than a minute");
    }
}
