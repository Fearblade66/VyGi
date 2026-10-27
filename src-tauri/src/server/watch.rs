//! 24/7 watching (web server only): for each router the user switched it on
//! for, the server keeps its own connection, checks the router every minute
//! (alerts), records internet traffic, data per device and the system log,
//! and sends alerts to the user's phone (ntfy) or a webhook.
//!
//! Settings live in `<data>/watch.json`; recordings in [`super::history`].

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::watch;

use super::alerts::{self, Alert, Device, Peer, Snapshot, Watched};
use super::history::{DeviceTotal, FlowRec, LogLine, Saved, Store};
use crate::error::{AppError, AppResult};
use crate::ssh::StreamEvent;
use crate::state::{AppState, Out, St, Win, WindowState};
use crate::vyos_api::ConfigCommand;
use crate::{checkup, connection, ids, monitor, sysinfo, transactions, updates};

const CHECK_EVERY: Duration = Duration::from_secs(60);
const BACKUP_EVERY: u64 = 6 * 3600 * 1000;
const UPDATE_CHECK_EVERY: u64 = 24 * 3600 * 1000;

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct WatchHost {
    pub host: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct RouterWatch {
    pub enabled: bool,
    /// alert kind -> on/off (missing = default)
    pub kinds: HashMap<String, bool>,
    pub hosts: Vec<WatchHost>,
    /// the router's name, for notifications
    pub name: String,
}

impl RouterWatch {
    fn on(&self, kind: &str) -> bool {
        self.kinds
            .get(kind)
            .copied()
            .unwrap_or_else(|| alerts::default_on(kind))
    }
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct Notify {
    /// e.g. https://ntfy.sh/my-secret-topic
    pub ntfy_url: String,
    pub ntfy_token: String,
    /// Discord, Slack-compatible or any URL that takes a JSON POST
    pub webhook_url: String,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct WatchConfig {
    pub routers: HashMap<String, RouterWatch>,
    pub notify: Notify,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub connected: bool,
    pub last_check: Option<u64>,
    pub error: Option<String>,
}

struct Running {
    stop: watch::Sender<bool>,
    status: Arc<StdMutex<Status>>,
}

pub struct Watcher {
    app: Arc<AppState>,
    base: PathBuf,
    cfg_path: PathBuf,
    cfg: StdMutex<WatchConfig>,
    running: StdMutex<HashMap<String, Running>>,
    keep_days: u64,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn lock<T>(m: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Watcher {
    pub fn new(app: Arc<AppState>, data: &std::path::Path, keep_days: u64) -> Arc<Self> {
        let cfg_path = data.join("watch.json");
        let cfg: WatchConfig = std::fs::read_to_string(&cfg_path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        Arc::new(Watcher {
            app,
            base: data.join("history"),
            cfg_path,
            cfg: StdMutex::new(cfg),
            running: StdMutex::new(HashMap::new()),
            keep_days,
        })
    }

    /// Starts watching every router that has it switched on.
    pub fn start_all(self: &Arc<Self>) {
        let ids: Vec<String> = lock(&self.cfg)
            .routers
            .iter()
            .filter(|(_, r)| r.enabled)
            .map(|(k, _)| k.clone())
            .collect();
        for id in ids {
            self.spawn(&id);
        }
    }

    fn save(&self) -> AppResult<()> {
        let text = serde_json::to_string_pretty(&*lock(&self.cfg))?;
        super::auth::write_private(&self.cfg_path, text.as_bytes()).map_err(AppError::Io)
    }

    fn spawn(self: &Arc<Self>, id: &str) {
        let mut running = lock(&self.running);
        if running.contains_key(id) {
            return;
        }
        let (stop, rx) = watch::channel(false);
        let status = Arc::new(StdMutex::new(Status {
            running: true,
            ..Default::default()
        }));
        running.insert(
            id.to_string(),
            Running {
                stop,
                status: status.clone(),
            },
        );
        let me = self.clone();
        let id = id.to_string();
        tokio::spawn(async move { me.router_task(id, status, rx).await });
    }

    fn stop(&self, id: &str) {
        if let Some(r) = lock(&self.running).remove(id) {
            let _ = r.stop.send(true);
        }
    }

    pub fn router(&self, id: &str) -> RouterWatch {
        lock(&self.cfg).routers.get(id).cloned().unwrap_or_default()
    }

    pub fn status(&self, id: &str) -> Status {
        lock(&self.running)
            .get(id)
            .map(|r| lock(&r.status).clone())
            .unwrap_or_default()
    }

    pub fn notify_settings(&self) -> Notify {
        lock(&self.cfg).notify.clone()
    }

    /// The newest alerts of every watched router, newest first:
    /// (router name, alert). For the Android app's notifications.
    pub fn recent_alerts(&self, since: u64, limit: usize) -> Vec<(String, Alert)> {
        let routers: Vec<(String, String)> = lock(&self.cfg)
            .routers
            .iter()
            .filter(|(_, r)| r.enabled)
            .map(|(id, r)| {
                (
                    id.clone(),
                    if r.name.is_empty() {
                        id.clone()
                    } else {
                        r.name.clone()
                    },
                )
            })
            .collect();
        let mut all: Vec<(String, Alert)> = routers
            .into_iter()
            .flat_map(|(id, name)| {
                self.store(&id)
                    .alerts(since, limit)
                    .into_iter()
                    .map(move |a| (name.clone(), a))
            })
            .collect();
        all.sort_by_key(|(_, a)| std::cmp::Reverse(a.at));
        all.truncate(limit);
        all
    }

    pub fn store(&self, id: &str) -> Store {
        Store::new(&self.base, id)
    }

    /// Changes a router's watching; starts or stops it.
    pub fn set_router(self: &Arc<Self>, id: &str, mut rw: RouterWatch) -> AppResult<()> {
        rw.hosts.retain(|h| valid_host(&h.host));
        rw.hosts.truncate(50);
        let enabled = rw.enabled;
        lock(&self.cfg).routers.insert(id.to_string(), rw);
        self.save()?;
        if enabled {
            self.spawn(id);
        } else {
            self.stop(id);
        }
        Ok(())
    }

    pub fn set_notify(&self, n: Notify) -> AppResult<()> {
        for u in [&n.ntfy_url, &n.webhook_url] {
            if !u.is_empty() && !(u.starts_with("https://") || u.starts_with("http://")) {
                return Err(AppError::Invalid(format!(
                    "{u} isn't a web address (http:// or https://)"
                )));
            }
        }
        lock(&self.cfg).notify = n;
        self.save()
    }

    /// Sends alerts to the phone / webhook. Returns the first error.
    pub async fn notify(&self, router: &str, list: &[Alert]) -> AppResult<()> {
        let n = self.notify_settings();
        if list.is_empty() || (n.ntfy_url.is_empty() && n.webhook_url.is_empty()) {
            return Ok(());
        }
        let client = crate::tls::public_client(Duration::from_secs(15))?;
        let title = format!("VyGi: {router}");
        let mut first_err = None;
        for a in list {
            if !n.ntfy_url.is_empty() {
                let (prio, tag) = match a.level.as_str() {
                    "bad" => ("high", "warning"),
                    "warn" => ("default", "warning"),
                    "ok" => ("default", "white_check_mark"),
                    _ => ("default", "information_source"),
                };
                let mut req = client
                    .post(&n.ntfy_url)
                    .header("Title", &title)
                    .header("Priority", prio)
                    .header("Tags", tag)
                    .body(a.text.clone());
                if !n.ntfy_token.is_empty() {
                    req = req.bearer_auth(&n.ntfy_token);
                }
                if let Err(e) = req.send().await.and_then(|r| r.error_for_status()) {
                    first_err.get_or_insert(format!("ntfy: {e}"));
                }
            }
            if !n.webhook_url.is_empty() {
                let body = if n.webhook_url.contains("discord.com/api/webhooks")
                    || n.webhook_url.contains("discordapp.com/api/webhooks")
                {
                    json!({ "content": format!("**{title}** {}", a.text) })
                } else if n.webhook_url.contains("hooks.slack.com") {
                    json!({ "text": format!("*{title}* {}", a.text) })
                } else {
                    json!({ "title": title, "text": a.text, "level": a.level, "kind": a.kind, "at": a.at })
                };
                if let Err(e) = client
                    .post(&n.webhook_url)
                    .json(&body)
                    .send()
                    .await
                    .and_then(|r| r.error_for_status())
                {
                    first_err.get_or_insert(format!("webhook: {e}"));
                }
            }
        }
        match first_err {
            Some(e) => Err(AppError::Api(e)),
            None => Ok(()),
        }
    }

    async fn connect(&self, ws: &Arc<WindowState>, id: &str) -> AppResult<String> {
        connect_saved(&self.app, ws, id).await
    }

    async fn router_task(
        self: Arc<Self>,
        id: String,
        status: Arc<StdMutex<Status>>,
        mut stop: watch::Receiver<bool>,
    ) {
        let store = Arc::new(self.store(&id));
        let mut backoff = 30;
        loop {
            if *stop.borrow() {
                break;
            }
            let ws = Arc::new(WindowState::default());
            let host = match self.connect(&ws, &id).await {
                Ok(h) => {
                    backoff = 30;
                    let mut s = lock(&status);
                    s.connected = true;
                    s.error = None;
                    h
                }
                Err(e) => {
                    {
                        let mut s = lock(&status);
                        s.connected = false;
                        s.error = Some(e.to_string());
                    }
                    if stopped(&mut stop, Duration::from_secs(backoff)).await {
                        break;
                    }
                    backoff = (backoff * 2).min(240); // short enough to confirm an update in time
                    continue;
                }
            };
            // back after a VyOS update: reaching the router is what keeps the new version
            if let Ok(conn) = ws.conn().await {
                if let Ok(Some(new)) = crate::upgrade::confirm_if_pending(&conn.ssh).await {
                    let a = Alert {
                        kind: "update".into(),
                        text: format!("VyOS {new} is running and VyGi reaches the router: the update is kept."),
                        level: "ok".into(),
                        at: now_ms(),
                    };
                    store.add_alerts(std::slice::from_ref(&a));
                    let name = self.router(&id).name;
                    let _ = self
                        .notify(if name.is_empty() { &host } else { &name }, &[a])
                        .await;
                }
            }
            let mut saved = store.load();
            let cursor = Arc::new(StdMutex::new(saved.cursor.clone()));
            let journal = start_journal(&ws, store.clone(), cursor.clone()).await;
            let mut ctx = Counters::default();
            let mut last_cleanup = 0u64;
            loop {
                if ws.conn().await.is_err() {
                    break;
                }
                let rw = self.router(&id);
                let name = if rw.name.is_empty() {
                    host.clone()
                } else {
                    rw.name.clone()
                };
                let snap = snapshot(&ws, &rw).await;
                let (next, found) = alerts::evaluate(&saved.alerts, &snap);
                saved.alerts = next;
                let found: Vec<Alert> = found.into_iter().filter(|a| rw.on(&a.kind)).collect();
                store.add_alerts(&found);
                if let Err(e) = self.notify(&name, &found).await {
                    lock(&status).error = Some(format!("Couldn't send a notification: {e}"));
                }
                record_traffic(&ws, &store, &mut ctx, snap.devices.as_deref()).await;
                let ids_found: Vec<Alert> = watch_ids(&ws, &rw, &mut saved)
                    .await
                    .into_iter()
                    .filter(|a| rw.on(&a.kind))
                    .collect();
                if !ids_found.is_empty() {
                    store.add_alerts(&ids_found);
                    if let Err(e) = self.notify(&name, &ids_found).await {
                        lock(&status).error = Some(format!("Couldn't send a notification: {e}"));
                    }
                }
                upkeep(&self.app, &ws, &rw, &store, &mut saved).await;
                saved.cursor = lock(&cursor).clone();
                store.save(&saved);
                let now = now_ms();
                if now - last_cleanup > 6 * 3600 * 1000 {
                    store.cleanup(now, self.keep_days);
                    last_cleanup = now;
                }
                lock(&status).last_check = Some(now);
                if stopped(&mut stop, CHECK_EVERY).await {
                    if let Some(j) = journal {
                        let _ = monitor::close_session(Win(ws.clone()), j).await;
                    }
                    ws.disconnect().await;
                    lock(&status).running = false;
                    return;
                }
            }
            {
                let mut s = lock(&status);
                s.connected = false;
                s.error = Some("Lost the connection to the router; reconnecting".into());
            }
            ws.disconnect().await;
            if stopped(&mut stop, Duration::from_secs(10)).await {
                break;
            }
        }
        lock(&status).running = false;
    }
}

/// Automatic upkeep: a backup when the config changed (checked every few
/// hours, so changes made outside VyGi are kept too) and a daily VyOS update
/// check that alerts once per new version.
async fn upkeep(
    app: &AppState,
    ws: &WindowState,
    rw: &RouterWatch,
    store: &Store,
    saved: &mut Saved,
) {
    let Ok(conn) = ws.conn().await else { return };
    let _ = checkup::sync_accounting(&conn).await;
    let now = now_ms();
    if now.saturating_sub(saved.last_backup) > BACKUP_EVERY
        && checkup::backup_if_changed(&app.dirs, &conn).await.is_ok()
    {
        saved.last_backup = now;
    }
    if now.saturating_sub(saved.last_update_check) > UPDATE_CHECK_EVERY {
        saved.last_update_check = now;
        if let Ok(u) = updates::check(&conn).await {
            if u.available && u.remote != saved.update_seen {
                saved.update_seen = u.remote.clone();
                if rw.on("update") {
                    store.add_alerts(&[Alert {
                        kind: "update".into(),
                        text: format!("VyOS update available: {} (running {}). Install it from the Simple page.", u.remote, u.local),
                        level: "info".into(),
                        at: now,
                    }]);
                }
            }
        }
    }
}

/// Connects `ws` to a saved router with its saved password and key (and the
/// fingerprints trusted earlier). Returns the router's host name.
pub async fn connect_saved(
    app: &Arc<AppState>,
    ws: &Arc<WindowState>,
    id: &str,
) -> AppResult<String> {
    let profile = app.profiles.find(id)?;
    let req = serde_json::from_value(json!({ "profile": profile, "remember": false }))?;
    match connection::connect(St(app.clone()), Win(ws.clone()), req).await {
        Ok(info) => Ok(serde_json::to_value(&info)?["hostname"]
            .as_str()
            .unwrap_or(id)
            .to_string()),
        Err(e @ (AppError::UntrustedCert { .. } | AppError::UntrustedHostKey { .. })) => {
            Err(AppError::Invalid(format!(
            "{e}. Connect to this router from VyGi once (and trust it) so the server can use it."
        )))
        }
        Err(e) => Err(e),
    }
}

/// Waits; true if watching was switched off meanwhile.
async fn stopped(stop: &mut watch::Receiver<bool>, d: Duration) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(d) => *stop.borrow(),
        r = stop.changed() => r.is_err() || *stop.borrow(),
    }
}

fn valid_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && !h.starts_with('-')
        && h.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '-'))
}

/// Follows the router's journal, appending lines to the log files and
/// remembering the position. Returns the stream's session id.
async fn start_journal(
    ws: &Arc<WindowState>,
    store: Arc<Store>,
    cursor: Arc<StdMutex<Option<String>>>,
) -> Option<u32> {
    let pending = Arc::new(StdMutex::new(String::new()));
    let kind =
        serde_json::from_value(json!({ "type": "journal", "cursor": lock(&cursor).clone() }))
            .ok()?;
    let out = Out::new(move |ev: StreamEvent| {
        let StreamEvent::Data(text) = ev else {
            return true;
        };
        let mut buf = lock(&pending);
        buf.push_str(&text);
        let mut lines = Vec::new();
        while let Some(i) = buf.find('\n') {
            let line: String = buf.drain(..=i).collect();
            if let Some((l, c)) = parse_journal(line.trim()) {
                lines.push(l);
                *lock(&cursor) = Some(c);
            }
        }
        if buf.len() > 1_000_000 {
            buf.clear(); // a runaway line; drop it
        }
        drop(buf);
        store.add_logs(&lines);
        true
    });
    monitor::open_stream(Win(ws.clone()), kind, out).await.ok()
}

/// One `journalctl -o json` line -> (log line, cursor).
fn parse_journal(line: &str) -> Option<(LogLine, String)> {
    let v: Value = serde_json::from_str(line).ok()?;
    let cursor = v["__CURSOR"].as_str()?.to_string();
    let t = v["__REALTIME_TIMESTAMP"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .map(|us| us / 1000)?;
    let m = match &v["MESSAGE"] {
        Value::String(s) => s.clone(),
        // non-UTF-8 messages come as byte arrays
        Value::Array(b) => String::from_utf8_lossy(
            &b.iter()
                .filter_map(|x| x.as_u64().map(|n| n as u8))
                .collect::<Vec<_>>(),
        )
        .into_owned(),
        _ => return None,
    };
    let p = v["PRIORITY"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(6);
    let id = v["SYSLOG_IDENTIFIER"]
        .as_str()
        .or_else(|| v["_COMM"].as_str())
        .unwrap_or("")
        .to_string();
    Some((LogLine { t, p, id, m }, cursor))
}

/// One look at the router for the alert checks.
async fn snapshot(ws: &Arc<WindowState>, rw: &RouterWatch) -> Snapshot {
    let w = || Win(ws.clone());
    let mut s = Snapshot {
        at: now_ms(),
        ..Default::default()
    };
    let ping = |target: String| {
        let ws = ws.clone();
        async move {
            match sysinfo::ping_latency(Win(ws), target)
                .await
                .and_then(|l| Ok(serde_json::to_value(l)?))
            {
                Ok(v) => Some(v["lossPercent"].as_f64().is_some_and(|x| x < 100.0)),
                Err(_) => None,
            }
        }
    };
    if rw.on("internet") {
        s.internet_ok = match ping("1.1.1.1".into()).await {
            Some(true) => Some(true),
            Some(false) => ping("9.9.9.9".into()).await,
            None => None,
        };
    }
    // devices are also needed for data-per-device names, so always look
    if let Ok(neigh) = sysinfo::neighbors(w()).await {
        let leases = sysinfo::dhcp_leases(w(), 4).await.unwrap_or(Value::Null);
        let names: HashMap<String, String> = leases
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|l| {
                Some((
                    l["mac"].as_str()?.to_lowercase(),
                    l["hostname"].as_str().unwrap_or("").to_string(),
                ))
            })
            .collect();
        let mut devices: Vec<Device> = Vec::new();
        for n in neigh.as_array().into_iter().flatten() {
            let (Some(mac), Some(ip)) = (n["lladdr"].as_str(), n["dst"].as_str()) else {
                continue;
            };
            let state = n["state"].to_string();
            if ip.contains(':') || state.contains("FAILED") || state.contains("INCOMPLETE") {
                continue;
            }
            let mac = mac.to_lowercase();
            if devices.iter().any(|d| d.mac == mac) {
                continue;
            }
            devices.push(Device {
                name: names.get(&mac).cloned().unwrap_or_default(),
                mac,
                ip: ip.to_string(),
            });
        }
        s.devices = Some(devices);
    }
    if rw.on("ddns") {
        let configured =
            transactions::get_config(w(), vec!["service".into(), "dns".into(), "dynamic".into()])
                .await
                .map(|v| v.as_object().is_some_and(|o| !o.is_empty()))
                .unwrap_or(false);
        if configured {
            if let Ok(raw) = sysinfo::ddns_status(w()).await {
                let list = if raw.is_array() { raw } else { json!([raw]) };
                s.ddns = Some(
                    list.as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|e| {
                            let host = e["host"].as_str()?.to_string();
                            let st = e["status-ipv4"]
                                .as_str()
                                .or_else(|| e["status-ipv6"].as_str())
                                .unwrap_or("")
                                .to_string();
                            Some((host, st))
                        })
                        .collect(),
                );
            }
        }
    }
    if rw.on("reboot") {
        if let Ok(l) = sysinfo::system_load(w()).await {
            s.uptime = serde_json::to_value(l)
                .ok()
                .and_then(|v| v["uptimeSecs"].as_u64());
        }
    }
    if rw.on("vpn") {
        if let Ok(dump) = monitor::wireguard_dump(w()).await {
            let wg = transactions::get_config(w(), vec!["interfaces".into(), "wireguard".into()])
                .await
                .ok()
                .and_then(|v| v.as_object().cloned())
                .unwrap_or_default();
            // VyGi's VPN clients connect to a provider: that's not a device on your VPN
            let tunnels: Vec<String> = wg
                .iter()
                .filter(|(_, c)| {
                    c["description"]
                        .as_str()
                        .is_some_and(|d| d.starts_with("VyGi VPN client: "))
                })
                .map(|(i, _)| i.clone())
                .collect();
            let names: HashMap<String, String> = wg
                .into_iter()
                .flat_map(|(_, ifc)| {
                    ifc["peer"]
                        .as_object()
                        .cloned()
                        .into_iter()
                        .flatten()
                        .map(|(n, p)| (p["public-key"].as_str().unwrap_or("").to_string(), n))
                })
                .collect();
            s.vpn = Some(
                dump.lines()
                    .map(|l| l.split('\t').collect::<Vec<_>>())
                    .filter(|f| f.len() == 9 && !tunnels.iter().any(|t| t == f[0]))
                    .map(|f| Peer {
                        name: names.get(f[1]).cloned().unwrap_or_else(|| f[4].to_string()),
                        key: f[1].to_string(),
                        handshake: f[5].parse().unwrap_or(0),
                    })
                    .collect(),
            );
        }
    }
    if rw.on("watch") && !rw.hosts.is_empty() {
        let mut list = Vec::new();
        for h in &rw.hosts {
            let ok = ping(h.host.clone()).await;
            let name = if h.name.is_empty() {
                h.host.clone()
            } else {
                format!("{} ({})", h.name, h.host)
            };
            list.push(Watched {
                key: h.host.clone(),
                name,
                ok,
            });
        }
        s.watch = Some(list);
    }
    s
}

/// The address group VyGi's automatic attacker blocks go into (the
/// Intrusion detection settings create the rules that drop it).
pub const IDS_BLOCK_GROUP: &str = "VYGI-IDS-BLOCK";
const IDS_BLOCK_MS: u64 = 24 * 3600 * 1000;

/// Intrusion detection: new serious alerts (priority 1-2) as alerts, grouped
/// by attack and source; with automatic blocking on, internet addresses
/// behind a priority-1 attack are blocked for 24 hours. Expired blocks go.
async fn watch_ids(ws: &WindowState, rw: &RouterWatch, saved: &mut Saved) -> Vec<Alert> {
    let Ok(conn) = ws.conn().await else {
        return Vec::new();
    };
    let Ok(Some((list, offset))) = ids::new_alerts(&conn, saved.ids_offset).await else {
        return Vec::new();
    };
    saved.ids_offset = offset;
    let before = saved.ids_blocked.clone();
    let (alerts, cmds) = ids_decide(&list, &mut saved.ids_blocked, rw.on("ids-block"), now_ms());
    // on its own (not Safe Mode): a short-lived block; if a change is waiting for Confirm, try again next time
    if !cmds.is_empty() && conn.api.configure(&cmds, 0).await.is_err() {
        saved.ids_blocked = before;
    }
    alerts
}

/// What to do with new IDS alerts: alerts for priority 1-2 (grouped by attack
/// and source), and with `auto_block` the commands that block internet
/// addresses behind a priority-1 attack for 24 hours and unblock expired ones.
/// `blocked` is updated as if the commands succeed.
fn ids_decide(
    list: &[ids::IdsAlert],
    blocked: &mut Vec<(String, u64)>,
    auto_block: bool,
    now: u64,
) -> (Vec<Alert>, Vec<ConfigCommand>) {
    let mut cmds = Vec::new();
    let path = |ip: &str| {
        vec![
            "firewall".to_string(),
            "group".into(),
            "address-group".into(),
            IDS_BLOCK_GROUP.into(),
            "address".into(),
            ip.to_string(),
        ]
    };
    blocked.retain(|(ip, until)| {
        let keep = *until > now;
        if !keep {
            cmds.push(ConfigCommand {
                op: "delete".into(),
                path: path(ip),
                value: None,
            });
        }
        keep
    });
    let mut grouped: Vec<(&ids::IdsAlert, u32)> = Vec::new();
    for a in list.iter().filter(|a| a.priority <= 2) {
        match grouped
            .iter_mut()
            .find(|(g, _)| g.sid == a.sid && g.src == a.src)
        {
            Some((_, n)) => *n += 1,
            None => grouped.push((a, 1)),
        }
    }
    let mut out = Vec::new();
    for (a, n) in grouped {
        let public = a.src.parse::<Ipv4Addr>().is_ok_and(|ip| {
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || (ip.octets()[0] == 100 && (ip.octets()[1] & 0xc0) == 64) // carrier-grade NAT
                || ip.is_unspecified())
        });
        let mut now_blocked = false;
        if auto_block && a.priority == 1 && public && !blocked.iter().any(|(ip, _)| *ip == a.src) {
            blocked.push((a.src.clone(), now + IDS_BLOCK_MS));
            cmds.push(ConfigCommand {
                op: "set".into(),
                path: path(&a.src),
                value: None,
            });
            now_blocked = true;
        }
        out.push(Alert {
            kind: "ids".into(),
            text: format!(
                "Intrusion detection: {} ({}{} → {}:{}){}",
                a.msg,
                if n > 1 {
                    format!("{n}× from ")
                } else {
                    "from ".into()
                },
                a.src,
                a.dst,
                a.dport,
                if now_blocked {
                    ". Blocked that address for 24 hours."
                } else {
                    ""
                }
            ),
            level: if a.priority == 1 {
                "bad".into()
            } else {
                "warn".into()
            },
            at: a.t,
        });
    }
    (out, cmds)
}

/// Previous counters, to turn totals into per-minute amounts.
#[derive(Default)]
struct Counters {
    wan: Option<(u64, String, u64, u64)>, // (at ms, interface, rx, tx)
    flows: Option<HashMap<String, (u64, u64)>>,
    /// connections seen and still open (Flows), by kernel id
    open: HashMap<String, FlowRec>,
}

/// Follows connections between looks: returns the ones that ended since the
/// last look (identical ones that ended together merged). Connections to the
/// router itself (mostly DNS) are left out; a port forward is recorded from
/// the internet address to the device it reached.
fn track_flows(
    open: &mut HashMap<String, FlowRec>,
    flows: &[Value],
    own: &std::collections::HashSet<String>,
    now: u64,
) -> Vec<FlowRec> {
    let mut seen = std::collections::HashSet::new();
    for f in flows {
        let s = |k: &str| f[k].as_str().unwrap_or("").to_string();
        let (id, src, dst, reply_src) = (s("id"), s("src"), s("dst"), s("replySrc"));
        if id.is_empty() || own.contains(&src) {
            continue;
        }
        let to = if own.contains(&dst) && is_lan(&reply_src) && !own.contains(&reply_src) {
            reply_src // a port forward: it really went to the device behind the router
        } else {
            dst
        };
        if own.contains(&to) || !(is_lan(&src) || is_lan(&to)) {
            continue;
        }
        seen.insert(id.clone());
        let e = open.entry(id).or_insert_with(|| FlowRec {
            t: now,
            f: now,
            s: src,
            d: to,
            p: f["dport"]
                .as_str()
                .and_then(|p| p.parse().ok())
                .unwrap_or(0),
            pr: s("proto"),
            up: 0,
            down: 0,
            n: 1,
        });
        e.t = now;
        e.up = f["origBytes"].as_u64().unwrap_or(e.up);
        e.down = f["replyBytes"].as_u64().unwrap_or(e.down);
    }
    let ended: Vec<String> = open
        .keys()
        .filter(|id| !seen.contains(*id))
        .cloned()
        .collect();
    let mut merged: Vec<FlowRec> = Vec::new();
    for id in ended {
        let Some(f) = open.remove(&id) else { continue };
        match merged
            .iter_mut()
            .find(|m| m.s == f.s && m.d == f.d && m.p == f.p && m.pr == f.pr)
        {
            Some(m) => {
                m.n += 1;
                m.up += f.up;
                m.down += f.down;
                m.f = m.f.min(f.f);
                m.t = m.t.max(f.t);
            }
            None => merged.push(f),
        }
    }
    merged
}

fn is_lan(ip: &str) -> bool {
    ip.parse::<Ipv4Addr>().is_ok_and(|a| a.is_private())
}

async fn record_traffic(
    ws: &Arc<WindowState>,
    store: &Store,
    ctx: &mut Counters,
    devices: Option<&[Device]>,
) {
    let w = || Win(ws.clone());
    let now = now_ms();
    // internet traffic: the default route's interface counters
    let wan = monitor::routes(w(), 4, Some("default".into()))
        .await
        .ok()
        .and_then(|r| {
            let d = r
                .as_array()?
                .iter()
                .find(|x| x["dst"] == "default")?
                .clone();
            d["dev"]
                .as_str()
                .or_else(|| d["nexthops"][0]["dev"].as_str())
                .map(str::to_string)
        });
    let stats = monitor::interface_stats(w()).await.ok();
    // the router's own addresses aren't devices
    let own: std::collections::HashSet<String> = stats
        .as_ref()
        .and_then(|s| s["addrs"].as_array().cloned())
        .into_iter()
        .flatten()
        .flat_map(|a| a["addr_info"].as_array().cloned().unwrap_or_default())
        .filter_map(|i| i["local"].as_str().map(str::to_string))
        .collect();
    if let (Some(wan), Some(stats)) = (wan, stats) {
        let link = stats["links"]
            .as_array()
            .and_then(|l| l.iter().find(|x| x["ifname"] == wan.as_str()).cloned());
        if let Some(link) = link {
            let rx = link["stats64"]["rx"]["bytes"].as_u64().unwrap_or(0);
            let tx = link["stats64"]["tx"]["bytes"].as_u64().unwrap_or(0);
            if let Some((t0, ref if0, rx0, tx0)) = ctx.wan {
                let secs = (now - t0) as f64 / 1000.0;
                if *if0 == wan && rx >= rx0 && tx >= tx0 && secs > 1.0 {
                    store.add_wan(
                        now,
                        (rx - rx0) as f64 * 8.0 / secs,
                        (tx - tx0) as f64 * 8.0 / secs,
                    );
                }
            }
            ctx.wan = Some((now, wan, rx, tx));
        }
    }
    // data per device, from connection counters (needs traffic counting on the router)
    let Ok(flows) = sysinfo::connections(w()).await else {
        return;
    };
    let Ok(Value::Array(flows)) = serde_json::to_value(flows) else {
        return;
    };
    store.add_flows(&track_flows(&mut ctx.open, &flows, &own, now));
    let mut cur: HashMap<String, (u64, u64)> = HashMap::new();
    let mut per_ip: HashMap<String, (u64, u64)> = HashMap::new();
    for f in &flows {
        let (Some(id), Some(src)) = (f["id"].as_str(), f["src"].as_str()) else {
            continue;
        };
        let up = f["origBytes"].as_u64().unwrap_or(0);
        let down = f["replyBytes"].as_u64().unwrap_or(0);
        if id.is_empty() || (up == 0 && down == 0) {
            continue;
        }
        cur.insert(id.to_string(), (up, down));
        let Some(prev) = &ctx.flows else { continue };
        if !is_lan(src) || own.contains(src) {
            continue;
        }
        let (u0, d0) = prev.get(id).copied().unwrap_or((0, 0));
        let du = if up >= u0 { up - u0 } else { up };
        let dd = if down >= d0 { down - d0 } else { down };
        let e = per_ip.entry(src.to_string()).or_default();
        e.0 += du;
        e.1 += dd;
    }
    let first = ctx.flows.is_none(); // the first look only sets the baseline
    ctx.flows = Some(cur);
    if first {
        return;
    }
    let by_ip: HashMap<&str, &Device> = devices
        .unwrap_or(&[])
        .iter()
        .map(|d| (d.ip.as_str(), d))
        .collect();
    let totals: HashMap<String, DeviceTotal> = per_ip
        .into_iter()
        .filter(|(_, (u, d))| u + d > 0)
        .map(|(ip, (up, down))| {
            let dev = by_ip.get(ip.as_str());
            let key = dev.map(|d| d.mac.clone()).unwrap_or_else(|| ip.clone());
            (
                key,
                DeviceTotal {
                    name: dev.map(|d| d.name.clone()).unwrap_or_default(),
                    ip,
                    down,
                    up,
                },
            )
        })
        .collect();
    store.add_devices(now, &totals);
}

#[cfg(test)]
mod tests {
    #[test]
    fn ids_alerts_and_blocking() {
        let alert = |src: &str, p: u8, sid: &str| ids::IdsAlert {
            t: 1,
            sid: sid.into(),
            msg: "ET X".into(),
            class: String::new(),
            priority: p,
            proto: "tcp".into(),
            src: src.into(),
            sport: 1,
            dst: "203.0.113.5".into(),
            dport: 22,
            dropped: false,
        };
        let list = [
            alert("198.51.100.66", 1, "9"),
            alert("198.51.100.66", 1, "9"),
            alert("10.20.2.42", 1, "9"),
            alert("100.64.1.1", 1, "9"),
            alert("8.8.8.8", 2, "5"),
            alert("8.8.4.4", 3, "4"),
        ];
        let mut blocked = vec![("192.0.2.9".to_string(), 500)];
        let (alerts, cmds) = ids_decide(&list, &mut blocked, true, 1000);
        // priority 3 isn't an alert; the same attack from one address is one alert
        assert_eq!(alerts.len(), 4);
        assert!(
            alerts[0].text.contains("2× from 198.51.100.66")
                && alerts[0].text.ends_with("24 hours.")
                && alerts[0].level == "bad"
        );
        // only the public priority-1 source is blocked; the expired block goes
        let paths: Vec<String> = cmds
            .iter()
            .map(|c| format!("{} {}", c.op, c.path.last().unwrap()))
            .collect();
        assert_eq!(paths, ["delete 192.0.2.9", "set 198.51.100.66"]);
        assert_eq!(
            blocked,
            [("198.51.100.66".to_string(), 1000 + 24 * 3600 * 1000)]
        );
        // already blocked: not again; automatic blocking off: no commands
        assert!(ids_decide(&list, &mut blocked, true, 2000).1.is_empty());
        let mut none = Vec::new();
        assert!(ids_decide(&list, &mut none, false, 2000).1.is_empty());
    }

    #[test]
    fn connections_tracked_until_they_end() {
        let own: std::collections::HashSet<String> =
            ["10.20.2.2".to_string(), "203.0.113.5".to_string()].into();
        let flow = |id: &str, src: &str, dst: &str, reply_src: &str, port: &str, up: u64| json!({ "id": id, "src": src, "dst": dst, "replySrc": reply_src, "dport": port, "proto": "tcp", "origBytes": up, "replyBytes": up * 10 });
        let mut open = HashMap::new();
        // a web connection, a DNS lookup to the router (left out), a port forward from the internet
        let first = [
            flow("1", "10.20.2.42", "1.1.1.1", "1.1.1.1", "443", 5),
            flow("2", "10.20.2.42", "10.20.2.2", "10.20.2.2", "53", 1),
            flow("3", "8.8.4.4", "203.0.113.5", "10.20.2.20", "32400", 7),
        ];
        assert!(track_flows(&mut open, &first, &own, 1000).is_empty());
        assert_eq!(open.len(), 2);
        // a minute later: 1 grew, then everything ended
        assert!(track_flows(
            &mut open,
            &[
                flow("1", "10.20.2.42", "1.1.1.1", "1.1.1.1", "443", 50),
                flow("3", "8.8.4.4", "203.0.113.5", "10.20.2.20", "32400", 7)
            ],
            &own,
            61_000
        )
        .is_empty());
        let mut ended = track_flows(&mut open, &[], &own, 121_000);
        ended.sort_by_key(|a| a.p);
        assert_eq!(ended.len(), 2);
        assert_eq!(
            (
                ended[0].d.as_str(),
                ended[0].p,
                ended[0].up,
                ended[0].down,
                ended[0].f,
                ended[0].t
            ),
            ("1.1.1.1", 443, 50, 500, 1000, 61_000)
        );
        assert_eq!(
            (ended[1].s.as_str(), ended[1].d.as_str()),
            ("8.8.4.4", "10.20.2.20")
        );
        // identical connections that ended together are merged
        let same = [
            flow("7", "10.20.2.3", "9.9.9.9", "9.9.9.9", "443", 1),
            flow("8", "10.20.2.3", "9.9.9.9", "9.9.9.9", "443", 2),
        ];
        track_flows(&mut open, &same, &own, 200_000);
        let m = track_flows(&mut open, &[], &own, 260_000);
        assert_eq!((m.len(), m[0].n, m[0].up), (1, 2, 3));
    }

    use super::*;

    #[test]
    fn journal_lines() {
        let line = r#"{"__CURSOR":"s=abc;i=1","__REALTIME_TIMESTAMP":"1792918222080123","PRIORITY":"3","SYSLOG_IDENTIFIER":"kernel","MESSAGE":"eth1: link down"}"#;
        let (l, c) = parse_journal(line).unwrap();
        assert_eq!(c, "s=abc;i=1");
        assert_eq!(
            (l.t, l.p, l.id.as_str(), l.m.as_str()),
            (1_792_918_222_080, 3, "kernel", "eth1: link down")
        );
        let bytes = r#"{"__CURSOR":"x","__REALTIME_TIMESTAMP":"1000","MESSAGE":[104,105]}"#;
        assert_eq!(parse_journal(bytes).unwrap().0.m, "hi");
        assert!(parse_journal("not json").is_none());
    }

    #[test]
    fn hosts_and_lan() {
        assert!(valid_host("192.168.1.5") && valid_host("nas.lan") && valid_host("fd00::1"));
        assert!(!valid_host("-c 1") && !valid_host("a b") && !valid_host(""));
        assert!(
            is_lan("192.168.1.5") && is_lan("10.0.0.1") && !is_lan("8.8.8.8") && !is_lan("fe80::1")
        );
    }

    #[test]
    fn kinds_default() {
        let rw = RouterWatch::default();
        assert!(rw.on("internet") && !rw.on("vpn"));
        let rw = RouterWatch {
            kinds: HashMap::from([("vpn".into(), true), ("internet".into(), false)]),
            ..Default::default()
        };
        assert!(rw.on("vpn") && !rw.on("internet"));
    }
}
