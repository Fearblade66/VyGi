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
/// After this many wrong passwords from one address in [`LOCK_WINDOW`], that
/// address is refused until it passes (so someone else can't lock you out);
/// after [`MAX_FAILS_ALL`] from all addresses together, everyone is.
const MAX_FAILS: usize = 10;
const MAX_FAILS_ALL: usize = 50;
const LOCK_WINDOW: Duration = Duration::from_secs(5 * 60);
const MIN_PASSWORD: usize = 10;
const LOCKED: &str = "Too many wrong passwords. Wait 5 minutes, or restart VyGi (e.g. docker restart vygi) to clear it.";

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Stored {
    password_hash: String,
    /// addresses that have logged in before (a login from a new one is reported)
    known_ips: Vec<String>,
}

/// A logged-in browser. Kept in `sessions.json` under the SHA-256 of its
/// token (the cookie), so the file can't be used to log in.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Session {
    /// unix ms
    expires: u64,
    created: u64,
    last_seen: u64,
    ip: String,
    agent: String,
}

fn token_hash(token: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// What the session list shows (never the token itself).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub created: u64,
    pub last_seen: u64,
    pub ip: String,
    pub agent: String,
    pub current: bool,
}

pub struct Auth {
    file: PathBuf,
    /// sessions.json (empty path: not kept, in tests)
    sessions_file: PathBuf,
    hash: StdMutex<String>,
    known_ips: StdMutex<Vec<String>>,
    sessions: StdMutex<HashMap<String, Session>>,
    fails: StdMutex<Vec<(Instant, String)>>,
    secure: bool,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A short, stable id for a session (shown in lists and the activity log;
/// it can't be turned back into the cookie).
pub fn session_id(token: &str) -> String {
    token_hash(token)[..10].to_string()
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
        // a password set or reset from Docker (VYGI_PASSWORD) logs every browser out
        let mut reset = false;
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
                    reset = true;
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
        // logins survive restarts and updates (a new password ends them all, see below)
        let sessions_file = data.join("sessions.json");
        let now = now_ms();
        let sessions: HashMap<String, Session> = std::fs::read_to_string(&sessions_file)
            .ok()
            .and_then(|t| serde_json::from_str::<HashMap<String, Session>>(&t).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|(_, s)| s.expires > now && !reset)
            .collect();
        let auth = Auth {
            file,
            sessions_file,
            hash: StdMutex::new(hash),
            known_ips: StdMutex::new(stored.known_ips),
            sessions: StdMutex::new(sessions),
            fails: StdMutex::new(Vec::new()),
            secure,
        };
        auth.save()?;
        Ok(auth)
    }

    fn save(&self) -> Result<(), String> {
        let stored = Stored {
            password_hash: self.hash.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            known_ips: self
                .known_ips
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
        };
        write_private(
            &self.file,
            serde_json::to_string_pretty(&stored)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )
    }

    /// Writes the logged-in browsers (hashed tokens) to sessions.json.
    fn save_sessions(&self) {
        if self.sessions_file.as_os_str().is_empty() {
            return;
        }
        let text = serde_json::to_string(&*self.sessions.lock().unwrap_or_else(|e| e.into_inner()))
            .unwrap_or_default();
        if let Err(e) = write_private(&self.sessions_file, text.as_bytes()) {
            eprintln!("Couldn't save the logins: {e}");
        }
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
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        match sessions.get_mut(&token_hash(&token)) {
            Some(s) if s.expires > now_ms() => {
                s.last_seen = now_ms();
                Some(token)
            }
            _ => None,
        }
    }

    /// Logged-in browsers, newest first; `current` marks the asking one.
    pub fn sessions(&self, current: &str) -> Vec<SessionInfo> {
        let now = now_ms();
        let current = token_hash(current);
        let mut out: Vec<SessionInfo> = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|(_, s)| s.expires > now)
            .map(|(t, s)| SessionInfo {
                id: t[..10].to_string(),
                created: s.created,
                last_seen: s.last_seen,
                ip: s.ip.clone(),
                agent: s.agent.clone(),
                current: *t == current,
            })
            .collect();
        out.sort_by_key(|s| std::cmp::Reverse(s.last_seen));
        out
    }

    /// Ends the session with this id (from [`Auth::sessions`]); true if found.
    pub fn end_session(&self, id: &str) -> bool {
        let ended = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let before = sessions.len();
            sessions.retain(|t, _| !t.starts_with(id) || id.len() < 10);
            before != sessions.len()
        };
        if ended {
            self.save_sessions();
        }
        ended
    }

    /// Notes a successful login's address; true when it's one never seen before.
    pub fn new_ip(&self, ip: &str) -> bool {
        let fresh = {
            let mut known = self.known_ips.lock().unwrap_or_else(|e| e.into_inner());
            if known.iter().any(|k| k == ip) {
                false
            } else {
                known.push(ip.to_string());
                if known.len() > 200 {
                    known.remove(0);
                }
                true
            }
        };
        if fresh {
            let _ = self.save();
        }
        fresh
    }

    /// Whether logins from `ip` are refused right now (too many wrong passwords).
    pub fn is_locked(&self, ip: &str) -> bool {
        self.locked(ip)
    }

    /// Checks the password; returns the Set-Cookie value and the new session's token.
    pub async fn login(
        &self,
        password: &str,
        ip: &str,
        agent: &str,
    ) -> Result<(String, String), String> {
        if self.locked(ip) {
            return Err(LOCKED.into());
        }
        let hash = self.hash.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let pw = password.to_string();
        let ok = tokio::task::spawn_blocking(move || verify(&pw, &hash))
            .await
            .unwrap_or(false);
        if !ok {
            self.failed(ip);
            tokio::time::sleep(Duration::from_secs(1)).await; // slows down guessing
            return Err("Wrong password".into());
        }
        let token = random_token(32);
        let now = now_ms();
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                token_hash(&token),
                Session {
                    expires: now + SESSION_TTL.as_millis() as u64,
                    created: now,
                    last_seen: now,
                    ip: ip.to_string(),
                    agent: agent.chars().take(160).collect(),
                },
            );
        self.save_sessions();
        Ok((self.cookie(&token, SESSION_TTL.as_secs()), token))
    }

    pub fn logout(&self, headers: &HeaderMap) {
        if let Some(t) = self.session(headers) {
            self.sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&token_hash(&t));
            self.save_sessions();
        }
    }

    /// New password; every other session is logged out (someone who knew
    /// the old password loses access), `keep` stays logged in.
    pub async fn change_password(
        &self,
        keep: &str,
        current: &str,
        new: &str,
    ) -> Result<(), String> {
        if new.chars().count() < MIN_PASSWORD {
            return Err(format!("Use at least {MIN_PASSWORD} characters"));
        }
        // a logged-in session guessing the current password counts on its own
        let who = format!("session:{}", session_id(keep));
        if self.locked(&who) {
            return Err(LOCKED.into());
        }
        let hash = self.hash.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let cur = current.to_string();
        if !tokio::task::spawn_blocking(move || verify(&cur, &hash))
            .await
            .unwrap_or(false)
        {
            self.failed(&who);
            tokio::time::sleep(Duration::from_secs(1)).await;
            return Err("The current password is wrong".into());
        }
        let new = new.to_string();
        let h = tokio::task::spawn_blocking(move || hash_password(&new))
            .await
            .map_err(|e| e.to_string())??;
        *self.hash.lock().unwrap_or_else(|e| e.into_inner()) = h;
        self.save()?;
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|t, _| *t == token_hash(keep));
        self.save_sessions();
        Ok(())
    }

    fn locked(&self, ip: &str) -> bool {
        let mut fails = self.fails.lock().unwrap_or_else(|e| e.into_inner());
        fails.retain(|(t, _)| t.elapsed() < LOCK_WINDOW);
        fails.len() >= MAX_FAILS_ALL || fails.iter().filter(|(_, a)| a == ip).count() >= MAX_FAILS
    }

    fn failed(&self, ip: &str) {
        self.fails
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((Instant::now(), ip.to_string()));
    }

    /// Drops expired sessions.
    pub fn expire(&self) {
        let now = now_ms();
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, s| s.expires > now);
        // also keeps "last used" in the file reasonably fresh
        self.save_sessions();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lockout_is_per_address() {
        let a = Auth {
            file: PathBuf::new(),
            sessions_file: PathBuf::new(),
            hash: StdMutex::new(String::new()),
            known_ips: StdMutex::new(Vec::new()),
            sessions: StdMutex::new(HashMap::new()),
            fails: StdMutex::new(Vec::new()),
            secure: true,
        };
        for _ in 0..MAX_FAILS {
            a.failed("10.0.0.9");
        }
        assert!(a.is_locked("10.0.0.9"));
        assert!(
            !a.is_locked("10.0.0.2"),
            "someone else's guesses don't lock you out"
        );
        for i in 0..MAX_FAILS_ALL {
            a.failed(&format!("10.1.0.{i}"));
        }
        assert!(
            a.is_locked("10.0.0.2"),
            "many addresses together still lock"
        );
    }

    #[test]
    fn hash_and_verify() {
        let h = hash_password("correct horse battery").unwrap();
        assert!(verify("correct horse battery", &h));
        assert!(!verify("wrong", &h));
        assert!(!verify("x", "not a hash"));
    }

    fn sess(expires: u64) -> Session {
        Session {
            expires,
            created: 0,
            last_seen: 0,
            ip: String::new(),
            agent: String::new(),
        }
    }

    #[test]
    fn session_cookie_parsing() {
        let auth = Auth {
            file: PathBuf::new(),
            sessions_file: PathBuf::new(),
            hash: StdMutex::new(String::new()),
            known_ips: StdMutex::new(Vec::new()),
            sessions: StdMutex::new(HashMap::from([
                (token_hash("abc"), sess(now_ms() + 60_000)),
                (token_hash("old"), sess(now_ms() - 1_000)),
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

    #[tokio::test]
    async fn password_change_logs_out_others() {
        let mut b = [0u8; 8];
        getrandom::fill(&mut b).unwrap();
        let dir = std::env::temp_dir().join(format!("vygi-auth-{}", hex::encode(b)));
        std::fs::create_dir_all(&dir).unwrap();
        let auth = Auth::load(&dir, Some("first password 1"), true).unwrap();
        let tok = |c: String| {
            c.split(';')
                .next()
                .unwrap()
                .split_once('=')
                .unwrap()
                .1
                .to_string()
        };
        let mine = tok(auth
            .login("first password 1", "1.2.3.4", "test")
            .await
            .unwrap()
            .0);
        let other = tok(auth
            .login("first password 1", "1.2.3.4", "test")
            .await
            .unwrap()
            .0);
        assert!(auth
            .change_password(&mine, "wrong", "second password 2")
            .await
            .is_err());
        auth.change_password(&mine, "first password 1", "second password 2")
            .await
            .unwrap();
        let has = |t: &str| auth.sessions.lock().unwrap().contains_key(&token_hash(t));
        assert!(has(&mine) && !has(&other));
        assert!(auth
            .login("first password 1", "1.2.3.4", "test")
            .await
            .is_err());
        assert!(auth
            .login("second password 2", "1.2.3.4", "test")
            .await
            .is_ok());
        // session list and ending one
        let list = auth.sessions(&mine);
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|s| s.current && s.ip == "1.2.3.4"));
        let other_id = list.iter().find(|s| !s.current).unwrap().id.clone();
        assert!(auth.end_session(&other_id));
        assert_eq!(auth.sessions(&mine).len(), 1);
        // new addresses are noticed once
        assert!(auth.new_ip("10.0.0.9"));
        assert!(!auth.new_ip("10.0.0.9"));
        // logins survive a restart, and the file holds no usable token
        let again = Auth::load(&dir, Some("second password 2"), true).unwrap();
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            format!("vygi_session={mine}").parse().unwrap(),
        );
        assert_eq!(again.session(&h).as_deref(), Some(mine.as_str()));
        let file = std::fs::read_to_string(dir.join("sessions.json")).unwrap();
        assert!(!file.contains(&mine) && file.contains(&token_hash(&mine)));
        // a reset from Docker logs everyone out
        let reset = Auth::load(&dir, Some("third password 3"), true).unwrap();
        assert_eq!(reset.session(&h), None);
    }
}
