pub mod backup;
pub mod checkup;
pub mod connection;
pub mod error;
pub mod geoip;
pub mod monitor;
pub mod security;
pub mod siteicons;
pub mod ssh;
pub mod state;
pub mod sysinfo;
pub mod technitium;
pub mod tls;
pub mod torch;
pub mod transactions;
pub mod updates;
pub mod vyos_api;
pub mod wireguard;

#[cfg(feature = "server")]
pub mod server;

#[cfg(feature = "desktop")]
use crate::security::ProfileStore;
#[cfg(feature = "desktop")]
use crate::state::{AppState, Dirs};

#[cfg(feature = "desktop")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use std::sync::Arc;
    use tauri::Manager;
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let path = app.path();
            let dirs = Dirs {
                data: path.app_data_dir()?,
                cache: path.app_cache_dir()?,
            };
            let profiles = ProfileStore::new(path.app_config_dir()?);
            app.manage(Arc::new(AppState::new(profiles, dirs)));
            Ok(())
        })
        .on_window_event(|window, event| {
            // A closed window takes its router connection with it.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(ws) = window
                    .state::<Arc<AppState>>()
                    .remove_window(window.label())
                {
                    tokio::spawn(async move { ws.disconnect().await });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            connection::list_routers,
            connection::has_saved_secrets,
            connection::forget_router,
            connection::connect,
            connection::disconnect,
            connection::new_window,
            connection::change_login_password,
            sysinfo::wake_on_lan,
            sysinfo::speed_test,
            transactions::tx_status,
            transactions::get_config,
            transactions::run_show,
            transactions::apply_changes,
            transactions::confirm_commit,
            transactions::save_config,
            transactions::list_revisions,
            transactions::revision_diff,
            transactions::rollback_to,
            transactions::set_revert_action,
            monitor::interface_stats,
            monitor::routes,
            monitor::wireguard_dump,
            sysinfo::dhcp_leases,
            sysinfo::system_load,
            sysinfo::system_info,
            sysinfo::neighbors,
            sysinfo::lldp_neighbors,
            sysinfo::ddns_status,
            sysinfo::router_time,
            sysinfo::ddns_update_now,
            sysinfo::connections,
            sysinfo::ping_latency,
            sysinfo::ip_scan,
            sysinfo::processes,
            sysinfo::image_list,
            updates::update_check,
            checkup::accounting_sync,
            checkup::client_address,
            monitor::port_info,
            sysinfo::image_add,
            sysinfo::image_set_default,
            sysinfo::image_delete,
            sysinfo::power,
            wireguard::wireguard_keypair,
            wireguard::wireguard_psk,
            torch::open_torch,
            siteicons::site_icons,
            geoip::geoip_status,
            geoip::geoip_update,
            geoip::geoip_lookup,
            technitium::dns_server_link,
            technitium::dns_server_setup,
            technitium::dns_server_forget,
            technitium::dns_server_call,
            checkup::connect_checkup,
            checkup::history_list,
            checkup::history_diff,
            checkup::history_restore,
            backup::export_config,
            backup::save_text_file,
            backup::import_config,
            monitor::open_stream,
            monitor::open_terminal,
            monitor::term_write,
            monitor::term_resize,
            monitor::close_session,
        ])
        .run(tauri::generate_context!());
    if let Err(e) = result {
        eprintln!("VyGi failed to start: {e}");
        std::process::exit(1);
    }
}
