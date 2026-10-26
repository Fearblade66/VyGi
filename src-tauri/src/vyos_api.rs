//! Client for the VyOS HTTPS REST API (`service https api rest`).
//!
//! Endpoint reference: vyos-1x `src/services/api/rest/routers.py`.
//! Every response is `{ "success": bool, "data": any, "error": string|null }`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::tls::pinned_client_config;

/// Marks an HTTP 500 from the router (see `post_with_timeout`).
const TRANSIENT: &str = "router busy (HTTP 500): ";

/// One `set` / `delete` / `comment` operation for `/configure`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigCommand {
    pub op: String,
    pub path: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

pub struct VyosApi {
    client: reqwest::Client,
    base: String,
    key: String,
    expected_fp: Option<String>,
    seen_fp: Arc<Mutex<Option<String>>>,
}

#[derive(Deserialize)]
struct ApiResponse {
    success: bool,
    #[serde(default)]
    data: Value,
    #[serde(default)]
    error: Option<String>,
}

impl VyosApi {
    pub fn new(host: &str, port: u16, key: String, pinned_fp: Option<String>) -> AppResult<Self> {
        let (tls, seen_fp) = pinned_client_config(pinned_fp.clone())?;
        let client = reqwest::Client::builder()
            // Routers and DNS servers are local: never through a system proxy.
            .no_proxy()
            .tls_backend_preconfigured(tls)
            .connect_timeout(Duration::from_secs(8))
            // Commits can take a while on big configs.
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| AppError::Http(e.to_string()))?;
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]") // bare IPv6 literal
        } else {
            host.to_string()
        };
        Ok(Self {
            client,
            base: format!("https://{host}:{port}"),
            key,
            expected_fp: pinned_fp,
            seen_fp,
        })
    }

    /// Fingerprint of the certificate the router presented on the last request.
    pub fn seen_fingerprint(&self) -> Option<String> {
        self.seen_fp.lock().ok().and_then(|g| g.clone())
    }

    fn classify_transport_error(&self, e: reqwest::Error) -> AppError {
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
            return AppError::Timeout("the router did not answer in time".into());
        }
        if e.is_connect() {
            return AppError::Http(format!(
                "cannot reach {} (is `service https` enabled and the port right?)",
                self.base
            ));
        }
        AppError::Http(e.to_string())
    }

    async fn post(&self, endpoint: &str, body: Value) -> AppResult<Value> {
        self.post_with_timeout(endpoint, body, None).await
    }

    /// Reads (`/retrieve`, `/show`) are retried (up to about 11 s) when the router answers HTTP
    /// 500 "An internal error occurred": VyOS gives that for a few seconds
    /// while a commit or save is rewriting the config. Changes are never retried.
    async fn post_with_timeout(
        &self,
        endpoint: &str,
        body: Value,
        timeout: Option<Duration>,
    ) -> AppResult<Value> {
        let read_only = matches!(endpoint, "/retrieve" | "/show");
        let mut attempt = 0u64;
        loop {
            match self.post_once(endpoint, body.clone(), timeout).await {
                Err(AppError::Api(m)) if read_only && attempt < 7 && m.starts_with(TRANSIENT) => {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(400 * attempt)).await;
                }
                Err(AppError::Api(m)) if read_only && m.starts_with(TRANSIENT) => {
                    return Err(AppError::Api(
                        "The router is busy saving a change and couldn't answer. Try again in a moment.".into(),
                    ))
                }
                Err(AppError::Api(m)) if m.starts_with(TRANSIENT) => {
                    return Err(AppError::Api(clean_error(&m[TRANSIENT.len()..])))
                }
                other => return other,
            }
        }
    }

    async fn post_once(
        &self,
        endpoint: &str,
        mut body: Value,
        timeout: Option<Duration>,
    ) -> AppResult<Value> {
        if let Value::Object(map) = &mut body {
            map.insert("key".into(), Value::String(self.key.clone()));
        }
        let mut req = self
            .client
            .post(format!("{}{}", self.base, endpoint))
            .header("X-API-Key", &self.key)
            .json(&body);
        if let Some(t) = timeout {
            req = req.timeout(t);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| self.classify_transport_error(e))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| AppError::Http(e.to_string()))?;
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(AppError::AuthFailed("API key rejected".into()));
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(AppError::Api(format!(
                "{endpoint} not found. Enable it on the router with `set service https api rest` and commit."
            )));
        }
        if status == reqwest::StatusCode::INTERNAL_SERVER_ERROR {
            return Err(AppError::Api(format!(
                "{TRANSIENT}{}",
                truncate(&text, 300)
            )));
        }
        let parsed: ApiResponse = serde_json::from_str(&text).map_err(|_| {
            AppError::Api(format!(
                "unexpected reply (HTTP {status}): {}",
                truncate(&text, 300)
            ))
        })?;
        if parsed.success {
            Ok(parsed.data)
        } else {
            Err(AppError::Api(clean_error(
                &parsed.error.unwrap_or_else(|| format!("HTTP {status}")),
            )))
        }
    }

    /// Config subtree as JSON. Empty path = whole config.
    ///
    /// The value is always the *contents* of the node at `path`: VyOS wraps
    /// leaf and tag nodes in their own name (`["system","host-name"]` returns
    /// `{"host-name": "vyos"}`), which is unwrapped here.
    pub async fn show_config(&self, path: &[String]) -> AppResult<Value> {
        let v = self
            .post("/retrieve", json!({ "op": "showConfig", "path": path }))
            .await?;
        Ok(unwrap_node(path, v))
    }

    /// Running config in curly-brace config.boot syntax (no version footer).
    pub async fn show_config_raw(&self) -> AppResult<String> {
        let v = self
            .post(
                "/retrieve",
                json!({ "op": "showConfig", "path": [], "configFormat": "raw" }),
            )
            .await?;
        Ok(value_to_text(v))
    }

    pub async fn return_value(&self, path: &[String]) -> AppResult<Option<String>> {
        let v = self
            .post("/retrieve", json!({ "op": "returnValue", "path": path }))
            .await?;
        Ok(v.as_str().map(str::to_string))
    }

    /// Runs an operational-mode `show ...` command, returns its text output.
    pub async fn show(&self, path: &[String]) -> AppResult<String> {
        let v = self
            .post("/show", json!({ "op": "show", "path": path }))
            .await?;
        Ok(value_to_text(v))
    }

    /// Applies a batch of set/delete commands and commits them.
    /// `confirm_minutes > 0` uses commit-confirm: the router reverts unless
    /// `confirm()` is called within that many minutes.
    pub async fn configure(
        &self,
        commands: &[ConfigCommand],
        confirm_minutes: u32,
    ) -> AppResult<String> {
        let v = self
            .post(
                "/configure",
                json!({ "commands": commands, "confirm_time": confirm_minutes }),
            )
            .await?;
        Ok(value_to_text(v))
    }

    /// Confirms a pending commit-confirm so it is kept.
    pub async fn confirm(&self) -> AppResult<String> {
        let v = self.post("/configure", json!({ "op": "confirm" })).await?;
        Ok(value_to_text(v))
    }

    /// Writes the running config to /config/config.boot so it survives a reboot.
    pub async fn save(&self) -> AppResult<String> {
        let v = self.post("/config-file", json!({ "op": "save" })).await?;
        Ok(value_to_text(v))
    }

    /// System image management (`/image`: show, add, set_default, delete).
    pub async fn image(&self, body: Value, timeout_secs: u64) -> AppResult<String> {
        let v = self
            .post_with_timeout("/image", body, Some(Duration::from_secs(timeout_secs)))
            .await?;
        Ok(value_to_text(v))
    }

    /// `/reboot` or `/poweroff` with path `now`. The router may drop the
    /// connection before answering, which counts as success.
    pub async fn power(&self, endpoint: &str, op: &str) -> AppResult<String> {
        match self
            .post_with_timeout(
                endpoint,
                json!({ "op": op, "path": ["now"] }),
                Some(Duration::from_secs(20)),
            )
            .await
        {
            Ok(v) => Ok(value_to_text(v)),
            Err(AppError::Http(_)) | Err(AppError::Timeout(_)) => Ok(format!("{op} requested")),
            Err(e) => Err(e),
        }
    }

    /// Replaces the running config with `config_text` (config.boot format) and commits.
    pub async fn load_config_text(
        &self,
        config_text: &str,
        confirm_minutes: u32,
    ) -> AppResult<String> {
        let v = self
            .post(
                "/config-file",
                json!({ "op": "load", "string": config_text, "confirm_time": confirm_minutes }),
            )
            .await?;
        Ok(value_to_text(v))
    }
}

/// Drops environment noise (locale warnings, hostname lookups) from VyOS
/// error text and un-escapes the HTML entities the API adds.
fn clean_error(msg: &str) -> String {
    let noise = [
        "perl: warning",
        "LANGUAGE =",
        "LC_ALL =",
        "LC_CTYPE =",
        "LANG =",
        "are supported and installed",
        "sudo: unable to resolve host",
    ];
    // Python tracebacks: keep the error line, drop the stack frames.
    let mut out = Vec::new();
    let mut in_frame = false;
    for l in msg.lines() {
        if noise.iter().any(|n| l.contains(n)) || l.starts_with("Traceback (most recent call last)")
        {
            continue;
        }
        if l.starts_with("  File \"") {
            in_frame = true;
            continue;
        }
        if in_frame && (l.starts_with("    ") || l.trim().chars().all(|c| c == '^' || c == '~')) {
            continue;
        }
        in_frame = false;
        out.push(l);
    }
    out.join("\n")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .trim()
        .to_string()
}

/// `{"<last path element>": x}` -> `x`; anything else unchanged.
fn unwrap_node(path: &[String], v: Value) -> Value {
    match (path.last(), v) {
        (Some(last), Value::Object(mut map)) if map.len() == 1 && map.contains_key(last) => {
            map.remove(last).unwrap_or(Value::Null)
        }
        (_, v) => v,
    }
}

fn value_to_text(v: Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s,
        other => other.to_string(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn cleans_errors() {
        let raw = "[ nat ]\nperl: warning: Setting locale failed.\n\tLANG = \"en_US.UTF-8\"\n    are supported and installed on your system.\nPath &lt;x&gt; failed\nCommit failed\n";
        assert_eq!(clean_error(raw), "[ nat ]\nPath <x> failed\nCommit failed");
    }

    #[test]
    fn trims_tracebacks() {
        let raw = "[ firewall ]\nTraceback (most recent call last):\n  File \"/usr/libexec/vyos/x.py\", line 1, in run\n    config_manager.apply(c)\n  File \"/y.py\", line 2, in apply\n    cmdl(x)\n    ^^^^^^^\nOSError: [Errno 255] failed to run command: ip -6 rule list\nexit code: 255\n\n[[firewall]] failed\nCommit failed";
        assert_eq!(
            clean_error(raw),
            "[ firewall ]\nOSError: [Errno 255] failed to run command: ip -6 rule list\nexit code: 255\n\n[[firewall]] failed\nCommit failed"
        );
    }

    #[test]
    fn unwraps_tag_and_leaf_nodes() {
        // Shapes returned by a real VyOS 1.5 router.
        assert_eq!(
            unwrap_node(
                &p(&["system", "login", "user"]),
                json!({"user": {"vyos": {}}})
            ),
            json!({"vyos": {}})
        );
        assert_eq!(
            unwrap_node(&p(&["system", "host-name"]), json!({"host-name": "vyos"})),
            json!("vyos")
        );
        assert_eq!(
            unwrap_node(
                &p(&["service", "ntp", "allow-client", "address"]),
                json!({"address": ["10.0.0.0/8"]})
            ),
            json!(["10.0.0.0/8"])
        );
        // Plain nodes and specific tag entries come back unwrapped already.
        assert_eq!(
            unwrap_node(
                &p(&["system", "login"]),
                json!({"user": {}, "operator-group": {}})
            ),
            json!({"user": {}, "operator-group": {}})
        );
        assert_eq!(
            unwrap_node(
                &p(&["service", "https", "api", "keys", "id", "vygi"]),
                json!({"key": "k"})
            ),
            json!({"key": "k"})
        );
        assert_eq!(
            unwrap_node(&[], json!({"system": {}})),
            json!({"system": {}})
        );
    }
}
