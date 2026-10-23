//! Saved routers and their secrets.
//!
//! Non-secret settings (host, ports, user, pinned fingerprints) live in
//! `routers.json` in the app config dir. Secrets (API key, SSH password) go to
//! the operating system's keychain only: macOS Keychain, Windows Credential
//! Manager, or the Secret Service (GNOME Keyring / KWallet) on Linux.

use std::path::PathBuf;

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

#[derive(Default, Serialize, Deserialize)]
pub struct Secrets {
    pub api_key: String,
    pub ssh_password: String,
}

fn entry(profile: &RouterProfile) -> AppResult<keyring::Entry> {
    Ok(keyring::Entry::new(KEYCHAIN_SERVICE, &profile.id())?)
}

pub fn load_secrets(profile: &RouterProfile) -> AppResult<Option<Secrets>> {
    match entry(profile)?.get_password() {
        Ok(json) => Ok(Some(serde_json::from_str(&json)?)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn store_secrets(profile: &RouterProfile, secrets: &Secrets) -> AppResult<()> {
    entry(profile)?.set_password(&serde_json::to_string(secrets)?)?;
    Ok(())
}

pub fn delete_secrets(profile: &RouterProfile) -> AppResult<()> {
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
