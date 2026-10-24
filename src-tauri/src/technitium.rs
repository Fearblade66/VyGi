//! Technitium DNS Server integration: stats, block/allow lists, query logs.
//!
//! API reference: TechnitiumSoftware/DnsServer `APIDOCS.md`. Every response is
//! `{ "status": "ok" | "error" | "invalid-token", "response": ..., "errorMessage": ... }`.
//!
//! The server is linked to a router profile: the URL (and pinned HTTPS
//! fingerprint) go to `dns-servers.json`, the API token to the OS keychain.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::{AppState, Win};
use crate::tls::pinned_client_config;

const KEYCHAIN_SERVICE: &str = "vygi-technitium";

/// Endpoints the UI may call through `dns_server_call`, with the parameters each accepts.
const ALLOWED: &[(&str, &[&str])] = &[
    ("dashboard/stats/get", &["type", "utc"]),
    ("dashboard/stats/getTop", &["type", "statsType", "limit"]),
    ("settings/get", &[]),
    ("settings/set", &["enableBlocking"]),
    ("settings/temporaryDisableBlocking", &["minutes"]),
    ("blocked/add", &["domain"]),
    ("blocked/delete", &["domain"]),
    ("blocked/export", &[]),
    ("allowed/add", &["domain"]),
    ("allowed/delete", &["domain"]),
    ("allowed/export", &[]),
    ("cache/flush", &[]),
    ("apps/list", &[]),
    (
        "logs/query",
        &[
            "name",
            "classPath",
            "pageNumber",
            "entriesPerPage",
            "descendingOrder",
            "clientIpAddress",
            "responseType",
            "qname",
        ],
    ),
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DnsServerLink {
    pub url: String,
    #[serde(default)]
    pub tls_fingerprint: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsServerInfo {
    url: String,
    version: String,
    server_name: String,
    /// False when the OS keychain refused; the token then lasts until VyGi quits.
    token_saved: bool,
}

struct Client {
    http: reqwest::Client,
    base: String,
    token: String,
    expected_fp: Option<String>,
    seen_fp: Arc<Mutex<Option<String>>>,
}

/// Accepts "host", "host:port", "http(s)://host[:port][/]" and defaults to http on 5380.
pub fn normalize_url(input: &str) -> AppResult<String> {
    let t = input.trim().trim_end_matches('/');
    if t.is_empty() {
        return Err(AppError::Invalid("DNS server address is empty".into()));
    }
    let with_scheme = if t.starts_with("http://") || t.starts_with("https://") {
        t.to_string()
    } else {
        format!("http://{t}")
    };
    let (scheme, rest) = with_scheme.split_once("://").unwrap_or(("http", ""));
    let host_port = rest.split('/').next().unwrap_or("");
    if host_port.is_empty()
        || !host_port
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-:[]".contains(c))
    {
        return Err(AppError::Invalid(format!(
            "bad DNS server address `{input}`"
        )));
    }
    let has_port = host_port.rsplit_once(':').is_some_and(|(h, p)| {
        !h.ends_with(':') && p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty()
    }) && (!host_port.contains('[') || host_port.contains("]:"));
    let port = if has_port {
        String::new()
    } else if scheme == "https" {
        ":53443".into()
    } else {
        ":5380".into()
    };
    Ok(format!("{scheme}://{host_port}{port}"))
}

impl Client {
    fn new(link: &DnsServerLink, token: String) -> AppResult<Self> {
        let (tls, seen_fp) = pinned_client_config(link.tls_fingerprint.clone())?;
        let http = reqwest::Client::builder()
            .tls_backend_preconfigured(tls)
            .connect_timeout(Duration::from_secs(6))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| AppError::Http(e.to_string()))?;
        Ok(Self {
            http,
            base: link.url.clone(),
            token,
            expected_fp: link.tls_fingerprint.clone(),
            seen_fp,
        })
    }

    fn seen_fingerprint(&self) -> Option<String> {
        self.seen_fp.lock().ok().and_then(|g| g.clone())
    }

    fn transport_error(&self, e: reqwest::Error) -> AppError {
        if let Some(fp) = self.seen_fingerprint() {
            match &self.expected_fp {
                None => return AppError::UntrustedCert { fingerprint: fp },
                Some(expected) if !expected.eq_ignore_ascii_case(&fp) => {
                    return AppError::CertMismatch {
                        expected: expected.clone(),
                        fingerprint: fp,
                    }
                }
                _ => {}
            }
        }
        if e.is_timeout() {
            return AppError::Timeout("the DNS server did not answer in time".into());
        }
        if e.is_connect() {
            return AppError::Http(format!(
                "cannot reach the DNS server at {} (address, port, firewall?)",
                self.base
            ));
        }
        AppError::Http(e.to_string())
    }

    /// Calls `/api/<endpoint>` and returns its `response` part. Text responses
    /// (exports) come back as a string.
    async fn call(&self, endpoint: &str, params: &[(String, String)]) -> AppResult<Value> {
        let v = self.call_raw(endpoint, params).await?;
        Ok(match v {
            Value::String(_) => v,
            mut v => v
                .get_mut("response")
                .map(Value::take)
                .unwrap_or(Value::Null),
        })
    }

    /// Like `call`, but returns the whole JSON body (after checking `status`).
    async fn call_raw(&self, endpoint: &str, params: &[(String, String)]) -> AppResult<Value> {
        let mut req = self
            .http
            .post(format!("{}/api/{endpoint}", self.base))
            .form(params);
        if !self.token.is_empty() {
            req = req.bearer_auth(&self.token);
        }
        let resp = req.send().await.map_err(|e| self.transport_error(e))?;
        let status = resp.status();
        let is_json = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("json"));
        let text = resp.text().await.map_err(|e| self.transport_error(e))?;
        if !is_json {
            if !status.is_success() {
                return Err(AppError::Api(format!("DNS server answered HTTP {status}")));
            }
            return Ok(Value::String(text));
        }
        parse_response(&text)
    }
}

fn parse_response(text: &str) -> AppResult<Value> {
    let v: Value = serde_json::from_str(text).map_err(|_| {
        AppError::Api("the DNS server sent something that isn't Technitium JSON".into())
    })?;
    match v.get("status").and_then(Value::as_str) {
        Some("ok") => Ok(v),
        Some("invalid-token") => Err(AppError::AuthFailed(
            "Technitium rejected the API token (deleted or expired). Set the DNS server up again.".into(),
        )),
        Some("2fa-required") => Err(AppError::AuthFailed(
            "This Technitium account uses 2FA. Create an API token in Technitium (Administration > Sessions > Create Token) and paste it instead.".into(),
        )),
        _ => Err(AppError::Api(
            v.get("errorMessage")
                .and_then(Value::as_str)
                .unwrap_or("unknown error from the DNS server")
                .to_string(),
        )),
    }
}

fn links_path(state: &AppState) -> PathBuf {
    state.profiles.dir().join("dns-servers.json")
}

fn load_links(state: &AppState) -> AppResult<HashMap<String, DnsServerLink>> {
    match std::fs::read_to_string(links_path(state)) {
        Ok(t) => Ok(serde_json::from_str(&t)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(e) => Err(e.into()),
    }
}

fn save_links(state: &AppState, links: &HashMap<String, DnsServerLink>) -> AppResult<()> {
    let path = links_path(state);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(links)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

fn token_entry(profile_id: &str) -> AppResult<keyring::Entry> {
    Ok(keyring::Entry::new(KEYCHAIN_SERVICE, profile_id)?)
}

fn load_token(state: &AppState, profile_id: &str) -> Option<String> {
    if let Some(t) = state
        .dns_tokens
        .lock()
        .ok()
        .and_then(|m| m.get(profile_id).cloned())
    {
        return Some(t);
    }
    token_entry(profile_id).ok()?.get_password().ok()
}

/// Stores the token in the keychain; falls back to memory. Returns whether it was saved.
fn store_token(state: &AppState, profile_id: &str, token: &str) -> bool {
    let saved = token_entry(profile_id)
        .and_then(|e| e.set_password(token).map_err(AppError::from))
        .is_ok();
    if let Ok(mut m) = state.dns_tokens.lock() {
        if saved {
            m.remove(profile_id);
        } else {
            m.insert(profile_id.to_string(), token.to_string());
        }
    }
    saved
}

async fn profile_id(win: &Win) -> AppResult<String> {
    Ok(win.conn().await?.profile_id.clone())
}

async fn client(state: &AppState, win: &Win) -> AppResult<Client> {
    let id = profile_id(win).await?;
    let link = load_links(state)?
        .remove(&id)
        .ok_or_else(|| AppError::Invalid("No DNS server is set up for this router".into()))?;
    let token = load_token(state, &id).ok_or_else(|| {
        AppError::AuthFailed(
            "The Technitium API token is missing. Set the DNS server up again.".into(),
        )
    })?;
    Client::new(&link, token)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStatus {
    url: String,
    /// False when the token is gone (e.g. no OS keychain and VyGi restarted).
    has_token: bool,
}

/// The DNS server linked to this router, or null when none is set up.
#[tauri::command]
pub async fn dns_server_link(
    state: State<'_, AppState>,
    win: Win,
) -> AppResult<Option<LinkStatus>> {
    let id = profile_id(&win).await?;
    Ok(load_links(&state)?.remove(&id).map(|l| LinkStatus {
        url: l.url,
        has_token: load_token(&state, &id).is_some(),
    }))
}

/// Links a Technitium server to the connected router. Give either an API
/// token, or a username and password from which VyGi creates a named token.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn dns_server_setup(
    state: State<'_, AppState>,
    win: Win,
    url: String,
    token: Option<String>,
    user: Option<String>,
    password: Option<String>,
    trust_tls: Option<String>,
) -> AppResult<DnsServerInfo> {
    let id = profile_id(&win).await?;
    let url = normalize_url(&url)?;
    let mut links = load_links(&state)?;
    let pinned = trust_tls.or_else(|| {
        links
            .get(&id)
            .filter(|l| l.url == url)
            .and_then(|l| l.tls_fingerprint.clone())
    });
    let mut link = DnsServerLink {
        url: url.clone(),
        tls_fingerprint: pinned,
    };

    let token = match (
        token.filter(|t| !t.trim().is_empty()),
        user.filter(|u| !u.trim().is_empty()),
    ) {
        (Some(t), _) => t.trim().to_string(),
        (None, Some(user)) => {
            let anon = Client::new(&link, String::new())?;
            let host = win.conn().await?.profile_id.clone();
            let created = anon
                .call_raw(
                    "user/createToken",
                    &[
                        ("user".into(), user),
                        ("pass".into(), password.unwrap_or_default()),
                        ("tokenName".into(), format!("VyGi ({host})")),
                    ],
                )
                .await?;
            // createToken puts the token at the top level, not under "response".
            created["token"].as_str().unwrap_or_default().to_string()
        }
        (None, None) => {
            return Err(AppError::Invalid(
                "Enter an API token, or a username and password".into(),
            ))
        }
    };
    let token = if token.is_empty() {
        return Err(AppError::Api("Technitium did not return a token".into()));
    } else {
        token
    };

    let c = Client::new(&link, token.clone())?;
    let settings = c.call("settings/get", &[]).await?;
    link.tls_fingerprint = c.seen_fingerprint().or(link.tls_fingerprint);
    let token_saved = store_token(&state, &id, &token);
    links.insert(id, link);
    save_links(&state, &links)?;
    Ok(DnsServerInfo {
        url,
        version: settings["version"].as_str().unwrap_or("?").to_string(),
        server_name: settings["dnsServerDomain"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        token_saved,
    })
}

/// Unlinks the DNS server from this router and forgets its token.
#[tauri::command]
pub async fn dns_server_forget(state: State<'_, AppState>, win: Win) -> AppResult<()> {
    let id = profile_id(&win).await?;
    let mut links = load_links(&state)?;
    links.remove(&id);
    save_links(&state, &links)?;
    if let Ok(mut m) = state.dns_tokens.lock() {
        m.remove(&id);
    }
    if let Ok(e) = token_entry(&id) {
        let _ = e.delete_credential();
    }
    Ok(())
}

/// Calls one of the allowed Technitium endpoints with the given parameters.
#[tauri::command]
pub async fn dns_server_call(
    state: State<'_, AppState>,
    win: Win,
    endpoint: String,
    params: HashMap<String, String>,
) -> AppResult<Value> {
    let (_, allowed) = ALLOWED
        .iter()
        .find(|(e, _)| *e == endpoint)
        .ok_or_else(|| AppError::Invalid(format!("DNS server call `{endpoint}` is not allowed")))?;
    if let Some(bad) = params.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(AppError::Invalid(format!(
            "parameter `{bad}` is not allowed for {endpoint}"
        )));
    }
    let params: Vec<(String, String)> = params.into_iter().collect();
    client(&state, &win).await?.call(&endpoint, &params).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_urls() {
        assert_eq!(
            normalize_url("192.168.1.5").unwrap(),
            "http://192.168.1.5:5380"
        );
        assert_eq!(
            normalize_url("dns.lan:8080/").unwrap(),
            "http://dns.lan:8080"
        );
        assert_eq!(
            normalize_url("https://dns.lan").unwrap(),
            "https://dns.lan:53443"
        );
        assert_eq!(
            normalize_url("https://dns.lan:443").unwrap(),
            "https://dns.lan:443"
        );
        assert_eq!(normalize_url("[fd00::5]").unwrap(), "http://[fd00::5]:5380");
        assert_eq!(
            normalize_url("[fd00::5]:99").unwrap(),
            "http://[fd00::5]:99"
        );
        assert!(normalize_url("").is_err());
        assert!(normalize_url("bad host").is_err());
    }

    #[test]
    fn parses_responses() {
        let ok = parse_response(r#"{"response":{"a":1},"status":"ok"}"#).unwrap();
        assert_eq!(ok["response"]["a"], 1);
        let err = parse_response(r#"{"status":"error","errorMessage":"Invalid domain name"}"#)
            .unwrap_err();
        assert!(err.to_string().contains("Invalid domain name"));
        assert!(matches!(
            parse_response(r#"{"status":"invalid-token"}"#),
            Err(AppError::AuthFailed(_))
        ));
    }
}
