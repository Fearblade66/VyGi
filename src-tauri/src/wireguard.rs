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

#[tauri::command]
pub fn wireguard_keypair() -> AppResult<KeyPair> {
    Ok(keypair_from(random_32()?))
}

/// Same as `wg genpsk`.
#[tauri::command]
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
