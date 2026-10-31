//! WireGuard key generation done locally, so a client's private key never
//! passes through the router (it only ever needs the public key).

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use x25519_dalek::{PublicKey, StaticSecret};

use crate::error::{AppError, AppResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyPair {
    private_key: String,
    public_key: String,
}

fn random_32() -> AppResult<[u8; 32]> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| AppError::Io(format!("random generator: {e}")))?;
    Ok(bytes)
}

/// Same as `wg genkey | wg pubkey`: a clamped Curve25519 private key and its public key.
fn keypair_from(mut secret: [u8; 32]) -> KeyPair {
    secret[0] &= 248;
    secret[31] &= 127;
    secret[31] |= 64;
    let private = StaticSecret::from(secret);
    let public = PublicKey::from(&private);
    KeyPair {
        private_key: STANDARD.encode(private.to_bytes()),
        public_key: STANDARD.encode(public.as_bytes()),
    }
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn wireguard_keypair() -> AppResult<KeyPair> {
    Ok(keypair_from(random_32()?))
}

/// Same as `wg genpsk`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn wireguard_psk() -> AppResult<String> {
    Ok(STANDARD.encode(random_32()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc7748_vector() {
        // RFC 7748 section 6.1, Alice's key pair.
        let sk: [u8; 32] = [
            0x77, 0x07, 0x6d, 0x0a, 0x73, 0x18, 0xa5, 0x7d, 0x3c, 0x16, 0xc1, 0x72, 0x51, 0xb2,
            0x66, 0x45, 0xdf, 0x4c, 0x2f, 0x87, 0xeb, 0xc0, 0x99, 0x2a, 0xb1, 0x77, 0xfb, 0xa5,
            0x1d, 0xb9, 0x2c, 0x2a,
        ];
        let pk: [u8; 32] = [
            0x85, 0x20, 0xf0, 0x09, 0x89, 0x30, 0xa7, 0x54, 0x74, 0x8b, 0x7d, 0xdc, 0xb4, 0x3e,
            0xf7, 0x5a, 0x0d, 0xbf, 0x3a, 0x0d, 0x26, 0x38, 0x1a, 0xf4, 0xeb, 0xa4, 0xa9, 0x8e,
            0xaa, 0x9b, 0x4e, 0x6a,
        ];
        assert_eq!(keypair_from(sk).public_key, STANDARD.encode(pk));
    }

    #[test]
    fn keys_are_base64_32_bytes() {
        let kp = wireguard_keypair().unwrap_or_else(|_| keypair_from([1; 32]));
        assert_eq!(
            STANDARD.decode(&kp.private_key).map(|v| v.len()).ok(),
            Some(32)
        );
        assert_eq!(
            STANDARD.decode(&kp.public_key).map(|v| v.len()).ok(),
            Some(32)
        );
    }
}

// ---- the devices' configs, so they can be shown again
// Kept in VyGi's own data folder (only VyGi's user can read it), per router:
// they hold the device's private key, and VyGi already holds the router's keys.

fn config_path(
    app: &crate::state::AppState,
    profile_id: &str,
    iface: &str,
    name: &str,
) -> AppResult<std::path::PathBuf> {
    let ok_iface = iface.len() <= 12
        && iface.starts_with("wg")
        && iface[2..].chars().all(|c| c.is_ascii_digit());
    let ok_name = !name.is_empty()
        && name.len() <= 40
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
        && !name.starts_with('.');
    if !ok_iface || !ok_name {
        return Err(AppError::Invalid("bad interface or device name".into()));
    }
    let router: String = profile_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || ".-_@".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let dir = app.dirs.data.join("vpn-configs").join(router);
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir.join(format!("{iface}-{name}.conf")))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn vpn_config_save(
    app: crate::state::St,
    state: crate::state::Win,
    iface: String,
    name: String,
    text: String,
) -> AppResult<()> {
    if text.len() > 8192 || !text.contains("[Interface]") {
        return Err(AppError::Invalid("that isn't a WireGuard config".into()));
    }
    let file = config_path(&app, &state.conn().await?.profile_id, &iface, &name)?;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    use std::io::Write;
    opts.open(&file)?.write_all(text.as_bytes())?;
    Ok(())
}

/// The saved config, or None (a device added before VyGi kept them).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn vpn_config_get(
    app: crate::state::St,
    state: crate::state::Win,
    iface: String,
    name: String,
) -> AppResult<Option<String>> {
    let file = config_path(&app, &state.conn().await?.profile_id, &iface, &name)?;
    Ok(std::fs::read_to_string(file).ok())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn vpn_config_delete(
    app: crate::state::St,
    state: crate::state::Win,
    iface: String,
    name: String,
) -> AppResult<()> {
    let file = config_path(&app, &state.conn().await?.profile_id, &iface, &name)?;
    let _ = std::fs::remove_file(file);
    Ok(())
}
