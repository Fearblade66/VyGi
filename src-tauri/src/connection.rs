use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::security::{self, RouterProfile, Secrets};
use crate::ssh::SshClient;
use crate::state::{Connection, St, TxState, Win};
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
    /// Turn on the router's API over SSH first, with `api_key` as its key
    /// (for routers that haven't been prepared by hand).
    #[serde(default)]
    prepare_api: bool,
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
    /// The login still uses the VyOS default password ("vyos").
    default_password: bool,
    /// Set when "remember" was requested but the OS keychain refused (says
    /// whether the file fallback was used).
    keychain_error: Option<String>,
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn list_routers(state: St) -> AppResult<Vec<RouterProfile>> {
    state.profiles.load()
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn has_saved_secrets(state: St, id: String) -> AppResult<bool> {
    let profile = state.profiles.find(&id)?;
    Ok(security::load_secrets(&state.profiles.dir(), &profile)?.is_some())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn forget_router(state: St, id: String) -> AppResult<()> {
    if let Some(profile) = state.profiles.remove(&id)? {
        security::delete_secrets(&state.profiles.dir(), &profile)?;
    }
    Ok(())
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.trim().is_empty())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn connect(state: St, win: Win, req: ConnectRequest) -> AppResult<ConnectInfo> {
    win.disconnect().await;
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
        _ => security::load_secrets(&state.profiles.dir(), &profile).unwrap_or(None),
    };
    let api_key = non_empty(req.api_key)
        .or_else(|| stored.as_ref().map(|s| s.api_key.clone()))
        .ok_or_else(|| AppError::Invalid("API key is required".into()))?;
    let ssh_password = non_empty(req.ssh_password)
        .or_else(|| stored.as_ref().map(|s| s.ssh_password.clone()))
        .ok_or_else(|| AppError::Invalid("SSH password is required".into()))?;

    let ssh_pin = req.trust_ssh.or(profile.ssh_fingerprint.clone());
    let connect_ssh = || {
        SshClient::connect(
            &profile.host,
            profile.ssh_port,
            &profile.ssh_user,
            &ssh_password,
            ssh_pin.clone(),
        )
    };
    let early_ssh = if req.prepare_api {
        let ssh = connect_ssh().await?;
        prepare_api(&ssh, &api_key).await?;
        Some(ssh)
    } else {
        None
    };

    let tls_pin = req.trust_tls.or(profile.tls_fingerprint.clone());
    let api = VyosApi::new(&profile.host, profile.api_port, api_key.clone(), tls_pin)?;
    // Right after preparing, the router's web server is still restarting.
    let mut tries = if req.prepare_api { 15 } else { 1 };
    let hostname = loop {
        tries -= 1;
        match api.return_value(&path(&["system", "host-name"])).await {
            Ok(v) => break v.unwrap_or_else(|| profile.host.clone()),
            Err(e @ (AppError::UntrustedCert { .. } | AppError::CertMismatch { .. })) => {
                return Err(e)
            }
            Err(e) if tries == 0 => {
                // Nothing on the API port: SSH tells "router down / wrong address"
                // from "only the API is off".
                let unreachable = matches!(&e, AppError::Http(m) if m.starts_with("cannot reach"))
                    || matches!(e, AppError::Timeout(_));
                if !unreachable || req.prepare_api {
                    return Err(e);
                }
                return Err(match connect_ssh().await {
                    Ok(_)
                    | Err(
                        AppError::AuthFailed(_)
                        | AppError::UntrustedHostKey { .. }
                        | AppError::HostKeyMismatch { .. },
                    ) => AppError::ApiDown(format!(
                        "The router answers over SSH, but its HTTPS API (port {}) doesn't: `service https` is off or not running.",
                        profile.api_port
                    )),
                    Err(_) => AppError::Http(format!(
                        "the router doesn't answer at {}: not over HTTPS (port {}) and not over SSH (port {}). Is it turned on, and is that still its address?",
                        profile.host, profile.api_port, profile.ssh_port
                    )),
                });
            }
            Err(_) => tokio::time::sleep(std::time::Duration::from_secs(2)).await,
        }
    };

    let ssh = match early_ssh {
        Some(ssh) => ssh,
        None => connect_ssh().await?,
    };

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
    let default_password = ssh_password == "vyos";
    // Not saving must not block connecting; the UI says what happened.
    let keychain_error = if req.remember {
        let secrets = Secrets {
            api_key,
            ssh_password,
        };
        match security::store_secrets(&state.profiles.dir(), &profile, &secrets) {
            Ok(None) => None,
            Ok(Some(reason)) => Some(format!(
                "the OS keychain didn't work ({reason}), so they were saved in a file only your user can read"
            )),
            Err(e) => Some(format!("they could not be saved: {e}")),
        }
    } else {
        None
    };

    *win.tx.lock().await = TxState::default();
    let profile_id = profile.id();
    win.set_conn(Some(Arc::new(Connection {
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
        default_password,
        keychain_error,
    })
}

/// Changes the connected user's login password, saves it to the boot config
/// right away (no Safe Mode: a revert would leave the saved password wrong),
/// and updates the password VyGi remembers.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn change_login_password(state: St, win: Win, new_password: String) -> AppResult<()> {
    if new_password.chars().count() < 8 {
        return Err(AppError::Invalid("Use at least 8 characters".into()));
    }
    if new_password == "vyos" {
        return Err(AppError::Invalid("That's the default password".into()));
    }
    let conn = win.conn().await?;
    if crate::transactions::confirm_pending(&conn).await {
        return Err(AppError::Invalid(
            "A Safe Mode change is waiting for Confirm. Confirm it (or let it revert) first."
                .into(),
        ));
    }
    let profile = state.profiles.find(&conn.profile_id)?;
    let cmd = crate::vyos_api::ConfigCommand {
        op: "set".into(),
        path: [
            "system",
            "login",
            "user",
            &profile.ssh_user,
            "authentication",
            "plaintext-password",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
        value: Some(new_password.clone()),
    };
    conn.api.configure(&[cmd], 0).await?;
    conn.api.save().await?;
    let dir = state.profiles.dir();
    if let Some(mut secrets) = security::load_secrets(&dir, &profile)? {
        secrets.ssh_password = new_password;
        security::store_secrets(&dir, &profile, &secrets)?;
    }
    Ok(())
}

/// Turns on the HTTPS API with `key` (id "vygi") and makes Safe Mode revert by
/// reloading instead of rebooting, through the VyOS CLI over SSH.
async fn prepare_api(ssh: &SshClient, key: &str) -> AppResult<()> {
    // Only generated keys get here; anything else could break out of the script.
    if key.len() < 32 || key.len() > 128 || !key.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(AppError::Invalid(
            "API key must be 32-128 letters and digits".into(),
        ));
    }
    let script = format!(
        "/bin/vbash -c 'source /opt/vyatta/etc/functions/script-template\n\
         configure\n\
         set service https api keys id vygi key {key}\n\
         set service https api rest\n\
         set system config-management commit-confirm action reload\n\
         commit\n\
         save\n\
         exit'"
    );
    let out = ssh
        .exec(&script, std::time::Duration::from_secs(90))
        .await?;
    let text = format!("{}\n{}", out.stdout, out.stderr);
    if out.exit_code.is_some_and(|c| c != 0) || text.contains("Commit failed") {
        let detail: Vec<&str> = text
            .lines()
            .filter(|l| {
                !l.trim().is_empty()
                    && !l.contains("locale")
                    && !l.starts_with("perl:")
                    && !l.starts_with("\t")
                    && !l.contains("sudo: unable to resolve")
            })
            .collect();
        return Err(AppError::Api(format!(
            "Couldn't turn on the router's API over SSH: {}",
            detail.join(" ").chars().take(400).collect::<String>()
        )));
    }
    Ok(())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn disconnect(win: Win) -> AppResult<()> {
    win.disconnect().await;
    Ok(())
}

/// Opens another app window with its own connection (one router per window).
/// (In a browser, the UI opens a new tab instead.)
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn new_window(app: tauri::AppHandle) -> AppResult<()> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    let n = (1..)
        .find(|i| app.get_webview_window(&format!("router{i}")).is_none())
        .unwrap_or(1);
    WebviewWindowBuilder::new(&app, format!("router{n}"), WebviewUrl::default())
        .title("VyGi")
        .inner_size(1280.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .build()
        .map_err(|e| AppError::Invalid(format!("could not open a window: {e}")))?;
    Ok(())
}

pub fn path(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}
