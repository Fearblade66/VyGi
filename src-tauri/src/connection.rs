use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::security::{self, RouterProfile, Secrets};
use crate::ssh::SshClient;
use crate::state::{AppState, Connection, TxState};
use crate::vyos_api::VyosApi;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    profile: RouterProfile,
    /// Leave empty to use the one stored in the keychain.
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    ssh_password: Option<String>,
    /// Save the secrets to the OS keychain.
    #[serde(default)]
    remember: bool,
    /// Fingerprints the user just approved in the "trust this router?" dialog.
    #[serde(default)]
    trust_tls: Option<String>,
    #[serde(default)]
    trust_ssh: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    profile: RouterProfile,
    profile_id: String,
    hostname: String,
    version: String,
    /// What the router does when a commit-confirm times out: "reboot" or "reload".
    revert_action: String,
    /// Set when "remember" was requested but the OS keychain refused.
    keychain_error: Option<String>,
}

#[tauri::command]
pub fn list_routers(state: State<'_, AppState>) -> AppResult<Vec<RouterProfile>> {
    state.profiles.load()
}

#[tauri::command]
pub fn has_saved_secrets(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    let profile = state.profiles.find(&id)?;
    Ok(security::load_secrets(&profile)?.is_some())
}

#[tauri::command]
pub fn forget_router(state: State<'_, AppState>, id: String) -> AppResult<()> {
    if let Some(profile) = state.profiles.remove(&id)? {
        security::delete_secrets(&profile)?;
    }
    Ok(())
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.trim().is_empty())
}

#[tauri::command]
pub async fn connect(state: State<'_, AppState>, req: ConnectRequest) -> AppResult<ConnectInfo> {
    disconnect(state.clone()).await?;
    let mut profile = req.profile;
    if profile.host.trim().is_empty() {
        return Err(AppError::Invalid("router address is empty".into()));
    }
    profile.host = profile.host.trim().to_string();

    // A profile edited in the dialog doesn't carry pins; take them from the saved copy.
    if let Ok(saved) = state.profiles.find(&profile.id()) {
        if saved.host == profile.host && saved.api_port == profile.api_port {
            profile.tls_fingerprint = profile.tls_fingerprint.or(saved.tls_fingerprint);
        }
        if saved.host == profile.host && saved.ssh_port == profile.ssh_port {
            profile.ssh_fingerprint = profile.ssh_fingerprint.or(saved.ssh_fingerprint);
        }
    }

    let stored = match (
        non_empty(req.api_key.clone()),
        non_empty(req.ssh_password.clone()),
    ) {
        (Some(_), Some(_)) => None,
        _ => security::load_secrets(&profile).unwrap_or(None),
    };
    let api_key = non_empty(req.api_key)
        .or_else(|| stored.as_ref().map(|s| s.api_key.clone()))
        .ok_or_else(|| AppError::Invalid("API key is required".into()))?;
    let ssh_password = non_empty(req.ssh_password)
        .or_else(|| stored.as_ref().map(|s| s.ssh_password.clone()))
        .ok_or_else(|| AppError::Invalid("SSH password is required".into()))?;

    let tls_pin = req.trust_tls.or(profile.tls_fingerprint.clone());
    let api = VyosApi::new(&profile.host, profile.api_port, api_key.clone(), tls_pin)?;
    let hostname = api
        .return_value(&path(&["system", "host-name"]))
        .await?
        .unwrap_or_else(|| profile.host.clone());

    let ssh_pin = req.trust_ssh.or(profile.ssh_fingerprint.clone());
    let ssh = SshClient::connect(
        &profile.host,
        profile.ssh_port,
        &profile.ssh_user,
        &ssh_password,
        ssh_pin,
    )
    .await?;

    let version = api
        .show(&path(&["version"]))
        .await
        .ok()
        .and_then(|text| {
            text.lines()
                .find(|l| l.trim_start().starts_with("Version:"))
                .map(|l| {
                    let v = l.trim_start().trim_start_matches("Version:").trim();
                    v.strip_prefix("VyOS ").unwrap_or(v).to_string()
                })
        })
        .unwrap_or_else(|| "unknown".into());
    let revert_action = api
        .return_value(&path(&[
            "system",
            "config-management",
            "commit-confirm",
            "action",
        ]))
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "reboot".into()); // VyOS default

    profile.tls_fingerprint = api.seen_fingerprint();
    profile.ssh_fingerprint = Some(ssh.host_fingerprint().to_string());
    if profile.name.trim().is_empty() {
        profile.name = hostname.clone();
    }
    state.profiles.upsert(&profile)?;
    // A missing OS keychain (e.g. Linux without a keyring service) must not block connecting.
    let keychain_error = if req.remember {
        security::store_secrets(
            &profile,
            &Secrets {
                api_key,
                ssh_password,
            },
        )
        .err()
        .map(|e| e.to_string())
    } else {
        None
    };

    *state.tx.lock().await = TxState::default();
    let profile_id = profile.id();
    state
        .set_conn(Some(Arc::new(Connection {
            profile_id: profile_id.clone(),
            api,
            ssh,
        })))
        .await;
    Ok(ConnectInfo {
        profile,
        profile_id,
        hostname,
        version,
        revert_action,
        keychain_error,
    })
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>) -> AppResult<()> {
    state.close_sessions().await;
    if let Some(old) = state.set_conn(None).await {
        old.ssh.disconnect().await;
    }
    Ok(())
}

pub fn path(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}
