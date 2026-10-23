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

    async fn post(&self, endpoint: &str, mut body: Value) -> AppResult<Value> {
        if let Value::Object(map) = &mut body {
            map.insert("key".into(), Value::String(self.key.clone()));
        }
        let resp = self
            .client
            .post(format!("{}{}", self.base, endpoint))
            .header("X-API-Key", &self.key)
            .json(&body)
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
        let parsed: ApiResponse = serde_json::from_str(&text).map_err(|_| {
            AppError::Api(format!(
                "unexpected reply (HTTP {status}): {}",
                truncate(&text, 300)
            ))
        })?;
        if parsed.success {
            Ok(parsed.data)
        } else {
            Err(AppError::Api(
                parsed.error.unwrap_or_else(|| format!("HTTP {status}")),
            ))
        }
    }

    /// Config subtree as JSON. Empty path = whole config.
    pub async fn show_config(&self, path: &[String]) -> AppResult<Value> {
        self.post("/retrieve", json!({ "op": "showConfig", "path": path }))
            .await
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
