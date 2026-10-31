//! Runs a command by name with JSON arguments, the way Tauri's invoke does
//! for the desktop app (argument names in camelCase).
//!
//! Commands that read or write files at a path the caller chooses
//! (`export_config`, `import_config`, `save_text_file`) are not available
//! here: the browser downloads and uploads text instead.

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

use super::watch::{now_ms, Notify, RouterWatch, WatchHost, Watcher};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, Out, St, Win, WindowState};
use crate::{
    backup, checkup, connection, geoip, ids, monitor, siteicons, sysinfo, technitium, torch,
    transactions, updates, upgrade, wireguard,
};

fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> AppResult<T> {
    serde_json::from_value(args.get(name).cloned().unwrap_or(Value::Null))
        .map_err(|e| AppError::Invalid(format!("argument `{name}`: {e}")))
}

fn json<T: Serialize>(r: AppResult<T>) -> AppResult<Value> {
    r.and_then(|v| serde_json::to_value(v).map_err(|e| AppError::Invalid(e.to_string())))
}

pub async fn call(
    app: &Arc<AppState>,
    watcher: &Arc<Watcher>,
    win: Arc<WindowState>,
    cmd: &str,
    a: Value,
) -> AppResult<Value> {
    if let Some(rest) = cmd.strip_prefix("watch_") {
        return watch_call(watcher, &win, rest, &a).await;
    }
    let st = || St(app.clone());
    let w = || Win(win.clone());
    match cmd {
        // keep-alive: the tab is still open (the server already noted it)
        "ping" => Ok(Value::Null),
        "list_routers" => json(connection::list_routers(st())),
        // every saved router with its 24/7 watching: the overview on the Dashboard
        "routers_overview" => {
            let day_ago = now_ms().saturating_sub(86_400_000);
            let list: Vec<Value> = connection::list_routers(st())?
                .into_iter()
                .map(|p| {
                    let id = p.id();
                    let alerts = watcher.store(&id).alerts(day_ago, 50);
                    let bad = alerts.iter().filter(|a| a.level == "bad").count();
                    serde_json::json!({
                        "id": id,
                        "name": p.name,
                        "host": p.host,
                        "watch": watcher.router(&id).enabled,
                        "status": watcher.status(&id),
                        "alerts24h": alerts.len(),
                        "bad24h": bad,
                        "lastAlert": alerts.first(),
                    })
                })
                .collect();
            Ok(Value::Array(list))
        }
        "has_saved_secrets" => json(connection::has_saved_secrets(st(), arg(&a, "id")?)),
        "router_backups" => json(checkup::router_backups(st(), arg(&a, "id")?)),
        "restore_over_ssh" => json(
            checkup::restore_over_ssh(
                st(),
                arg(&a, "id")?,
                arg(&a, "snapshot")?,
                arg(&a, "trustSsh").ok(),
            )
            .await,
        ),
        "forget_router" => json(connection::forget_router(st(), arg(&a, "id")?)),
        "connect" => json(connection::connect(st(), w(), arg(&a, "req")?).await),
        "disconnect" => json(connection::disconnect(w()).await),
        "use_own_login" => json(connection::use_own_login(st(), w()).await),
        "use_ssh_key" => json(connection::use_ssh_key(st(), w()).await),
        "change_login_password" => json(
            connection::change_login_password(
                st(),
                w(),
                arg(&a, "newPassword")?,
                arg(&a, "user").ok(),
            )
            .await,
        ),

        "tx_status" => json(transactions::tx_status(w()).await),
        "get_config" => json(transactions::get_config(w(), arg(&a, "path")?).await),
        "run_show" => json(transactions::run_show(w(), arg(&a, "path")?).await),
        "apply_changes" => json(
            transactions::apply_changes(w(), arg(&a, "commands")?, arg(&a, "confirmMinutes")?)
                .await,
        ),
        "confirm_commit" => json(transactions::confirm_commit(w()).await),
        "save_config" => json(transactions::save_config(w()).await),
        "list_revisions" => json(transactions::list_revisions(w()).await),
        "revision_diff" => {
            json(transactions::revision_diff(w(), arg(&a, "rev")?, arg(&a, "rev2")?).await)
        }
        "rollback_to" => json(
            transactions::rollback_to(st(), w(), arg(&a, "rev")?, arg(&a, "confirmMinutes")?).await,
        ),
        "set_revert_action" => json(transactions::set_revert_action(w(), arg(&a, "action")?).await),

        "interface_stats" => json(monitor::interface_stats(w()).await),
        "routes" => json(monitor::routes(w(), arg(&a, "family")?, arg(&a, "vrf")?).await),
        "wireguard_dump" => json(monitor::wireguard_dump(w()).await),
        "term_write" => json(monitor::term_write(w(), arg(&a, "id")?, arg(&a, "data")?).await),
        "term_resize" => json(
            monitor::term_resize(w(), arg(&a, "id")?, arg(&a, "cols")?, arg(&a, "rows")?).await,
        ),
        "close_session" => json(monitor::close_session(w(), arg(&a, "id")?).await),

        "dhcp_leases" => json(sysinfo::dhcp_leases(w(), arg(&a, "family")?).await),
        "system_load" => json(sysinfo::system_load(w()).await),
        "router_facts" => json(sysinfo::router_facts(w()).await),
        "system_info" => json(sysinfo::system_info(w()).await),
        "neighbors" => json(sysinfo::neighbors(w()).await),
        "lldp_neighbors" => json(sysinfo::lldp_neighbors(w()).await),
        "ddns_status" => json(sysinfo::ddns_status(w()).await),
        "router_time" => json(sysinfo::router_time(w()).await),
        "ddns_update_now" => json(sysinfo::ddns_update_now(w()).await),
        "connections" => json(sysinfo::connections(w()).await),
        "ping_latency" => json(sysinfo::ping_latency(w(), arg(&a, "target")?).await),
        "ip_scan" => json(sysinfo::ip_scan(w(), arg(&a, "network")?).await),
        "processes" => json(sysinfo::processes(w()).await),
        "image_list" => json(sysinfo::image_list(w()).await),
        "update_check" => json(updates::update_check(w()).await),
        "image_add" => json(sysinfo::image_add(w(), arg(&a, "url")?).await),
        "image_set_default" => json(sysinfo::image_set_default(w(), arg(&a, "name")?).await),
        "image_delete" => json(sysinfo::image_delete(w(), arg(&a, "name")?).await),
        "power" => json(sysinfo::power(w(), arg(&a, "action")?).await),
        "wake_on_lan" => {
            json(sysinfo::wake_on_lan(w(), arg(&a, "interface")?, arg(&a, "mac")?).await)
        }
        "speed_test" => json(sysinfo::speed_test(w()).await),

        "wireguard_keypair" => json(wireguard::wireguard_keypair()),
        "wireguard_psk" => json(wireguard::wireguard_psk()),
        "site_icons" => json(siteicons::site_icons(st(), arg(&a, "domains")?).await),
        "geoip_status" => json(geoip::geoip_status(st())),
        "geoip_update" => json(geoip::geoip_update(st()).await),
        "geoip_lookup" => json(geoip::geoip_lookup(st(), arg(&a, "ips")?)),

        "dns_server_link" => json(technitium::dns_server_link(st(), w()).await),
        "dns_server_setup" => json(
            technitium::dns_server_setup(
                st(),
                w(),
                arg(&a, "url")?,
                arg(&a, "token")?,
                arg(&a, "user")?,
                arg(&a, "password")?,
                arg(&a, "trustTls")?,
            )
            .await,
        ),
        "dns_server_forget" => json(technitium::dns_server_forget(st(), w()).await),
        "dns_server_call" => json(
            technitium::dns_server_call(st(), w(), arg(&a, "endpoint")?, arg(&a, "params")?).await,
        ),

        "connect_checkup" => json(checkup::connect_checkup(st(), w()).await),
        "accounting_sync" => json(checkup::accounting_sync(w()).await),
        "client_address" => json(checkup::client_address(w()).await),
        "port_info" => json(monitor::port_info(w()).await),
        "ids_prepare" => json(ids::ids_prepare(w()).await),
        "ids_status" => json(ids::ids_status(w()).await),
        "update_guard_arm" => json(upgrade::update_guard_arm(w(), arg(&a, "minutes")?).await),
        "update_guard_status" => json(upgrade::update_guard_status(w()).await),
        "update_guard_confirm" => json(upgrade::update_guard_confirm(w()).await),
        "update_rollback_now" => json(upgrade::update_rollback_now(w()).await),
        "ids_update_rules" => json(ids::ids_update_rules(w()).await),
        "ids_alerts" => {
            json(ids::ids_alerts(w(), arg::<Option<u32>>(&a, "limit")?.unwrap_or(200)).await)
        }
        "history_list" => json(checkup::history_list(st(), w()).await),
        "history_diff" => json(checkup::history_diff(st(), w(), arg(&a, "id")?).await),
        "history_restore" => json(
            checkup::history_restore(st(), w(), arg(&a, "id")?, arg(&a, "confirmMinutes")?).await,
        ),

        // browser versions of the file-based backup commands
        "export_config_text" => json(backup::export_config_text(w(), arg(&a, "format")?).await),
        "import_config_text" => json(
            backup::import_config_text(w(), arg(&a, "text")?, arg(&a, "confirmMinutes")?).await,
        ),

        _ => Err(AppError::Invalid(format!("unknown command `{cmd}`"))),
    }
}

/// Starts a streaming command; each event is sent to `tx` as JSON text.
pub async fn open_stream(
    _app: &Arc<AppState>,
    win: Arc<WindowState>,
    cmd: &str,
    a: Value,
    tx: UnboundedSender<String>,
) -> AppResult<u32> {
    fn sender<T: Serialize>(tx: UnboundedSender<String>) -> Out<T> {
        Out::new(move |ev: T| {
            serde_json::to_string(&ev)
                .map(|t| tx.send(t).is_ok())
                .unwrap_or(false)
        })
    }
    let w = Win(win);
    match cmd {
        "open_stream" => monitor::open_stream(w, arg(&a, "kind")?, sender(tx)).await,
        "open_terminal" => {
            monitor::open_terminal(w, arg(&a, "cols")?, arg(&a, "rows")?, sender(tx)).await
        }
        "open_torch" => {
            torch::open_torch(
                w,
                arg(&a, "interface")?,
                arg(&a, "filter")?,
                arg(&a, "hidePort")?,
                sender(tx),
            )
            .await
        }
        _ => Err(AppError::Invalid(format!("unknown stream `{cmd}`"))),
    }
}

/// 24/7 watching and its recordings, for the router this tab is connected to.
async fn watch_call(
    w: &Arc<Watcher>,
    win: &Arc<WindowState>,
    cmd: &str,
    a: &Value,
) -> AppResult<Value> {
    let conn = win.conn().await?;
    let id = conn.profile_id.clone();
    const DAY: u64 = 86_400_000;
    let now = now_ms();
    match cmd {
        // settings and status
        "get" => Ok(serde_json::json!({
            "router": w.router(&id),
            "status": w.status(&id),
            "notify": w.notify_settings(),
        })),
        "set" => {
            let old = w.router(&id);
            let rw = RouterWatch {
                enabled: arg::<Option<bool>>(a, "enabled")?.unwrap_or(old.enabled),
                kinds: arg::<Option<_>>(a, "kinds")?.unwrap_or(old.kinds),
                hosts: arg::<Option<Vec<WatchHost>>>(a, "hosts")?.unwrap_or(old.hosts),
                name: arg::<Option<String>>(a, "name")?.unwrap_or(old.name),
            };
            json(w.set_router(&id, rw))
        }
        "notify_set" => json(w.set_notify(arg::<Notify>(a, "notify")?)),
        "notify_test" => {
            let test = super::alerts::Alert {
                kind: "test".into(),
                text: "Test from VyGi: notifications work.".into(),
                level: "info".into(),
                at: now,
            };
            json(w.notify(&w.router(&id).name, &[test]).await)
        }
        // recordings
        "alerts" => json(Ok(w.store(&id).alerts(
            arg::<Option<u64>>(a, "since")?.unwrap_or(0),
            arg::<Option<usize>>(a, "limit")?.unwrap_or(200).min(2000),
        ))),
        "traffic" => {
            let hours = arg::<Option<u64>>(a, "hours")?
                .unwrap_or(24)
                .clamp(1, 24 * 400);
            json(Ok(w.store(&id).wan(now - hours * 3_600_000, now, 400)))
        }
        "devices" => {
            let days = arg::<Option<u64>>(a, "days")?.unwrap_or(1).clamp(1, 400);
            let list = w.store(&id).devices(now - (days - 1) * DAY, now, 100);
            json(Ok(list.into_iter().map(|(key, t)| serde_json::json!({ "key": key, "ip": t.ip, "name": t.name, "down": t.down, "up": t.up })).collect::<Vec<_>>()))
        }
        // data used per day (all devices, or one), plus the devices over the period
        "usage" => {
            let days = arg::<Option<u64>>(a, "days")?.unwrap_or(30).clamp(1, 400);
            let key = arg::<Option<String>>(a, "key")?;
            let from = now - (days - 1) * DAY;
            let store = w.store(&id);
            let daily = store.usage_days(from, now, key.as_deref());
            let devices = store.devices(from, now, 200);
            json(Ok(serde_json::json!({
                "days": daily.into_iter().map(|(d, down, up)| serde_json::json!({ "day": d, "down": down, "up": up })).collect::<Vec<_>>(),
                "devices": devices.into_iter().map(|(key, t)| serde_json::json!({ "key": key, "ip": t.ip, "name": t.name, "down": t.down, "up": t.up })).collect::<Vec<_>>(),
            })))
        }
        "logs" => {
            let days = arg::<Option<u64>>(a, "days")?.unwrap_or(1).clamp(1, 400);
            let q: String = arg::<Option<String>>(a, "query")?.unwrap_or_default();
            let max_p = arg::<Option<u8>>(a, "maxPriority")?.unwrap_or(7);
            let limit = arg::<Option<usize>>(a, "limit")?.unwrap_or(500).min(5000);
            json(Ok(w.store(&id).logs(
                &q,
                now - days * DAY,
                now,
                max_p,
                limit,
            )))
        }
        "flows" => {
            let hours = arg::<Option<u64>>(a, "hours")?
                .unwrap_or(24)
                .clamp(1, 24 * 400);
            let q: String = arg::<Option<String>>(a, "query")?.unwrap_or_default();
            let kind: String = arg::<Option<String>>(a, "kind")?.unwrap_or_default();
            let limit = arg::<Option<usize>>(a, "limit")?.unwrap_or(500).min(5000);
            json(Ok(w.store(&id).flows(
                now - hours * 3_600_000,
                now,
                &q,
                &kind,
                limit,
            )))
        }
        _ => Err(AppError::Invalid(format!("unknown command `watch_{cmd}`"))),
    }
}

/// Commands that change something, as (action, detail) for the activity log;
/// None for reads. Secrets are left out.
pub fn audit_entry(cmd: &str, a: &Value) -> Option<(String, String)> {
    let s = |k: &str| a.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let n = |k: &str| a.get(k).and_then(Value::as_u64).unwrap_or(0);
    let entry = |action: &str, detail: String| Some((action.to_string(), detail));
    match cmd {
        "apply_changes" => {
            let cmds = super::audit::commands_from(a.get("commands"));
            let mins = n("confirmMinutes");
            let mut d = super::audit::change_detail(a.get("what").and_then(Value::as_str), &cmds);
            if mins > 0 {
                d = format!("(Safe Mode, {mins} min)\n{d}");
            }
            entry("change", d)
        }
        "confirm_commit" => entry("confirmed Safe Mode changes", String::new()),
        "rollback_to" => entry("rollback", format!("to revision {}", n("rev"))),
        "history_restore" => entry("restored a backup", format!("snapshot {}", n("id"))),
        "import_config_text" => entry("restored a backup", "uploaded file".into()),
        "export_config_text" => entry("downloaded a backup", s("format")),
        "set_revert_action" => entry("change", format!("Safe Mode undoes by {}", s("action"))),
        "power" => entry(&format!("router {}", s("action")), String::new()),
        "image_add" => entry("VyOS update installed", s("url")),
        "image_set_default" => entry("VyOS default image set", s("name")),
        "image_delete" => entry("VyOS image deleted", s("name")),
        "change_login_password" => entry("router password changed", String::new()),
        "use_own_login" => entry("VyGi's own router login made", String::new()),
        "use_ssh_key" => entry("VyGi's router login switched to an SSH key", String::new()),
        "restore_over_ssh" => entry("backup restored over SSH", String::new()),
        "connect" => {
            let p = a.pointer("/req/profile").cloned().unwrap_or(Value::Null);
            let host = p.get("host").and_then(Value::as_str).unwrap_or("");
            let user = p.get("sshUser").and_then(Value::as_str).unwrap_or("vyos");
            entry("connected", format!("{user}@{host}"))
        }
        "forget_router" => entry("removed a saved router", s("id")),
        "ids_prepare" => entry("intrusion detection: downloaded Suricata", String::new()),
        "ids_update_rules" => entry("intrusion detection: updated rules", String::new()),
        "dns_server_setup" => entry("linked a DNS server", s("url")),
        "dns_server_forget" => entry("unlinked the DNS server", String::new()),
        "dns_server_call" => {
            let ep = s("endpoint");
            if ep.ends_with("/get")
                || ep.contains("/list")
                || ep.contains("export")
                || ep.contains("query")
                || ep.starts_with("dashboard")
            {
                return None;
            }
            let params = a.get("params").map(|p| p.to_string()).unwrap_or_default();
            entry("DNS server change", format!("{ep} {params}"))
        }
        "watch_set" => entry(
            "24/7 watching changed",
            match a.get("enabled").and_then(Value::as_bool) {
                Some(true) => "on".into(),
                Some(false) => "off".into(),
                None => "settings".into(),
            },
        ),
        "watch_notify_set" => entry("notification settings changed", String::new()),
        "wake_on_lan" => entry("wake-on-LAN", s("mac")),
        _ => None,
    }
}
