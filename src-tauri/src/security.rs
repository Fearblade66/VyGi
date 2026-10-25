//! Saved routers and their secrets.
//!
//! Non-secret settings (host, ports, user, pinned fingerprints) live in
//! `routers.json` in the app config dir. Secrets (API key, SSH password) go to
//! the operating system's keychain: macOS Keychain, Windows Credential
//! Manager, or the Secret Service (GNOME Keyring / KWallet) on Linux. When the
//! keychain doesn't work, they go to `secrets.json` next to `routers.json`,
//! readable only by the user.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const KEYCHAIN_SERVICE: &str = "vygi";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterProfile {
    pub name: String,
    pub host: String,
    #[serde(default = "default_api_port")]
    pub api_port: u16,
    #[serde(default = "default_ssh_port")]
    pub ssh_port: u16,
    #[serde(default = "default_user")]
    pub ssh_user: String,
    #[serde(default)]
    pub tls_fingerprint: Option<String>,
    #[serde(default)]
    pub ssh_fingerprint: Option<String>,
}

fn default_api_port() -> u16 {
    443
}
fn default_ssh_port() -> u16 {
    22
}
fn default_user() -> String {
    "vyos".into()
}

impl RouterProfile {
    /// Stable identifier used as the keychain account name.
    pub fn id(&self) -> String {
        format!("{}@{}", self.ssh_user, self.host)
    }
}

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Secrets {
    pub api_key: String,
    pub ssh_password: String,
}

/// The web server (Docker) has no OS keychain: secrets go to the file there.
pub const HAS_KEYCHAIN: bool = cfg!(feature = "desktop");

fn entry(profile: &RouterProfile) -> AppResult<keyring::Entry> {
    if !HAS_KEYCHAIN {
        return Err(AppError::Keyring("no OS keychain".into()));
    }
    Ok(keyring::Entry::new(KEYCHAIN_SERVICE, &profile.id())?)
}

/// Where secrets go when the OS keychain doesn't work (e.g. Linux without a
/// keyring service): a file only this user can read, in the app config dir.
fn fallback_path(dir: &Path) -> PathBuf {
    dir.join("secrets.json")
}

fn read_fallback(dir: &Path) -> HashMap<String, Secrets> {
    std::fs::read_to_string(fallback_path(dir))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_fallback(dir: &Path, all: &HashMap<String, Secrets>) -> AppResult<()> {
    let path = fallback_path(dir);
    if all.is_empty() {
        match std::fs::remove_file(&path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        }
    }
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension("json.tmp");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp)?;
    f.write_all(serde_json::to_string(all)?.as_bytes())?;
    drop(f);
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Secrets for a router: from the keychain, else from the fallback file.
pub fn load_secrets(dir: &Path, profile: &RouterProfile) -> AppResult<Option<Secrets>> {
    let from_keychain = match entry(profile).and_then(|e| e.get_password().map_err(Into::into)) {
        Ok(json) => Some(serde_json::from_str(&json)?),
        Err(_) => None, // missing, or no keychain: try the file
    };
    Ok(from_keychain.or_else(|| read_fallback(dir).remove(&profile.id())))
}

/// Saves to the keychain; if that fails, to the fallback file. Returns where
/// it went: `Ok(None)` for the keychain, `Ok(Some(reason))` for the file.
pub fn store_secrets(
    dir: &Path,
    profile: &RouterProfile,
    secrets: &Secrets,
) -> AppResult<Option<String>> {
    let id = profile.id();
    let json = serde_json::to_string(secrets)?;
    let saved = entry(profile).and_then(|e| {
        e.set_password(&json)?;
        // Read it back: some keyrings accept a write they can't return.
        e.get_password().map_err(AppError::from)
    });
    let mut file = read_fallback(dir);
    match saved {
        Ok(back) if back == json => {
            if file.remove(&id).is_some() {
                write_fallback(dir, &file)?;
            }
            Ok(None)
        }
        Ok(_) => store_in_file(
            dir,
            file,
            id,
            secrets,
            "the keychain returned something else".into(),
        ),
        // expected on the server: not worth a warning
        Err(_) if !HAS_KEYCHAIN => {
            store_in_file(dir, file, id, secrets, String::new()).map(|_| None)
        }
        Err(e) => store_in_file(dir, file, id, secrets, e.to_string()),
    }
}

fn store_in_file(
    dir: &Path,
    mut file: HashMap<String, Secrets>,
    id: String,
    secrets: &Secrets,
    reason: String,
) -> AppResult<Option<String>> {
    file.insert(id, secrets.clone());
    write_fallback(dir, &file)?;
    Ok(Some(reason))
}

pub fn delete_secrets(dir: &Path, profile: &RouterProfile) -> AppResult<()> {
    let mut file = read_fallback(dir);
    if file.remove(&profile.id()).is_some() {
        write_fallback(dir, &file)?;
    }
    match entry(profile)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub struct ProfileStore {
    path: PathBuf,
}

impl ProfileStore {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            path: config_dir.join("routers.json"),
        }
    }

    /// The app config directory (where routers.json lives).
    pub fn dir(&self) -> PathBuf {
        self.path.parent().map(PathBuf::from).unwrap_or_default()
    }

    pub fn load(&self) -> AppResult<Vec<RouterProfile>> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => Ok(serde_json::from_str(&text)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }

    fn write(&self, profiles: &[RouterProfile]) -> AppResult<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(profiles)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    /// Inserts or replaces the profile with the same id.
    pub fn upsert(&self, profile: &RouterProfile) -> AppResult<()> {
        let mut all = self.load()?;
        match all.iter_mut().find(|p| p.id() == profile.id()) {
            Some(existing) => *existing = profile.clone(),
            None => all.push(profile.clone()),
        }
        self.write(&all)
    }

    pub fn remove(&self, id: &str) -> AppResult<Option<RouterProfile>> {
        let mut all = self.load()?;
        let pos = all.iter().position(|p| p.id() == id);
        let removed = pos.map(|i| all.remove(i));
        self.write(&all)?;
        Ok(removed)
    }

    pub fn find(&self, id: &str) -> AppResult<RouterProfile> {
        self.load()?
            .into_iter()
            .find(|p| p.id() == id)
            .ok_or_else(|| AppError::Invalid(format!("no saved router `{id}`")))
    }
}
