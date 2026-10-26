//! API tokens for programs (Claude through MCP, scripts): made in the web
//! UI, shown once, stored only as a SHA-256 hash in `<data>/tokens.json`.
//! "read" tokens can look; "full" tokens can also change settings (always
//! through Safe Mode, see `mcp.rs`).

use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const PREFIX: &str = "vygi_";
const MAX_TOKENS: usize = 20;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Read,
    Full,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    pub id: String,
    pub name: String,
    pub scope: Scope,
    /// unix ms
    pub created: u64,
    pub last_used: Option<u64>,
    /// unix ms after which the token stops working (None = never)
    #[serde(default)]
    pub expires: Option<u64>,
    /// hex SHA-256 of the token (never sent to the UI)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    hash: String,
}

pub struct Tokens {
    file: PathBuf,
    list: StdMutex<Vec<Token>>,
}

fn hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn lock<T>(m: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Tokens {
    pub fn load(data: &Path) -> Self {
        let file = data.join("tokens.json");
        let list = std::fs::read_to_string(&file)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        Tokens {
            file,
            list: StdMutex::new(list),
        }
    }

    fn save(&self) -> Result<(), String> {
        let text = serde_json::to_string_pretty(&*lock(&self.list)).map_err(|e| e.to_string())?;
        super::auth::write_private(&self.file, text.as_bytes())
    }

    /// Tokens for the UI (without hashes).
    pub fn list(&self) -> Vec<Token> {
        lock(&self.list)
            .iter()
            .map(|t| Token {
                hash: String::new(),
                ..t.clone()
            })
            .collect()
    }

    /// Makes a token; returns (its info, the secret, shown once).
    pub fn create(
        &self,
        name: &str,
        scope: Scope,
        now: u64,
        days: Option<u64>,
    ) -> Result<(Token, String), String> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 40 {
            return Err("Give the token a name (up to 40 characters)".into());
        }
        if lock(&self.list).len() >= MAX_TOKENS {
            return Err(format!("At most {MAX_TOKENS} tokens; revoke one first"));
        }
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret).map_err(|e| e.to_string())?;
        let secret = format!("{PREFIX}{}", hex::encode(secret));
        let mut id = [0u8; 6];
        getrandom::fill(&mut id).map_err(|e| e.to_string())?;
        let t = Token {
            id: hex::encode(id),
            name: name.to_string(),
            scope,
            created: now,
            last_used: None,
            expires: days
                .filter(|d| *d > 0)
                .map(|d| now + d.min(3650) * 86_400_000),
            hash: hash(&secret),
        };
        lock(&self.list).push(t.clone());
        self.save()?;
        Ok((
            Token {
                hash: String::new(),
                ..t
            },
            secret,
        ))
    }

    pub fn revoke(&self, id: &str) -> Result<bool, String> {
        let removed = {
            let mut l = lock(&self.list);
            let before = l.len();
            l.retain(|t| t.id != id);
            before != l.len()
        };
        if removed {
            self.save()?;
        }
        Ok(removed)
    }

    /// The token for a secret (`Authorization: Bearer ...`), noting its use.
    pub fn check(&self, secret: &str, now: u64) -> Option<Token> {
        if !secret.starts_with(PREFIX) {
            return None;
        }
        let h = hash(secret);
        let found = {
            let mut l = lock(&self.list);
            let t = l
                .iter_mut()
                .find(|t| t.hash == h && t.expires.map_or(true, |e| now < e))?;
            // write "last used" at most every few minutes
            let stale = t
                .last_used
                .map_or(true, |u| now.saturating_sub(u) > 300_000);
            t.last_used = Some(now);
            (t.clone(), stale)
        };
        if found.1 {
            let _ = self.save();
        }
        Some(found.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_check_revoke() {
        let mut b = [0u8; 8];
        getrandom::fill(&mut b).unwrap();
        let dir = std::env::temp_dir().join(format!("vygi-tok-{}", hex::encode(b)));
        std::fs::create_dir_all(&dir).unwrap();
        let t = Tokens::load(&dir);
        let (info, secret) = t.create("Claude", Scope::Full, 1, None).unwrap();
        assert!(secret.starts_with("vygi_") && secret.len() == 5 + 64);
        assert_eq!(t.check(&secret, 2).unwrap().id, info.id);
        assert!(t.check("vygi_wrong", 2).is_none());
        assert!(t.check("nope", 2).is_none());
        // persisted, hash only
        let text = std::fs::read_to_string(dir.join("tokens.json")).unwrap();
        assert!(!text.contains(&secret[5..]));
        assert_eq!(
            Tokens::load(&dir).check(&secret, 3).unwrap().scope,
            Scope::Full
        );
        assert!(t.list()[0].hash.is_empty());
        assert!(t.create("", Scope::Read, 1, None).is_err());
        // a token past its expiry date stops working
        let (_, short) = t.create("Week", Scope::Read, 1_000, Some(7)).unwrap();
        assert!(t.check(&short, 1_000 + 6 * 86_400_000).is_some());
        assert!(t.check(&short, 1_000 + 7 * 86_400_000).is_none());
        assert!(t.revoke(&info.id).unwrap());
        assert!(t.check(&secret, 4).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
