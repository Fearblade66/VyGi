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

use crate::error::{AppError, AppResult};
use crate::state::{AppState, Out, St, Win, WindowState};
use crate::{
    backup, checkup, connection, geoip, monitor, siteicons, sysinfo, technitium, torch,
    transactions, wireguard,
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
    win: Arc<WindowState>,
    cmd: &str,
    a: Value,
) -> AppResult<Value> {
    let st = || St(app.clone());
    let w = || Win(win.clone());
    match cmd {
        // keep-alive: the tab is still open (the server already noted it)
        "ping" => Ok(Value::Null),
        "list_routers" => json(connection::list_routers(st())),
        "has_saved_secrets" => json(connection::has_saved_secrets(st(), arg(&a, "id")?)),
        "forget_router" => json(connection::forget_router(st(), arg(&a, "id")?)),
        "connect" => json(connection::connect(st(), w(), arg(&a, "req")?).await),
        "disconnect" => json(connection::disconnect(w()).await),
        "change_login_password" => {
            json(connection::change_login_password(st(), w(), arg(&a, "newPassword")?).await)
        }

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
        "rollback_to" => {
            json(transactions::rollback_to(w(), arg(&a, "rev")?, arg(&a, "confirmMinutes")?).await)
        }
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
