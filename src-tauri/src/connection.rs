use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    /// VyGi logs in with its SSH key (not a password).
    key_login: bool,
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

    // A saved router whose login changed later keeps its first id.
    if profile.key.is_none() {
        profile.key = state.profiles.load()?.into_iter().find_map(|p| {
            (p.key.is_some() && p.host == profile.host && p.ssh_user == profile.ssh_user)
                .then_some(p.key)
                .flatten()
        });
    }
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
    let key_login = crate::ssh::is_private_key(&ssh_password);
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
        key_login,
        keychain_error,
    })
}

/// Changes the connected user's login password, saves it to the boot config
/// right away (no Safe Mode: a revert would leave the saved password wrong),
/// and updates the password VyGi remembers.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn change_login_password(
    state: St,
    win: Win,
    new_password: String,
    user: Option<String>,
) -> AppResult<()> {
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
    // another login on the router (not the one VyGi uses): nothing to remember
    let user = user.filter(|u| !u.is_empty() && *u != profile.ssh_user);
    if let Some(u) = &user {
        if !u
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        {
            return Err(AppError::Invalid("unexpected login name".into()));
        }
    }
    let cmd = crate::vyos_api::ConfigCommand {
        op: "set".into(),
        path: [
            "system",
            "login",
            "user",
            user.as_deref().unwrap_or(&profile.ssh_user),
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
    if user.is_some() {
        return Ok(());
    }
    let dir = state.profiles.dir();
    if let Some(mut secrets) = security::load_secrets(&dir, &profile)? {
        secrets.ssh_password = new_password;
        security::store_secrets(&dir, &profile, &secrets)?;
    }
    Ok(())
}

/// The login VyGi creates for itself.
const OWN_LOGIN: &str = "vygi";

/// Creates a router login just for VyGi (random password, saved by VyGi) and
/// switches this router's saved profile to it. Backups, history and alerts
/// stay with the router: the profile keeps its id.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn use_own_login(state: St, win: Win) -> AppResult<String> {
    let conn = win.conn().await?;
    let mut profile = state.profiles.find(&conn.profile_id)?;
    if profile.ssh_user == OWN_LOGIN {
        return Err(AppError::Invalid("VyGi already uses its own login".into()));
    }
    if crate::transactions::confirm_pending(&conn).await {
        return Err(AppError::Invalid(
            "A Safe Mode change is waiting for Confirm. Confirm it (or let it revert) first."
                .into(),
        ));
    }
    let dir = state.profiles.dir();
    let mut secrets = security::load_secrets(&dir, &profile)?.ok_or_else(|| {
        AppError::Invalid(
            "VyGi needs to remember this router's API key first: reconnect with \"Remember\" ticked"
                .into(),
        )
    })?;
    let mut b = [0u8; 18];
    getrandom::fill(&mut b).map_err(|e| AppError::Invalid(e.to_string()))?;
    let password = hex::encode(b);
    let base = ["system", "login", "user", OWN_LOGIN];
    let cmd = |leaf: &[&str], value: &str| crate::vyos_api::ConfigCommand {
        op: "set".into(),
        path: base.iter().chain(leaf).map(|s| s.to_string()).collect(),
        value: Some(value.to_string()),
    };
    conn.api
        .configure(
            &[
                cmd(&["authentication", "plaintext-password"], &password),
                cmd(&["full-name"], "VyGi"),
            ],
            0,
        )
        .await?;
    conn.api.save().await?;
    // make sure it works before VyGi relies on it
    SshClient::connect(
        &profile.host,
        profile.ssh_port,
        OWN_LOGIN,
        &password,
        profile.ssh_fingerprint.clone(),
    )
    .await
    .map_err(|e| {
        AppError::Invalid(format!(
            "the new login was made, but VyGi couldn't log in with it: {e}"
        ))
    })?;
    profile.key = Some(profile.id());
    profile.ssh_user = OWN_LOGIN.into();
    secrets.ssh_password = password;
    security::store_secrets(&dir, &profile, &secrets)?;
    state.profiles.upsert(&profile)?;
    Ok(OWN_LOGIN.into())
}

/// The commands that give VyGi's own login (vygi) its way in again: its key
/// (or its password), and a random password nobody keeps when it's new.
/// `current`: the router's `system login user vygi` now (Null: missing).
/// None when nothing is missing, or VyGi doesn't use its own login.
pub fn own_login_repair(
    profile: &RouterProfile,
    secret: &str,
    current: &Value,
) -> Option<Vec<crate::vyos_api::ConfigCommand>> {
    if profile.ssh_user != OWN_LOGIN {
        return None;
    }
    let base = ["system", "login", "user", OWN_LOGIN, "authentication"];
    let set = |leaf: &[&str], value: &str| crate::vyos_api::ConfigCommand {
        op: "set".into(),
        path: base.iter().chain(leaf).map(|s| s.to_string()).collect(),
        value: Some(value.to_string()),
    };
    let auth = &current["authentication"];
    let mut cmds = Vec::new();
    if crate::ssh::is_private_key(secret) {
        let (kind, body) = crate::ssh::public_of(secret)?;
        if auth["public-keys"]["vygi"]["key"].as_str() == Some(body.as_str()) {
            return None;
        }
        cmds.push(set(&["public-keys", "vygi", "type"], &kind));
        cmds.push(set(&["public-keys", "vygi", "key"], &body));
        if current.is_null() || auth.get("encrypted-password").is_none() {
            let mut pw = [0u8; 24];
            getrandom::fill(&mut pw).ok()?;
            cmds.push(set(&["plaintext-password"], &hex::encode(pw)));
        }
    } else if current.is_null() {
        cmds.push(set(&["plaintext-password"], secret));
    } else {
        return None;
    }
    Some(cmds)
}

/// A config.boot (backup or old revision) about to be loaded: when it has no
/// `vygi` login yet, adds one (VyGi's key, or its password) so the load itself
/// keeps VyGi's way in. None when there's nothing to add.
pub fn add_own_login(text: &str, profile: &RouterProfile, secret: &str) -> Option<String> {
    if profile.ssh_user != OWN_LOGIN || text.contains("user vygi {") {
        return None;
    }
    let quote = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let mut pw = [0u8; 24];
    getrandom::fill(&mut pw).ok()?;
    let auth = if crate::ssh::is_private_key(secret) {
        let (kind, body) = crate::ssh::public_of(secret)?;
        format!(
            "plaintext-password \"{}\"\npublic-keys vygi {{\nkey \"{body}\"\ntype \"{kind}\"\n}}\n",
            hex::encode(pw)
        )
    } else {
        format!("plaintext-password \"{}\"\n", quote(secret))
    };
    let block = format!("user vygi {{\nauthentication {{\n{auth}}}\nfull-name \"VyGi\"\n}}\n");
    // the first `login {` is system login (the router always has its vyos login there)
    let mut out = String::with_capacity(text.len() + block.len());
    let mut done = false;
    for line in text.split_inclusive('\n') {
        out.push_str(line);
        if !done && line.trim() == "login {" {
            out.push_str(&block);
            done = true;
        }
    }
    done.then_some(out)
}

/// `text` with VyGi's own login added when it lacks it (see [`add_own_login`]).
pub fn with_own_login(app: &crate::state::AppState, profile_id: &str, text: String) -> String {
    let Ok(profile) = app.profiles.find(profile_id) else {
        return text;
    };
    match security::load_secrets(&app.profiles.dir(), &profile) {
        Ok(Some(s)) => add_own_login(&text, &profile, &s.ssh_password).unwrap_or(text),
        _ => text,
    }
}

/// After a restore or rollback: puts VyGi's own login back if the older
/// settings didn't have it, so VyGi isn't locked out. Ok(true) when it did.
pub async fn keep_own_login(
    app: &crate::state::AppState,
    conn: &crate::state::Connection,
) -> AppResult<bool> {
    let profile = app.profiles.find(&conn.profile_id)?;
    if profile.ssh_user != OWN_LOGIN {
        return Ok(false);
    }
    let Some(secrets) = security::load_secrets(&app.profiles.dir(), &profile)? else {
        return Ok(false);
    };
    let current = conn
        .api
        .show_config(&path(&["system", "login", "user", OWN_LOGIN]))
        .await
        .unwrap_or(Value::Null);
    let Some(cmds) = own_login_repair(&profile, &secrets.ssh_password, &current) else {
        return Ok(false);
    };
    conn.api.configure(&cmds, 0).await?;
    Ok(true)
}

/// VyGi's own login uses an SSH key instead of a password: a new Ed25519 key,
/// its public half on the router, checked, then the login's password replaced
/// by a random one nobody keeps (so it can only log in with the key).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn use_ssh_key(state: St, win: Win) -> AppResult<()> {
    let conn = win.conn().await?;
    let profile = state.profiles.find(&conn.profile_id)?;
    if profile.ssh_user != OWN_LOGIN {
        return Err(AppError::Invalid(
            "Make VyGi's own login first (Set up this router): your own login keeps its password"
                .into(),
        ));
    }
    if crate::transactions::confirm_pending(&conn).await {
        return Err(AppError::Invalid(
            "A Safe Mode change is waiting for Confirm. Confirm it (or let it revert) first."
                .into(),
        ));
    }
    let dir = state.profiles.dir();
    let mut secrets = security::load_secrets(&dir, &profile)?
        .ok_or_else(|| AppError::Invalid("VyGi's login isn't saved".into()))?;
    let (private, public) = crate::ssh::new_key("vygi")?;
    let mut parts = public.split_whitespace();
    let (kind, body) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    let base = ["system", "login", "user", OWN_LOGIN, "authentication"];
    let set = |leaf: &[&str], value: &str| crate::vyos_api::ConfigCommand {
        op: "set".into(),
        path: base.iter().chain(leaf).map(|s| s.to_string()).collect(),
        value: Some(value.to_string()),
    };
    conn.api
        .configure(
            &[
                set(&["public-keys", "vygi", "type"], kind),
                set(&["public-keys", "vygi", "key"], body),
            ],
            0,
        )
        .await?;
    // only rely on the key once it works
    SshClient::connect(
        &profile.host,
        profile.ssh_port,
        OWN_LOGIN,
        &private,
        profile.ssh_fingerprint.clone(),
    )
    .await
    .map_err(|e| {
        AppError::Invalid(format!(
            "the router didn't accept the new key, so VyGi keeps using the password: {e}"
        ))
    })?;
    let mut pw = [0u8; 24];
    getrandom::fill(&mut pw).map_err(|e| AppError::Invalid(e.to_string()))?;
    conn.api
        .configure(&[set(&["plaintext-password"], &hex::encode(pw))], 0)
        .await?;
    conn.api.save().await?;
    secrets.ssh_password = private;
    security::store_secrets(&dir, &profile, &secrets)?;
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

#[cfg(test)]
mod own_login_tests {
    use super::*;

    fn profile(user: &str) -> RouterProfile {
        serde_json::from_value(
            serde_json::json!({ "name": "r", "host": "10.0.0.1", "sshUser": user }),
        )
        .unwrap()
    }

    #[test]
    fn repair_puts_vygis_login_back() {
        let (private, _) = crate::ssh::new_key("vygi").unwrap();
        let (_, body) = crate::ssh::public_of(&private).unwrap();
        // an older backup without vygi: key, type and a password nobody keeps
        let cmds = own_login_repair(&profile("vygi"), &private, &Value::Null).unwrap();
        assert_eq!(cmds.len(), 3);
        assert!(cmds
            .iter()
            .any(|c| c.value.as_deref() == Some(body.as_str())));
        // already there: nothing to do
        let have = serde_json::json!({ "authentication": { "encrypted-password": "x", "public-keys": { "vygi": { "key": body, "type": "ssh-ed25519" } } } });
        assert!(own_login_repair(&profile("vygi"), &private, &have).is_none());
        // a password login: only when the login is missing
        assert_eq!(
            own_login_repair(&profile("vygi"), "pw", &Value::Null)
                .unwrap()
                .len(),
            1
        );
        assert!(own_login_repair(
            &profile("vygi"),
            "pw",
            &serde_json::json!({ "authentication": {} })
        )
        .is_none());
        // not VyGi's own login: hands off
        assert!(own_login_repair(&profile("vyos"), &private, &Value::Null).is_none());
    }

    #[test]
    fn old_backups_keep_vygis_login() {
        let (private, _) = crate::ssh::new_key("vygi").unwrap();
        let (_, body) = crate::ssh::public_of(&private).unwrap();
        let old = "interfaces {\n    ethernet eth0 {\n    }\n}\nsystem {\n    host-name \"r\"\n    login {\n        user vyos {\n            authentication {\n                encrypted-password \"$6$x\"\n            }\n        }\n    }\n}\n";
        let new = add_own_login(old, &profile("vygi"), &private).unwrap();
        assert!(new.contains("user vygi {") && new.contains(&body) && new.contains("user vyos {"));
        // the vygi block sits inside login { }, before the vyos user
        assert!(new.find("user vygi {").unwrap() > new.find("login {").unwrap());
        assert!(new.find("user vygi {").unwrap() < new.find("user vyos {").unwrap());
        // already there, or not VyGi's own login: untouched
        assert!(add_own_login(&new, &profile("vygi"), &private).is_none());
        assert!(add_own_login(old, &profile("vyos"), &private).is_none());
        // a password with a quote stays one value
        assert!(add_own_login(old, &profile("vygi"), "a\"b")
            .unwrap()
            .contains("plaintext-password \"a\\\"b\""));
    }
}
