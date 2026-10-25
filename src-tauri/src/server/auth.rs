//! Web login: one password (Argon2 hash in `<data>/server.json`) and
//! random session cookies kept in memory.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::http::{header, HeaderMap};
use serde::{Deserialize, Serialize};

const COOKIE: &str = "vygi_session";
const SESSION_TTL: Duration = Duration::from_secs(30 * 24 * 3600);
/// After this many wrong passwords in [`LOCK_WINDOW`], logins are refused until it passes.
const MAX_FAILS: usize = 10;
const LOCK_WINDOW: Duration = Duration::from_secs(5 * 60);
const MIN_PASSWORD: usize = 10;

#[derive(Serialize, Deserialize, Default)]
struct Stored {
    password_hash: String,
}

pub struct Auth {
    file: PathBuf,
    hash: StdMutex<String>,
    sessions: StdMutex<HashMap<String, Instant>>,
    fails: StdMutex<Vec<Instant>>,
    secure: bool,
}

/// Writes a file only the owner can read (secrets, keys).
pub fn write_private(path: &Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    f.write_all(data).map_err(|e| e.to_string())
}

fn hash_password(pw: &str) -> Result<String, String> {
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).map_err(|e| e.to_string())?;
    let salt = SaltString::encode_b64(&salt).map_err(|e| e.to_string())?;
    Argon2::default()
        .hash_password(pw.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

fn verify(pw: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|h| Argon2::default().verify_password(pw.as_bytes(), &h).is_ok())
        .unwrap_or(false)
}

fn random_token(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    // getrandom only fails on broken systems; a predictable token would be worse than failing.
    getrandom::fill(&mut b).expect("system random generator");
    hex::encode(b)
}

impl Auth {
    /// Loads the password hash. `env_password` (VYGI_PASSWORD) replaces it;
    /// with neither, a random password is made and printed once.
    pub fn load(data: &Path, env_password: Option<&str>, secure: bool) -> Result<Self, String> {
        let file = data.join("server.json");
        let stored: Stored = std::fs::read_to_string(&file)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let hash = match (env_password, stored.password_hash.is_empty()) {
            (Some(pw), _) => {
                if pw.chars().count() < MIN_PASSWORD {
                    return Err(format!(
                        "VYGI_PASSWORD must be at least {MIN_PASSWORD} characters"
                    ));
                }
                if verify(pw, &stored.password_hash) {
                    stored.password_hash
                } else {
                    hash_password(pw)?
                }
            }
            (None, false) => stored.password_hash,
            (None, true) => {
                let pw = random_token(9);
                println!("==============================================================");
                println!(" VyGi web password: {pw}");
                println!(" (shown once; change it in VyGi, or set VYGI_PASSWORD)");
                println!("==============================================================");
                hash_password(&pw)?
            }
        };
        let auth = Auth {
            file,
            hash: StdMutex::new(hash),
            sessions: StdMutex::new(HashMap::new()),
            fails: StdMutex::new(Vec::new()),
            secure,
        };
        auth.save()?;
        Ok(auth)
    }

    fn save(&self) -> Result<(), String> {
        let stored = Stored {
            password_hash: self.hash.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        };
        write_private(
            &self.file,
            serde_json::to_string_pretty(&stored)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )
    }

    fn cookie(&self, value: &str, max_age: u64) -> String {
        format!(
            "{COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{}",
            if self.secure { "; Secure" } else { "" }
        )
    }

    pub fn clear_cookie(&self) -> String {
        self.cookie("", 0)
    }

    /// The session token from the request's cookie, if it's a live session.
    pub fn session(&self, headers: &HeaderMap) -> Option<String> {
        let token = headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(';'))
            .filter_map(|kv| kv.trim().split_once('='))
            .find(|(k, _)| *k == COOKIE)
            .map(|(_, v)| v.to_string())?;
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        match sessions.get(&token) {
            Some(exp) if *exp > Instant::now() => Some(token),
            _ => None,
        }
    }

    /// Checks the password; returns the Set-Cookie value for a new session.
    pub async fn login(&self, password: &str) -> Result<String, String> {
        {
            let mut fails = self.fails.lock().unwrap_or_else(|e| e.into_inner());
            fails.retain(|t| t.elapsed() < LOCK_WINDOW);
            if fails.len() >= MAX_FAILS {
                return Err("Too many wrong passwords. Wait a few minutes.".into());
            }
        }
        let hash = self.hash.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let pw = password.to_string();
        let ok = tokio::task::spawn_blocking(move || verify(&pw, &hash))
            .await
            .unwrap_or(false);
        if !ok {
            self.fails
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(Instant::now());
            tokio::time::sleep(Duration::from_secs(1)).await; // slows down guessing
            return Err("Wrong password".into());
        }
        let token = random_token(32);
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(token.clone(), Instant::now() + SESSION_TTL);
        Ok(self.cookie(&token, SESSION_TTL.as_secs()))
    }

    pub fn logout(&self, headers: &HeaderMap) {
        if let Some(t) = self.session(headers) {
            self.sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&t);
        }
    }

    /// New password; other sessions stay logged in.
    pub async fn change_password(&self, current: &str, new: &str) -> Result<(), String> {
        if new.chars().count() < MIN_PASSWORD {
            return Err(format!("Use at least {MIN_PASSWORD} characters"));
        }
        let hash = self.hash.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let cur = current.to_string();
        if !tokio::task::spawn_blocking(move || verify(&cur, &hash))
            .await
            .unwrap_or(false)
        {
            tokio::time::sleep(Duration::from_secs(1)).await;
            return Err("The current password is wrong".into());
        }
        let new = new.to_string();
        let h = tokio::task::spawn_blocking(move || hash_password(&new))
            .await
            .map_err(|e| e.to_string())??;
        *self.hash.lock().unwrap_or_else(|e| e.into_inner()) = h;
        self.save()
    }

    /// Drops expired sessions.
    pub fn expire(&self) {
        let now = Instant::now();
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, exp| *exp > now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_and_verify() {
        let h = hash_password("correct horse battery").unwrap();
        assert!(verify("correct horse battery", &h));
        assert!(!verify("wrong", &h));
        assert!(!verify("x", "not a hash"));
    }

    #[test]
    fn session_cookie_parsing() {
        let auth = Auth {
            file: PathBuf::new(),
            hash: StdMutex::new(String::new()),
            sessions: StdMutex::new(HashMap::from([
                ("abc".into(), Instant::now() + SESSION_TTL),
                ("old".into(), Instant::now() - Duration::from_secs(1)),
            ])),
            fails: StdMutex::new(Vec::new()),
            secure: true,
        };
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            "x=1; vygi_session=abc; y=2".parse().unwrap(),
        );
        assert_eq!(auth.session(&h).as_deref(), Some("abc"));
        h.insert(header::COOKIE, "vygi_session=old".parse().unwrap());
        assert_eq!(auth.session(&h), None);
        h.insert(header::COOKIE, "vygi_session=nope".parse().unwrap());
        assert_eq!(auth.session(&h), None);
        assert!(auth.cookie("t", 5).contains("; Secure"));
    }
}
