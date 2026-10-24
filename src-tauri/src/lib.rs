mod backup;
mod checkup;
mod connection;
mod error;
mod monitor;
mod security;
mod ssh;
mod state;
mod sysinfo;
mod technitium;
mod tls;
mod torch;
mod transactions;
mod vyos_api;
mod wireguard;

use tauri::Manager;

use crate::security::ProfileStore;
use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            app.manage(AppState::new(ProfileStore::new(dir)));
            Ok(())
        })
        .on_window_event(|window, event| {
            // A closed window takes its router connection with it.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(ws) = window.state::<AppState>().remove_window(window.label()) {
                    tauri::async_runtime::spawn(async move { ws.disconnect().await });
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
            sysinfo::connections,
            sysinfo::ping_latency,
            sysinfo::ip_scan,
            sysinfo::processes,
            sysinfo::image_list,
            sysinfo::image_add,
            sysinfo::image_set_default,
            sysinfo::image_delete,
            sysinfo::power,
            wireguard::wireguard_keypair,
            wireguard::wireguard_psk,
            torch::open_torch,
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
