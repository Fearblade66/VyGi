mod backup;
mod connection;
mod error;
mod monitor;
mod security;
mod ssh;
mod state;
mod tls;
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
        .invoke_handler(tauri::generate_handler![
            connection::list_routers,
            connection::has_saved_secrets,
            connection::forget_router,
            connection::connect,
            connection::disconnect,
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
            monitor::dhcp_leases,
            wireguard::wireguard_keypair,
            wireguard::wireguard_psk,
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
