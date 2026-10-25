//! VyGi as a web app (Docker): serves the same UI to browsers and runs the
//! same commands as the desktop app, behind a password login.
//!
//! - `POST /api/login`, `/api/logout`, `GET /api/session`
//! - `POST /api/invoke/{command}`: JSON arguments in, JSON result out
//! - `GET /api/stream` (WebSocket): terminals, logs and Torch
//! - everything else: the UI files
//!
//! Each browser tab sends its own id (`x-vygi-tab`), so every tab has its own
//! router connection, like the desktop app's windows.

mod alerts;
mod auth;
mod dispatch;
mod history;
pub mod watch;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::services::{ServeDir, ServeFile};

use crate::error::AppError;
use crate::security::ProfileStore;
use crate::state::{AppState, Dirs, WindowState};

use auth::Auth;

/// A tab that hasn't been heard from for this long is disconnected.
const TAB_IDLE: Duration = Duration::from_secs(10 * 60);

pub struct Server {
    app: Arc<AppState>,
    auth: Auth,
    watch: Arc<watch::Watcher>,
    /// window label -> last request
    tabs: StdMutex<HashMap<String, Instant>>,
}

pub struct Config {
    pub data: PathBuf,
    pub web: PathBuf,
    pub listen: SocketAddr,
    pub tls: bool,
    pub password: Option<String>,
    /// How many days of history (traffic, logs) the 24/7 watching keeps.
    pub keep_days: u64,
    pub hostnames: Vec<String>,
}

impl Config {
    /// From environment variables (see the README's Docker section).
    pub fn from_env() -> Result<Self, String> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let tls = !matches!(
            var("VYGI_TLS").as_deref(),
            Some("off" | "0" | "false" | "no")
        );
        let listen = var("VYGI_LISTEN")
            .unwrap_or_else(|| if tls { "0.0.0.0:8443" } else { "0.0.0.0:8080" }.into())
            .parse()
            .map_err(|e| format!("VYGI_LISTEN: {e}"))?;
        Ok(Config {
            data: var("VYGI_DATA").unwrap_or_else(|| "/data".into()).into(),
            web: var("VYGI_WEB").unwrap_or_else(|| "/app/web".into()).into(),
            listen,
            tls,
            password: var("VYGI_PASSWORD"),
            keep_days: var("VYGI_KEEP_DAYS")
                .and_then(|v| v.parse().ok())
                .filter(|d| *d > 0)
                .unwrap_or(30),
            hostnames: var("VYGI_HOSTNAMES")
                .map(|v| {
                    v.split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default(),
        })
    }
}

pub async fn run(cfg: Config) -> Result<(), String> {
    std::fs::create_dir_all(&cfg.data).map_err(|e| format!("{}: {e}", cfg.data.display()))?;
    let dirs = Dirs {
        data: cfg.data.clone(),
        cache: cfg.data.join("cache"),
    };
    let app = Arc::new(AppState::new(
        ProfileStore::new(cfg.data.join("config")),
        dirs,
    ));
    let auth = Auth::load(&cfg.data, cfg.password.as_deref(), cfg.tls)?;
    let watch = watch::Watcher::new(app.clone(), &cfg.data, cfg.keep_days);
    watch.start_all();
    let server = Arc::new(Server {
        app,
        auth,
        watch,
        tabs: StdMutex::new(HashMap::new()),
    });

    // Disconnect tabs that went away without saying so.
    let reaper = server.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let stale: Vec<String> = {
                let mut tabs = reaper.tabs.lock().unwrap_or_else(|e| e.into_inner());
                let stale: Vec<String> = tabs
                    .iter()
                    .filter(|(_, seen)| seen.elapsed() > TAB_IDLE)
                    .map(|(k, _)| k.clone())
                    .collect();
                for k in &stale {
                    tabs.remove(k);
                }
                stale
            };
            for label in stale {
                if let Some(ws) = reaper.app.remove_window(&label) {
                    ws.disconnect().await;
                }
            }
            reaper.auth.expire();
        }
    });

    let index = cfg.web.join("index.html");
    let router = Router::new()
        .route("/api/session", get(session))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/password", post(change_password))
        .route("/api/bye", post(bye))
        .route("/api/invoke/{cmd}", post(invoke))
        .route("/api/stream", get(stream))
        .fallback_service(ServeDir::new(&cfg.web).fallback(ServeFile::new(index)))
        .layer(axum::middleware::map_response(security_headers))
        .with_state(server);

    if cfg.tls {
        let tls = tls_config(&cfg)?;
        println!(
            "VyGi web: https://{} (self-signed unless you replaced tls/cert.pem)",
            cfg.listen
        );
        axum_server::bind_rustls(cfg.listen, tls)
            .serve(router.into_make_service())
            .await
            .map_err(|e| e.to_string())
    } else {
        println!(
            "VyGi web: http://{} (TLS off: put it behind an HTTPS reverse proxy)",
            cfg.listen
        );
        let listener = tokio::net::TcpListener::bind(cfg.listen)
            .await
            .map_err(|e| format!("{}: {e}", cfg.listen))?;
        axum::serve(listener, router)
            .await
            .map_err(|e| e.to_string())
    }
}

/// HTTPS with the certificate in `<data>/tls/`, made (self-signed) on first start.
fn tls_config(cfg: &Config) -> Result<axum_server::tls_rustls::RustlsConfig, String> {
    use rustls::pki_types::pem::PemObject;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};

    let dir = cfg.data.join("tls");
    let (cert_path, key_path) = (dir.join("cert.pem"), dir.join("key.pem"));
    if !cert_path.exists() || !key_path.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut names = vec!["vygi".to_string(), "localhost".to_string()];
        names.extend(cfg.hostnames.iter().cloned());
        let cert = rcgen::generate_simple_self_signed(names).map_err(|e| e.to_string())?;
        std::fs::write(&cert_path, cert.cert.pem()).map_err(|e| e.to_string())?;
        auth::write_private(&key_path, cert.key_pair.serialize_pem().as_bytes())?;
        println!("Made a self-signed certificate in {}", dir.display());
    }
    let certs = CertificateDer::pem_file_iter(&cert_path)
        .and_then(|i| i.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("{}: {e}", cert_path.display()))?;
    let key = PrivateKeyDer::from_pem_file(&key_path)
        .map_err(|e| format!("{}: {e}", key_path.display()))?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| e.to_string())?;
    Ok(axum_server::tls_rustls::RustlsConfig::from_config(
        Arc::new(config),
    ))
}

async fn security_headers(mut res: Response) -> Response {
    let h = res.headers_mut();
    let set = |h: &mut HeaderMap, k: &'static str, v: &'static str| {
        h.insert(k, HeaderValue::from_static(v));
    };
    set(h, "x-frame-options", "DENY");
    set(h, "x-content-type-options", "nosniff");
    set(h, "referrer-policy", "no-referrer");
    set(
        h,
        "content-security-policy",
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
    res
}

fn api_error(status: StatusCode, e: &AppError) -> Response {
    (status, Json(serde_json::to_value(e).unwrap_or(Value::Null))).into_response()
}

fn plain_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "kind": "Web", "message": message }))).into_response()
}

/// A valid tab id from the browser.
fn tab_id(v: Option<&str>) -> Option<&str> {
    v.filter(|t| {
        (8..=64).contains(&t.len()) && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    })
}

impl Server {
    /// The window state for this login session and tab.
    fn window(&self, session: &str, tab: &str) -> (String, Arc<WindowState>) {
        let label = format!("{}:{tab}", &session[..16.min(session.len())]);
        self.tabs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(label.clone(), Instant::now());
        let ws = self.app.window(&label);
        (label, ws)
    }
}

async fn session(State(s): State<Arc<Server>>, headers: HeaderMap) -> Response {
    Json(json!({ "loggedIn": s.auth.session(&headers).is_some() })).into_response()
}

#[derive(Deserialize)]
struct LoginReq {
    password: String,
}

async fn login(State(s): State<Arc<Server>>, Json(req): Json<LoginReq>) -> Response {
    match s.auth.login(&req.password).await {
        Ok(cookie) => ([(header::SET_COOKIE, cookie)], Json(json!({ "ok": true }))).into_response(),
        Err(msg) => plain_error(StatusCode::UNAUTHORIZED, &msg),
    }
}

async fn logout(State(s): State<Arc<Server>>, headers: HeaderMap) -> Response {
    s.auth.logout(&headers);
    (
        [(header::SET_COOKIE, s.auth.clear_cookie())],
        Json(json!({ "ok": true })),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasswordReq {
    current: String,
    new_password: String,
}

async fn change_password(
    State(s): State<Arc<Server>>,
    headers: HeaderMap,
    Json(req): Json<PasswordReq>,
) -> Response {
    if s.auth.session(&headers).is_none() || headers.get("x-vygi-tab").is_none() {
        return plain_error(StatusCode::UNAUTHORIZED, "Log in first");
    }
    match s
        .auth
        .change_password(&req.current, &req.new_password)
        .await
    {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(msg) => plain_error(StatusCode::BAD_REQUEST, &msg),
    }
}

#[derive(Deserialize)]
struct TabQuery {
    tab: Option<String>,
}

/// Sent by the browser when a tab closes: drop its router connection now.
async fn bye(
    State(s): State<Arc<Server>>,
    headers: HeaderMap,
    Query(q): Query<TabQuery>,
) -> Response {
    let (Some(session), Some(tab)) = (s.auth.session(&headers), tab_id(q.tab.as_deref())) else {
        return StatusCode::NO_CONTENT.into_response();
    };
    let label = format!("{}:{tab}", &session[..16.min(session.len())]);
    s.tabs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&label);
    if let Some(ws) = s.app.remove_window(&label) {
        ws.disconnect().await;
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn invoke(
    State(s): State<Arc<Server>>,
    Path(cmd): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(session) = s.auth.session(&headers) else {
        return plain_error(StatusCode::UNAUTHORIZED, "Log in first");
    };
    // A custom header: browsers won't send it cross-site without CORS, which this server never allows.
    let Some(tab) = tab_id(headers.get("x-vygi-tab").and_then(|v| v.to_str().ok())) else {
        return plain_error(StatusCode::BAD_REQUEST, "missing tab id");
    };
    let args: Value = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => return plain_error(StatusCode::BAD_REQUEST, &format!("bad arguments: {e}")),
        }
    };
    let (_, win) = s.window(&session, tab);
    match dispatch::call(&s.app, &s.watch, win, &cmd, args).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => api_error(StatusCode::BAD_REQUEST, &e),
    }
}

/// WebSocket for streaming commands. The first message is
/// `{"cmd": "...", "args": {...}}`; the server answers `{"result": id}` (or
/// `{"error": ...}`) and then sends each event as its own message.
async fn stream(
    State(s): State<Arc<Server>>,
    headers: HeaderMap,
    Query(q): Query<TabQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(session) = s.auth.session(&headers) else {
        return plain_error(StatusCode::UNAUTHORIZED, "Log in first");
    };
    if !same_origin(&headers) {
        return plain_error(StatusCode::FORBIDDEN, "cross-site WebSocket refused");
    }
    let Some(tab) = tab_id(q.tab.as_deref()).map(str::to_string) else {
        return plain_error(StatusCode::BAD_REQUEST, "missing tab id");
    };
    let (_, win) = s.window(&session, &tab);
    let app = s.app.clone();
    ws.on_upgrade(move |socket| run_stream(app, win, socket))
}

/// WebSockets ignore CORS, so check that the page came from this server.
fn same_origin(headers: &HeaderMap) -> bool {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    match (host, origin) {
        (Some(h), Some(o)) => o.split_once("://").map(|(_, rest)| rest) == Some(h),
        _ => false,
    }
}

async fn run_stream(app: Arc<AppState>, win: Arc<WindowState>, socket: WebSocket) {
    let (mut sink, mut source) = socket.split();
    let first = match source.next().await {
        Some(Ok(Message::Text(t))) => t,
        _ => return,
    };
    let req: Value = serde_json::from_str(first.as_str()).unwrap_or(Value::Null);
    let cmd = req
        .get("cmd")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let args = req.get("args").cloned().unwrap_or_else(|| json!({}));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let id = match dispatch::open_stream(&app, win.clone(), &cmd, args, tx).await {
        Ok(id) => id,
        Err(e) => {
            let _ = sink
                .send(Message::Text(json!({ "error": e }).to_string().into()))
                .await;
            return;
        }
    };
    if sink
        .send(Message::Text(json!({ "result": id }).to_string().into()))
        .await
        .is_err()
    {
        let _ = crate::monitor::close_session(crate::state::Win(win), id).await;
        return;
    }
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Some(text) => if sink.send(Message::Text(text.into())).await.is_err() { break },
                None => break, // the stream ended
            },
            msg = source.next() => match msg {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
        }
    }
    let _ = crate::monitor::close_session(crate::state::Win(win), id).await;
}
