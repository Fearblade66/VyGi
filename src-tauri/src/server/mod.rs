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
mod audit;
mod auth;
mod dispatch;
mod history;
mod mcp;
mod tokens;
pub mod watch;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, Query, State};
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
    tokens: tokens::Tokens,
    /// for the certificate download (Claude's MCP client must trust it)
    cert_path: Option<PathBuf>,
    /// the web UI's files (and the Android app, when the image has it)
    web: PathBuf,
    watch: Arc<watch::Watcher>,
    /// window label -> last request
    tabs: StdMutex<HashMap<String, Instant>>,
    audit: audit::Audit,
    /// plain HTTP behind the user's own reverse proxy: take the client
    /// address from X-Forwarded-For
    behind_proxy: bool,
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
    // router secrets, backups, logs and traffic history: only VyGi's own user may read them
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(&cfg.data, std::fs::Permissions::from_mode(0o700))
        {
            eprintln!("Couldn't make {} private: {e}", cfg.data.display());
        }
    }
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
        tokens: tokens::Tokens::load(&cfg.data),
        cert_path: cfg.tls.then(|| cfg.data.join("tls").join("cert.pem")),
        web: cfg.web.clone(),
        watch,
        tabs: StdMutex::new(HashMap::new()),
        audit: audit::Audit::new(&cfg.data),
        behind_proxy: !cfg.tls,
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
        .route("/api/tokens", get(tokens_list).post(token_create))
        .route("/api/tokens/{id}/revoke", post(token_revoke))
        .route("/api/tokens/{id}/allow", post(token_allow))
        .route("/api/audit", get(audit_list))
        .route("/api/sessions", get(sessions_list))
        .route("/api/sessions/{id}/end", post(session_end))
        .route("/api/cert", get(cert))
        .route("/api/cert/names", get(cert_names))
        .route("/api/app/info", get(app_info))
        .route("/api/app/alerts", get(app_alerts))
        .route("/mcp", post(mcp_post).get(mcp_get).delete(mcp_get))
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
            .serve(router.into_make_service_with_connect_info::<SocketAddr>())
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
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
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
    // A certificate VyGi made itself is remade when VYGI_HOSTNAMES changes
    // (a marker file says which names it has); your own is never touched.
    let mut names = vec![
        "vygi".to_string(),
        "localhost".to_string(),
        "127.0.0.1".to_string(),
    ];
    names.extend(cfg.hostnames.iter().cloned());
    let marker = dir.join("made-by-vygi-for.txt");
    let made_for = std::fs::read_to_string(&marker).ok();
    let missing = !cert_path.exists() || !key_path.exists();
    let outdated = made_for
        .as_deref()
        .is_some_and(|m| m.trim() != names.join(","));
    if missing || outdated {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // names that are IP addresses become IP entries in the certificate
        let cert = rcgen::generate_simple_self_signed(names.clone()).map_err(|e| e.to_string())?;
        std::fs::write(&cert_path, cert.cert.pem()).map_err(|e| e.to_string())?;
        auth::write_private(&key_path, cert.key_pair.serialize_pem().as_bytes())?;
        std::fs::write(&marker, names.join(",")).map_err(|e| e.to_string())?;
        println!(
            "Made a self-signed certificate for {} in {}",
            names.join(", "),
            dir.display()
        );
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

impl Server {
    /// The client's address (from X-Forwarded-For behind the user's own proxy).
    fn client_ip(&self, addr: SocketAddr, headers: &HeaderMap) -> String {
        if self.behind_proxy {
            if let Some(f) = headers
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(',').next())
            {
                return f.trim().to_string();
            }
        }
        addr.ip().to_string()
    }

    fn log(&self, who: &str, ip: &str, action: &str, router: &str, detail: String, ok: bool) {
        self.audit.log(audit::Entry {
            at: watch::now_ms(),
            who: who.to_string(),
            ip: ip.to_string(),
            action: action.to_string(),
            router: router.to_string(),
            detail,
            ok,
        });
    }

    /// A security notice to the user's phone (if notifications are set up).
    fn alert(self: &Arc<Self>, text: String) {
        let me = self.clone();
        tokio::spawn(async move {
            let a = alerts::Alert {
                kind: "security".into(),
                text,
                level: "warn".into(),
                at: watch::now_ms(),
            };
            let _ = me.watch.notify("VyGi", &[a]).await;
        });
    }
}

fn web_who(session: &str) -> String {
    format!("web session {}", auth::session_id(session))
}

async fn session(State(s): State<Arc<Server>>, headers: HeaderMap) -> Response {
    Json(json!({ "loggedIn": s.auth.session(&headers).is_some() })).into_response()
}

#[derive(Deserialize)]
struct LoginReq {
    password: String,
}

async fn login(
    State(s): State<Arc<Server>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<LoginReq>,
) -> Response {
    let ip = s.client_ip(addr, &headers);
    let agent = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let was_locked = s.auth.is_locked(&ip);
    match s.auth.login(&req.password, &ip, agent).await {
        Ok((cookie, token)) => {
            s.log(
                &web_who(&token),
                &ip,
                "login",
                "",
                agent.chars().take(120).collect(),
                true,
            );
            if s.auth.new_ip(&ip) {
                s.alert(format!("Someone logged in to VyGi from an address not seen before: {ip}. If that wasn't you, change the web password (it logs out everyone else)."));
            }
            ([(header::SET_COOKIE, cookie)], Json(json!({ "ok": true }))).into_response()
        }
        Err(msg) => {
            if !was_locked {
                s.log("", &ip, "login failed", "", msg.clone(), false);
                if s.auth.is_locked(&ip) {
                    s.log(
                        "",
                        &ip,
                        "logins locked",
                        "",
                        "too many wrong passwords".into(),
                        false,
                    );
                    s.alert(format!("VyGi refused logins for 5 minutes after too many wrong passwords (last from {ip})."));
                }
            }
            plain_error(StatusCode::UNAUTHORIZED, &msg)
        }
    }
}

async fn logout(
    State(s): State<Arc<Server>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Some(t) = s.auth.session(&headers) {
        s.log(
            &web_who(&t),
            &s.client_ip(addr, &headers),
            "logout",
            "",
            String::new(),
            true,
        );
    }
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
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<PasswordReq>,
) -> Response {
    let (Some(session), Some(_)) = (s.auth.session(&headers), headers.get("x-vygi-tab")) else {
        return plain_error(StatusCode::UNAUTHORIZED, "Log in first");
    };
    match s
        .auth
        .change_password(&session, &req.current, &req.new_password)
        .await
    {
        Ok(()) => {
            s.log(
                &web_who(&session),
                &s.client_ip(addr, &headers),
                "web password changed",
                "",
                "other sessions logged out".into(),
                true,
            );
            Json(json!({ "ok": true })).into_response()
        }
        Err(msg) => {
            s.log(
                &web_who(&session),
                &s.client_ip(addr, &headers),
                "web password change failed",
                "",
                msg.clone(),
                false,
            );
            plain_error(StatusCode::BAD_REQUEST, &msg)
        }
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
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
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
    let logged = dispatch::audit_entry(&cmd, &args);
    let router = if logged.is_some() {
        win.conn()
            .await
            .map(|c| c.profile_id.clone())
            .unwrap_or_default()
    } else {
        String::new()
    };
    let result = dispatch::call(&s.app, &s.watch, win, &cmd, args).await;
    if let Some((action, detail)) = logged {
        let router = if router.is_empty() && cmd == "connect" {
            detail.clone()
        } else {
            router
        };
        let detail = match &result {
            Err(e) => format!("{detail}\nFailed: {e}").trim().to_string(),
            Ok(_) => detail,
        };
        s.log(
            &web_who(&session),
            &s.client_ip(addr, &headers),
            &action,
            &router,
            detail,
            result.is_ok(),
        );
    }
    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => api_error(StatusCode::BAD_REQUEST, &e),
    }
}

/// WebSocket for streaming commands. The first message is
/// `{"cmd": "...", "args": {...}}`; the server answers `{"result": id}` (or
/// `{"error": ...}`) and then sends each event as its own message.
async fn stream(
    State(s): State<Arc<Server>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
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
    let log = (s.clone(), web_who(&session), s.client_ip(addr, &headers));
    ws.on_upgrade(move |socket| run_stream(app, win, socket, log))
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

async fn run_stream(
    app: Arc<AppState>,
    win: Arc<WindowState>,
    socket: WebSocket,
    (srv, who, ip): (Arc<Server>, String, String),
) {
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
    if cmd == "open_terminal" {
        let router = win
            .conn()
            .await
            .map(|c| c.profile_id.clone())
            .unwrap_or_default();
        srv.log(&who, &ip, "terminal opened", &router, String::new(), true);
    }
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

// ---------------------------------------------------------------- API tokens and MCP

/// Token management is for a logged-in browser tab only.
fn ui_session(s: &Server, headers: &HeaderMap) -> bool {
    s.auth.session(headers).is_some()
        && tab_id(headers.get("x-vygi-tab").and_then(|v| v.to_str().ok())).is_some()
}

async fn tokens_list(State(s): State<Arc<Server>>, headers: HeaderMap) -> Response {
    if !ui_session(&s, &headers) {
        return plain_error(StatusCode::UNAUTHORIZED, "Log in first");
    }
    Json(s.tokens.list()).into_response()
}

#[derive(Deserialize)]
struct TokenReq {
    name: String,
    scope: tokens::Scope,
    /// days until the token stops working (None or 0 = never)
    #[serde(default)]
    days: Option<u64>,
    /// or hours (wins over days)
    #[serde(default)]
    hours: Option<u64>,
}

#[derive(Deserialize)]
struct AllowReq {
    hours: u64,
}

async fn token_create(
    State(s): State<Arc<Server>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<TokenReq>,
) -> Response {
    if !ui_session(&s, &headers) {
        return plain_error(StatusCode::UNAUTHORIZED, "Log in first");
    }
    match s.tokens.create(
        &req.name,
        req.scope,
        watch::now_ms(),
        req.hours
            .map(|h| h * 3_600_000)
            .or(req.days.map(|d| d * 86_400_000)),
    ) {
        Ok((info, secret)) => {
            let who = s
                .auth
                .session(&headers)
                .map(|t| web_who(&t))
                .unwrap_or_default();
            let scope = if info.scope == tokens::Scope::Full {
                "full access"
            } else {
                "read-only"
            };
            s.log(
                &who,
                &s.client_ip(addr, &headers),
                "API token created",
                "",
                format!("{} ({scope})", info.name),
                true,
            );
            s.alert(format!("A new VyGi API token \"{}\" ({scope}) was created. If that wasn't you, revoke it under API access.", info.name));
            Json(json!({ "token": info, "secret": secret })).into_response()
        }
        Err(e) => plain_error(StatusCode::BAD_REQUEST, &e),
    }
}

/// An expired token works again for a few hours (Claude keeps its setup).
async fn token_allow(
    State(s): State<Arc<Server>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<AllowReq>,
) -> Response {
    if !ui_session(&s, &headers) {
        return plain_error(StatusCode::UNAUTHORIZED, "Log in first");
    }
    let hours = req.hours.clamp(1, 24 * 365);
    match s.tokens.allow(&id, watch::now_ms() + hours * 3_600_000) {
        Ok(Some(t)) => {
            let who = s
                .auth
                .session(&headers)
                .map(|t| web_who(&t))
                .unwrap_or_default();
            s.log(
                &who,
                &s.client_ip(addr, &headers),
                "API token allowed",
                "",
                format!("{} for {hours} h", t.name),
                true,
            );
            Json(json!({ "token": t })).into_response()
        }
        Ok(None) => plain_error(StatusCode::NOT_FOUND, "no such token"),
        Err(e) => plain_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn token_revoke(
    State(s): State<Arc<Server>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if !ui_session(&s, &headers) {
        return plain_error(StatusCode::UNAUTHORIZED, "Log in first");
    }
    // close the token's router connections too
    let prefix = format!("api:{id}:");
    let labels: Vec<String> = s
        .tabs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .keys()
        .filter(|k| k.starts_with(&prefix))
        .cloned()
        .collect();
    for l in labels {
        s.tabs.lock().unwrap_or_else(|e| e.into_inner()).remove(&l);
        if let Some(ws) = s.app.remove_window(&l) {
            ws.disconnect().await;
        }
    }
    let name = s
        .tokens
        .list()
        .into_iter()
        .find(|t| t.id == id)
        .map(|t| t.name)
        .unwrap_or_default();
    match s.tokens.revoke(&id) {
        Ok(true) => {
            let who = s
                .auth
                .session(&headers)
                .map(|t| web_who(&t))
                .unwrap_or_default();
            s.log(
                &who,
                &s.client_ip(addr, &headers),
                "API token revoked",
                "",
                name,
                true,
            );
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => plain_error(StatusCode::NOT_FOUND, "No such token"),
        Err(e) => plain_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

/// Which names VyGi's own certificate covers (the Claude setup checks the
/// address it will use). Empty when the certificate is your own.
async fn cert_names(State(s): State<Arc<Server>>) -> Response {
    let names: Vec<String> = s
        .cert_path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p.with_file_name("made-by-vygi-for.txt")).ok())
        .map(|m| m.trim().split(',').map(str::to_string).collect())
        .unwrap_or_default();
    Json(json!({ "tls": s.cert_path.is_some(), "names": names })).into_response()
}

/// SHA-256 of the server certificate as "AB:CD:…" (what the Android app
/// shows before it trusts the server).
fn cert_fingerprint(pem: &str) -> Option<String> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let b64: String = pem
        .split("-----BEGIN CERTIFICATE-----")
        .nth(1)?
        .split("-----END CERTIFICATE-----")
        .next()?
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let der = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let hex = hex::encode_upper(Sha256::digest(&der));
    Some(
        hex.as_bytes()
            .chunks(2)
            .map(|c| String::from_utf8_lossy(c).into_owned())
            .collect::<Vec<_>>()
            .join(":"),
    )
}

/// The Android app: whether this server has it (the Docker image does) and
/// which version, plus the certificate fingerprint to check it against.
async fn app_info(State(s): State<Arc<Server>>) -> Response {
    let apk = s.web.join("vygi.apk");
    let version: Option<Value> = std::fs::read_to_string(s.web.join("vygi-app.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    let fingerprint = s
        .cert_path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|pem| cert_fingerprint(&pem));
    Json(json!({
        "apk": apk.is_file().then(|| json!({
            "url": "/vygi.apk",
            "size": std::fs::metadata(&apk).map(|m| m.len()).unwrap_or(0),
            "versionCode": version.as_ref().and_then(|v| v["versionCode"].as_u64()),
            "versionName": version.as_ref().and_then(|v| v["versionName"].as_str().map(str::to_string)),
        })),
        "fingerprint": fingerprint,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct SinceQuery {
    since: Option<u64>,
}

/// New alerts for the Android app's notifications (any API token).
async fn app_alerts(
    State(s): State<Arc<Server>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<SinceQuery>,
) -> Response {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.strip_prefix("Bearer ").unwrap_or(v).trim());
    if bearer
        .and_then(|t| s.tokens.check(t, watch::now_ms()))
        .is_none()
    {
        s.log(
            "",
            &s.client_ip(addr, &headers),
            "API token rejected",
            "",
            "Android app alerts: unknown, revoked or expired token".into(),
            false,
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
        return plain_error(
            StatusCode::UNAUTHORIZED,
            "unknown, revoked or expired token",
        );
    }
    let list: Vec<Value> = s
        .watch
        .recent_alerts(q.since.unwrap_or(0), 50)
        .into_iter()
        .map(|(router, a)| json!({ "router": router, "kind": a.kind, "text": a.text, "level": a.level, "at": a.at }))
        .collect();
    Json(json!({ "alerts": list, "now": watch::now_ms() })).into_response()
}

/// The server's (public) certificate, so MCP clients can be told to trust it.
async fn cert(State(s): State<Arc<Server>>) -> Response {
    match s.cert_path.as_ref().and_then(|p| std::fs::read(p).ok()) {
        Some(pem) => (
            [
                (header::CONTENT_TYPE, "application/x-pem-file"),
                (
                    header::CONTENT_DISPOSITION,
                    "attachment; filename=\"vygi-cert.pem\"",
                ),
            ],
            pem,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn mcp_get() -> Response {
    // no server-to-client stream: everything is request/response
    (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST")]).into_response()
}

async fn mcp_post(
    State(s): State<Arc<Server>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // browsers must not be able to drive this from another site (DNS rebinding)
    if headers.contains_key(header::ORIGIN) && !same_origin(&headers) {
        return plain_error(StatusCode::FORBIDDEN, "cross-site request refused");
    }
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        // "Bearer vygi_…", or the bare token (no space: easier to pass to
        // mcp-remote through Claude's settings on every platform)
        .map(|v| v.strip_prefix("Bearer ").unwrap_or(v).trim());
    let ip = s.client_ip(addr, &headers);
    let Some(token) = bearer.and_then(|t| s.tokens.check(t, watch::now_ms())) else {
        s.log(
            "",
            &ip,
            "API token rejected",
            "",
            "unknown, revoked or expired token".into(),
            false,
        );
        tokio::time::sleep(std::time::Duration::from_millis(500)).await; // slows down guessing
        return (StatusCode::UNAUTHORIZED, [(header::WWW_AUTHENTICATE, "Bearer")], Json(json!({ "error": "VyGi didn't accept this API token: its time ended, it was revoked, or it's wrong. If its time ended: in VyGi, System > VyGi > API tokens, press Allow for 4 hours (nothing changes on this computer)." }))).into_response();
    };
    let msg: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return Json(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": format!("Parse error: {e}") } })).into_response(),
    };
    // tool calls go in the activity log (secrets in commands hidden)
    let call = (msg.get("method").and_then(Value::as_str) == Some("tools/call")).then(|| {
        let p = &msg["params"];
        let name = p["name"].as_str().unwrap_or("").to_string();
        let a = &p["arguments"];
        let detail = if name == "apply_changes" {
            audit::change_detail(
                a["description"].as_str(),
                &audit::commands_from(a.get("commands")),
            )
        } else {
            let mut a = a.clone();
            if let Some(o) = a.as_object_mut() {
                o.remove("router");
            }
            if a.as_object().is_some_and(|o| o.is_empty()) {
                String::new()
            } else {
                a.to_string()
            }
        };
        (name, a["router"].as_str().unwrap_or("").to_string(), detail)
    });
    let reply = mcp::handle(&s, &token, msg).await;
    if let Some((name, router, detail)) = call {
        let ok = reply
            .as_ref()
            .map(|r| r.get("error").is_none() && r["result"]["isError"] != json!(true))
            .unwrap_or(true);
        s.log(
            &format!("token {}", token.name),
            &ip,
            &format!("API: {name}"),
            &router,
            detail,
            ok,
        );
    }
    match reply {
        Some(reply) => Json(reply).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

// ---------------------------------------------------------------- activity log and sessions

#[derive(Deserialize)]
struct AuditQuery {
    before: Option<u64>,
    limit: Option<usize>,
    q: Option<String>,
}

async fn audit_list(
    State(s): State<Arc<Server>>,
    headers: HeaderMap,
    Query(q): Query<AuditQuery>,
) -> Response {
    if !ui_session(&s, &headers) {
        return plain_error(StatusCode::UNAUTHORIZED, "Log in first");
    }
    Json(s.audit.list(
        q.before.unwrap_or(0),
        q.limit.unwrap_or(200).min(1000),
        q.q.as_deref().unwrap_or(""),
    ))
    .into_response()
}

async fn sessions_list(State(s): State<Arc<Server>>, headers: HeaderMap) -> Response {
    let (Some(me), true) = (s.auth.session(&headers), ui_session(&s, &headers)) else {
        return plain_error(StatusCode::UNAUTHORIZED, "Log in first");
    };
    Json(s.auth.sessions(&me)).into_response()
}

async fn session_end(
    State(s): State<Arc<Server>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let (Some(me), true) = (s.auth.session(&headers), ui_session(&s, &headers)) else {
        return plain_error(StatusCode::UNAUTHORIZED, "Log in first");
    };
    if s.auth.end_session(&id) {
        s.log(
            &web_who(&me),
            &s.client_ip(addr, &headers),
            "logged out a session",
            "",
            format!("session {id}"),
            true,
        );
        Json(json!({ "ok": true })).into_response()
    } else {
        plain_error(StatusCode::NOT_FOUND, "No such session")
    }
}

#[cfg(test)]
mod tests {
    use super::cert_fingerprint;

    #[test]
    fn fingerprint_of_pem() {
        // DER bytes "hello" -> base64 aGVsbG8=
        let pem = "-----BEGIN CERTIFICATE-----\naGVs\nbG8=\n-----END CERTIFICATE-----\n";
        let fp = cert_fingerprint(pem).unwrap();
        assert!(fp.starts_with("2C:F2:4D:BA:5F:B0:A3:0E"), "{fp}");
        assert_eq!(fp.len(), 32 * 3 - 1);
        assert!(cert_fingerprint("nothing").is_none());
    }
}
