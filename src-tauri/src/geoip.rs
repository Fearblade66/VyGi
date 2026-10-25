//! Offline IP -> country and network owner (ASN) lookups, used to show where
//! devices' traffic goes. Data: DB-IP Lite (CC BY 4.0), as packaged by the
//! ip-location-db project on the npm registry. Downloaded once on request,
//! verified against the registry's SHA-512, then used locally: lookups never
//! leave this computer.

use std::collections::HashMap;
use std::io::Read;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use maxminddb::Reader;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha512};
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::tls::public_client;

/// (npm package, file inside it, local file name)
const DATABASES: [(&str, &str, &str); 2] = [
    ("dbip-country-mmdb", "dbip-country.mmdb", "country.mmdb"),
    ("dbip-asn-mmdb", "dbip-asn.mmdb", "asn.mmdb"),
];
const REGISTRY: &str = "https://registry.npmjs.org/@ip-location-db";
const MAX_TARBALL: usize = 100 * 1024 * 1024;
const MAX_LOOKUPS: usize = 5000;

pub struct GeoDb {
    country: Reader<Vec<u8>>,
    asn: Reader<Vec<u8>>,
}

#[derive(Deserialize)]
struct CountryRecord {
    country_code: Option<String>,
}

#[derive(Deserialize)]
struct AsnRecord {
    autonomous_system_number: Option<u32>,
    autonomous_system_organization: Option<String>,
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeoInfo {
    country: Option<String>,
    asn: Option<u32>,
    org: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GeoStatus {
    installed: bool,
    /// Package versions, e.g. "2.3.2026060120" (the date is in the version).
    versions: HashMap<String, String>,
    /// Unix seconds of the last download.
    updated_at: Option<u64>,
}

fn dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Invalid(format!("no app data dir: {e}")))?
        .join("geoip"))
}

fn read_status(dir: &Path) -> GeoStatus {
    let mut st: GeoStatus = std::fs::read_to_string(dir.join("status.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    st.installed = DATABASES.iter().all(|(_, _, f)| dir.join(f).is_file());
    st
}

fn open(dir: &Path) -> AppResult<GeoDb> {
    let load = |name: &str| -> AppResult<Reader<Vec<u8>>> {
        let bytes = std::fs::read(dir.join(name))?;
        Reader::from_source(bytes)
            .map_err(|e| AppError::Invalid(format!("GeoIP database {name} is damaged: {e}")))
    };
    Ok(GeoDb {
        country: load("country.mmdb")?,
        asn: load("asn.mmdb")?,
    })
}

/// Looks one address up. Private and invalid addresses give an empty result.
pub fn lookup(db: &GeoDb, ip: &str) -> GeoInfo {
    let Ok(addr) = ip.parse::<IpAddr>() else {
        return GeoInfo::default();
    };
    let country = db
        .country
        .lookup(addr)
        .ok()
        .and_then(|r| r.decode::<CountryRecord>().ok().flatten())
        .and_then(|r| r.country_code)
        .filter(|c| c.len() == 2 && c != "ZZ");
    let asn = db
        .asn
        .lookup(addr)
        .ok()
        .and_then(|r| r.decode::<AsnRecord>().ok().flatten());
    GeoInfo {
        country,
        asn: asn.as_ref().and_then(|a| a.autonomous_system_number),
        org: asn.and_then(|a| a.autonomous_system_organization),
    }
}

/// Checks an npm `sha512-<base64>` integrity string.
fn integrity_ok(data: &[u8], integrity: &str) -> bool {
    let Some(b64) = integrity.strip_prefix("sha512-") else {
        return false;
    };
    let Ok(expected) = base64::engine::general_purpose::STANDARD.decode(b64) else {
        return false;
    };
    Sha512::digest(data).as_slice() == expected.as_slice()
}

/// Pulls `package/<file>` out of a .tgz.
fn extract(tgz: &[u8], file: &str) -> AppResult<Vec<u8>> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(tgz));
    let want = format!("package/{file}");
    for entry in archive.entries()? {
        let mut entry = entry?;
        if entry.path()?.to_string_lossy() == want {
            let mut out = Vec::new();
            entry.read_to_end(&mut out)?;
            return Ok(out);
        }
    }
    Err(AppError::Invalid(format!(
        "{file} is missing from the download"
    )))
}

async fn download(
    client: &reqwest::Client,
    package: &str,
    file: &str,
) -> AppResult<(String, Vec<u8>)> {
    let http = |e: reqwest::Error| AppError::Http(format!("GeoIP download failed: {e}"));
    let meta: Value = client
        .get(format!("{REGISTRY}/{package}/latest"))
        .send()
        .await
        .map_err(http)?
        .error_for_status()
        .map_err(http)?
        .json()
        .await
        .map_err(http)?;
    let version = meta["version"].as_str().unwrap_or("?").to_string();
    let tarball = meta["dist"]["tarball"].as_str().unwrap_or_default();
    let integrity = meta["dist"]["integrity"].as_str().unwrap_or_default();
    if !tarball.starts_with("https://registry.npmjs.org/") {
        return Err(AppError::Invalid(format!(
            "unexpected download location `{tarball}`"
        )));
    }
    let resp = client
        .get(tarball)
        .send()
        .await
        .map_err(http)?
        .error_for_status()
        .map_err(http)?;
    if resp
        .content_length()
        .is_some_and(|l| l as usize > MAX_TARBALL)
    {
        return Err(AppError::Invalid(
            "GeoIP download is unexpectedly large".into(),
        ));
    }
    let data = resp.bytes().await.map_err(http)?;
    if data.len() > MAX_TARBALL {
        return Err(AppError::Invalid(
            "GeoIP download is unexpectedly large".into(),
        ));
    }
    if !integrity_ok(&data, integrity) {
        return Err(AppError::Invalid(format!(
            "{package}: checksum mismatch, download rejected"
        )));
    }
    let tgz = data.to_vec();
    let file = file.to_string();
    let mmdb = tauri::async_runtime::spawn_blocking(move || extract(&tgz, &file))
        .await
        .map_err(|e| AppError::Invalid(e.to_string()))??;
    Reader::from_source(mmdb.as_slice())
        .map_err(|e| AppError::Invalid(format!("{package}: not a valid database: {e}")))?;
    Ok((version, mmdb))
}

fn loaded(app: &AppHandle, state: &AppState) -> AppResult<Option<Arc<GeoDb>>> {
    if let Some(db) = state.geo.lock().ok().and_then(|g| g.clone()) {
        return Ok(Some(db));
    }
    let dir = dir(app)?;
    if !read_status(&dir).installed {
        return Ok(None);
    }
    let db = Arc::new(open(&dir)?);
    if let Ok(mut g) = state.geo.lock() {
        *g = Some(db.clone());
    }
    Ok(Some(db))
}

#[tauri::command]
pub fn geoip_status(app: AppHandle) -> AppResult<GeoStatus> {
    Ok(read_status(&dir(&app)?))
}

/// Downloads (or refreshes) both databases.
#[tauri::command]
pub async fn geoip_update(app: AppHandle, state: State<'_, AppState>) -> AppResult<GeoStatus> {
    let dir = dir(&app)?;
    std::fs::create_dir_all(&dir)?;
    let client = public_client(Duration::from_secs(300))?;
    let mut st = read_status(&dir);
    for (package, file, local) in DATABASES {
        let (version, data) = download(&client, package, file).await?;
        let tmp = dir.join(format!("{local}.tmp"));
        std::fs::write(&tmp, &data)?;
        std::fs::rename(&tmp, dir.join(local))?;
        st.versions.insert(package.to_string(), version);
    }
    st.updated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs());
    st.installed = true;
    std::fs::write(dir.join("status.json"), serde_json::to_string_pretty(&st)?)?;
    if let Ok(mut g) = state.geo.lock() {
        *g = None; // reload on next lookup
    }
    Ok(st)
}

/// Country and network owner for each address. Empty map if the databases
/// aren't downloaded yet.
#[tauri::command]
pub fn geoip_lookup(
    app: AppHandle,
    state: State<'_, AppState>,
    ips: Vec<String>,
) -> AppResult<HashMap<String, GeoInfo>> {
    let Some(db) = loaded(&app, &state)? else {
        return Ok(HashMap::new());
    };
    Ok(ips
        .into_iter()
        .take(MAX_LOOKUPS)
        .map(|ip| {
            let info = lookup(&db, &ip);
            (ip, info)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_integrity() {
        let data = b"hello";
        let good = format!(
            "sha512-{}",
            base64::engine::general_purpose::STANDARD.encode(Sha512::digest(data))
        );
        assert!(integrity_ok(data, &good));
        assert!(!integrity_ok(b"hellO", &good));
        assert!(!integrity_ok(data, "sha1-abc"));
    }

    /// Runs against real databases: VYGI_GEOIP_DIR=<dir with country.mmdb and asn.mmdb>.
    #[test]
    fn real_lookups() {
        let Ok(d) = std::env::var("VYGI_GEOIP_DIR") else {
            return;
        };
        let db = open(&PathBuf::from(d)).expect("open");
        let g = lookup(&db, "8.8.8.8");
        assert_eq!(g.country.as_deref(), Some("US"));
        assert_eq!(g.asn, Some(15169));
        assert!(g.org.unwrap_or_default().to_lowercase().contains("google"));
        assert_eq!(lookup(&db, "192.168.1.1"), GeoInfo::default());
        assert_eq!(lookup(&db, "not-an-ip"), GeoInfo::default());
        assert!(lookup(&db, "2a00:1450:4001::1").country.is_some());
    }
}
