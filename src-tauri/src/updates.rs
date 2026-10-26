//! VyOS update check: compares the router's version with the newest image in
//! the same version list `show system updates` uses (the router's own
//! `system update-check url`, or the public rolling list for rolling builds).
//! Installing goes through `image_add` (sysinfo.rs).

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::connection::path;
use crate::error::{AppError, AppResult};
use crate::state::Connection;
use crate::state::Win;
use crate::tls::public_client;

/// Public lists of rolling (nightly) builds for amd64, tried in order: the
/// one the VyOS rolling docs give, then the older repository's copy.
pub const ROLLING_URLS: [&str; 2] = [
    "https://raw.githubusercontent.com/vyos/vyos-nightly-build/rolling/version.json",
    "https://raw.githubusercontent.com/vyos/vyos-rolling-nightly-builds/rolling/version.json",
];

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// e.g. "2026.10.23-0026-rolling"
    pub local: String,
    /// "rolling", "sagitta", "circinus", …
    pub train: String,
    /// The newest version in the list ("" when unknown).
    pub remote: String,
    /// Image to install when an update is available.
    pub url: String,
    pub available: bool,
    /// Why VyGi can't check or install (stable builds without an update URL,
    /// containers); empty when it can.
    pub unsupported: String,
}

/// (version, release train, architecture, boot via) from `show version`.
fn parse_version(text: &str) -> (String, String, String, String) {
    let field = |name: &str| {
        text.lines()
            .find_map(|l| {
                l.strip_prefix(name)
                    .map(|v| v.trim_start_matches(':').trim().to_string())
            })
            .unwrap_or_default()
    };
    let version = field("Version")
        .trim_start_matches("VyOS")
        .trim()
        .to_string();
    (
        version,
        field("Release train"),
        field("Architecture"),
        field("Boot via"),
    )
}

/// Newest entry of a version list: VyOS lists the newest first.
fn newest(list: &Value) -> Option<(String, String)> {
    let first = list.as_array()?.first()?;
    let version = first.get("version")?.as_str()?.trim().to_string();
    let url = first.get("url")?.as_str()?.trim().to_string();
    (!version.is_empty() && url.starts_with("https://")).then_some((version, url))
}

/// The router's version info and the list URL to compare with.
/// The router's version info and the lists to compare with, best first.
async fn local_info(conn: &Connection) -> AppResult<(UpdateInfo, Vec<String>)> {
    let text = conn.api.show(&path(&["version"])).await?;
    let (local, train, arch, boot) = parse_version(&text);
    let configured = conn
        .api
        .return_value(&path(&["system", "update-check", "url"]))
        .await
        .ok()
        .flatten()
        .filter(|u| u.starts_with("https://"));
    let mut info = UpdateInfo {
        local,
        train: train.clone(),
        ..Default::default()
    };
    // the router's own setting first; for rolling amd64 builds the public lists
    // as fallbacks (a stale configured URL shouldn't break the check)
    let rolling = train == "rolling" && (arch == "x86_64" || arch == "amd64");
    let mut urls: Vec<String> = configured.into_iter().collect();
    if rolling {
        urls.extend(ROLLING_URLS.iter().map(|u| u.to_string()));
    }
    urls.dedup();
    if urls.is_empty() {
        info.unsupported = "This is a stable (LTS) VyOS build: updates come with your VyOS subscription, or set system update-check url to your build's version list.".into();
    }
    if boot.contains("container") {
        info.unsupported =
            "This VyOS runs in a container: update it by running a newer container image.".into();
    }
    Ok((info, urls))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn update_check(state: Win) -> AppResult<UpdateInfo> {
    check(&*state.conn().await?).await
}

pub async fn check(conn: &Connection) -> AppResult<UpdateInfo> {
    let (mut info, urls) = local_info(conn).await?;
    if !info.unsupported.is_empty() {
        return Ok(info);
    }
    let client = public_client(Duration::from_secs(20))?;
    let mut last = String::new();
    let mut found = None;
    for url in &urls {
        let got: Result<Value, String> = async {
            client
                .get(url)
                .send()
                .await
                .and_then(|r| r.error_for_status())
                .map_err(|e| e.to_string())?
                .json()
                .await
                .map_err(|e| format!("not valid JSON: {e}"))
        }
        .await;
        match got.map(|list| newest(&list)) {
            Ok(Some(n)) => {
                found = Some(n);
                break;
            }
            Ok(None) => last = format!("{url} lists no versions"),
            Err(e) => last = e,
        }
    }
    let (remote, image) =
        found.ok_or_else(|| AppError::Http(format!("couldn't get the version list: {last}")))?;
    info.available = remote != info.local;
    info.url = if info.available { image } else { String::new() };
    info.remote = remote;
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_fields() {
        let text = "sudo: unable to resolve host vyos\nVersion:          VyOS 2026.10.23-0026-rolling\nRelease train:    rolling\n\nArchitecture:     x86_64\nBoot via:         installed image\n";
        assert_eq!(
            parse_version(text),
            (
                "2026.10.23-0026-rolling".into(),
                "rolling".into(),
                "x86_64".into(),
                "installed image".into()
            )
        );
    }

    #[test]
    fn newest_entry() {
        let list = serde_json::json!([
            {"version": "2026.10.25-0019-rolling", "url": "https://github.com/vyos/vyos-nightly-build/releases/download/2026.10.25-0019-rolling/vyos-2026.10.25-0019-rolling-generic-amd64.iso"},
            {"version": "2026.10.24-0019-rolling", "url": "https://example/old.iso"}
        ]);
        let (v, u) = newest(&list).unwrap();
        assert_eq!(v, "2026.10.25-0019-rolling");
        assert!(u.ends_with("generic-amd64.iso"));
        assert!(newest(&serde_json::json!([{"version": "x", "url": "http://insecure"}])).is_none());
        assert!(newest(&serde_json::json!({})).is_none());
    }
}
