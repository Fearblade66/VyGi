//! MCP (Model Context Protocol) endpoint: lets Claude (Claude Code, Claude
//! Desktop) or another MCP client use VyGi with an API token. JSON-RPC 2.0
//! over `POST /mcp` (Streamable HTTP, JSON responses only).
//!
//! Reading is open to every token. Changes need a "full" token and always go
//! through Safe Mode: the router reverts them unless `confirm_changes` is
//! called. The router's logins, the HTTPS API and the Safe Mode settings
//! can't be changed this way.

use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};

use super::tokens::{Scope, Token};
use super::watch::{connect_saved, now_ms};
use super::Server;
use crate::error::{AppError, AppResult};
use crate::state::{Win, WindowState};
use crate::vyos_api::ConfigCommand;
use crate::{monitor, sysinfo, transactions};

const VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_COMMANDS: usize = 300;

const INSTRUCTIONS: &str = "VyGi manages VyOS routers. Start with list_routers, then router_status. \
Read before changing: get_config (secrets are redacted), run_show, list_devices, and the 24/7 history tools \
(get_alerts, traffic_history, device_usage, search_logs) when the server watches the router. \
Changes: apply_changes uses Safe Mode, so the router undoes them by itself after confirm_minutes unless you call \
confirm_changes. After applying, check that the router and the internet still work (router_status, ping) and only \
then confirm. If anything looks wrong, don't confirm: it reverts automatically. Explain to the user what you change \
and why. The router's logins, its HTTPS API and the Safe Mode settings can't be changed through this API.";

fn tools() -> Value {
    let router = json!({ "type": "string", "description": "Router id from list_routers (e.g. vyos@192.168.1.1)" });
    let path = json!({ "type": "array", "items": { "type": "string" }, "description": "Config path, e.g. [\"interfaces\", \"ethernet\"]; empty for everything" });
    let t = |name: &str, desc: &str, props: Value, required: &[&str], read_only: bool| {
        json!({
            "name": name,
            "description": desc,
            "inputSchema": { "type": "object", "properties": props, "required": required },
            "annotations": { "readOnlyHint": read_only, "destructiveHint": !read_only },
        })
    };
    json!([
        t("list_routers", "Routers saved in VyGi, with whether the server watches them 24/7.", json!({}), &[], true),
        t("router_status", "Host name, VyOS version, uptime, CPU load and memory, interfaces with addresses and traffic counters, default route, and whether changes are waiting for confirmation or unsaved.", json!({ "router": router }), &["router"], true),
        t("get_config", "The router's configuration (or part of it) as JSON. Passwords, keys and secrets are redacted.", json!({ "router": router, "path": path }), &["router"], true),
        t("run_show", "Runs a VyOS operational `show` command and returns its text, e.g. [\"interfaces\"], [\"ip\", \"route\"], [\"firewall\"], [\"system\", \"image\"], [\"log\", \"tail\", \"100\"].", json!({ "router": router, "path": { "type": "array", "items": { "type": "string" } } }), &["router", "path"], true),
        t("list_devices", "Devices the router sees on its networks: IP, MAC, DHCP host name, interface and state.", json!({ "router": router }), &["router"], true),
        t("ping", "Pings an address or host name from the router (3 packets).", json!({ "router": router, "target": { "type": "string" } }), &["router", "target"], true),
        t("get_alerts", "Alerts the VyGi server recorded while watching the router 24/7 (internet down, new devices, restarts…).", json!({ "router": router, "hours": { "type": "integer", "description": "How far back (default 168)" } }), &["router"], true),
        t("traffic_history", "Internet traffic over time recorded by the 24/7 watching: [[unix ms, download bit/s, upload bit/s], ...].", json!({ "router": router, "hours": { "type": "integer", "description": "Default 24" } }), &["router"], true),
        t("device_usage", "Data used per device (bytes down/up) recorded by the 24/7 watching.", json!({ "router": router, "days": { "type": "integer", "description": "Default 1" } }), &["router"], true),
        t("search_logs", "Searches the router's system log recorded by the 24/7 watching, newest first.", json!({ "router": router, "query": { "type": "string" }, "days": { "type": "integer" }, "max_priority": { "type": "integer", "description": "0-7; 3 = errors only, 4 = warnings and worse" }, "limit": { "type": "integer" } }), &["router"], true),
        t("apply_changes", "Applies VyOS configuration commands with Safe Mode: the router reverts them after confirm_minutes unless confirm_changes is called. Commands are {op: \"set\"|\"delete\", path: [...], value?}, the same as VyOS `set`/`delete` lines split into words (the value separate). Needs a full-access token.", json!({
            "router": router,
            "commands": { "type": "array", "items": { "type": "object", "properties": { "op": { "type": "string", "enum": ["set", "delete"] }, "path": { "type": "array", "items": { "type": "string" } }, "value": { "type": "string" } }, "required": ["op", "path"] } },
            "description": { "type": "string", "description": "What this change does, in plain words" },
            "confirm_minutes": { "type": "integer", "description": "1-10, default 5" },
        }), &["router", "commands", "description"], false),
        t("confirm_changes", "Keeps the changes waiting for confirmation (call it only after checking the router still works) and, by default, saves them so they survive a restart. Needs a full-access token.", json!({ "router": router, "save": { "type": "boolean", "description": "Default true" } }), &["router"], false),
    ])
}

/// Config with secrets replaced by "<redacted>".
pub fn redact(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, v)| {
                    let secret = k.contains("password")
                        || k.contains("private-key")
                        || k.contains("preshared")
                        || k.contains("secret")
                        || k == "key"
                        || k.contains("token");
                    (
                        k.clone(),
                        if secret && !v.is_object() {
                            json!("<redacted>")
                        } else {
                            redact(v)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(redact).collect()),
        other => other.clone(),
    }
}

/// Refuses changes that could lock VyGi (or the user) out.
pub fn check_commands(cmds: &[ConfigCommand]) -> Result<(), String> {
    if cmds.is_empty() {
        return Err("No commands".into());
    }
    if cmds.len() > MAX_COMMANDS {
        return Err(format!("At most {MAX_COMMANDS} commands at once"));
    }
    for c in cmds {
        let p: Vec<&str> = c.path.iter().map(String::as_str).collect();
        if !matches!(c.op.as_str(), "set" | "delete") {
            return Err(format!("op must be set or delete, not {}", c.op));
        }
        if p.is_empty() || p.iter().any(|w| w.is_empty()) {
            return Err("Every command needs a path".into());
        }
        if c.op == "delete" && p.len() < 2 {
            return Err(format!(
                "Deleting the whole `{}` section isn't allowed through the API",
                p[0]
            ));
        }
        let protected = p.starts_with(&["system", "login"])
            || p.starts_with(&["service", "https"])
            || p.starts_with(&["system", "config-management"])
            || (p.starts_with(&["service", "ssh"]) && c.op == "delete" && p.len() <= 2);
        if protected {
            return Err(format!("`{}` can't be changed through the API (logins, the API itself and Safe Mode are off limits)", p.join(" ")));
        }
    }
    Ok(())
}

/// `show` commands that print secrets are refused (get_config redacts them instead).
pub fn check_show(path: &[String]) -> Result<(), String> {
    let p: Vec<&str> = path.iter().map(String::as_str).collect();
    if p.iter().any(|w| w.is_empty() || w.starts_with('-')) {
        return Err("Bad show path".into());
    }
    let first = p.first().copied().unwrap_or("");
    let secret = first == "configuration"
        || first == "pki"
        || p.starts_with(&["system", "commit"])
        || p.iter()
            .any(|w| w.contains("private-key") || w.contains("password") || w.contains("secret"));
    if secret {
        return Err(format!(
            "`show {}` can show passwords or keys; use get_config, which hides them",
            p.join(" ")
        ));
    }
    Ok(())
}

fn rpc_ok(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_err(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn text_result(v: Value, is_error: bool) -> Value {
    let text = match v {
        Value::String(s) => s,
        other => serde_json::to_string_pretty(&other).unwrap_or_default(),
    };
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

/// Handles one JSON-RPC message (or a batch). None = nothing to send back (notifications).
pub async fn handle(srv: &Arc<Server>, token: &Token, body: Value) -> Option<Value> {
    if let Value::Array(batch) = body {
        let mut out = Vec::new();
        for m in batch {
            if let Some(r) = Box::pin(handle(srv, token, m)).await {
                out.push(r);
            }
        }
        return (!out.is_empty()).then_some(Value::Array(out));
    }
    let id = body.get("id").cloned();
    let method = body["method"].as_str().unwrap_or("");
    let id = id?; // none: a notification
    let params = body.get("params").cloned().unwrap_or(json!({}));
    Some(match method {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().unwrap_or("");
            let version = VERSIONS
                .iter()
                .find(|v| **v == asked)
                .copied()
                .unwrap_or(VERSIONS[0]);
            rpc_ok(
                &id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "vygi", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": INSTRUCTIONS,
                }),
            )
        }
        "ping" => rpc_ok(&id, json!({})),
        "tools/list" => rpc_ok(&id, json!({ "tools": tools() })),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or("").to_string();
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match call(srv, token, &name, &args).await {
                Ok(v) => rpc_ok(&id, text_result(v, false)),
                Err(e) => rpc_ok(&id, text_result(json!(e.to_string()), true)),
            }
        }
        _ => rpc_err(&id, -32601, &format!("Method not found: {method}")),
    })
}

fn s(args: &Value, k: &str) -> Option<String> {
    args.get(k).and_then(Value::as_str).map(str::to_string)
}

fn n(args: &Value, k: &str) -> Option<u64> {
    args.get(k).and_then(Value::as_u64)
}

/// The API's own connection to a router (one per token and router).
async fn router_conn(
    srv: &Arc<Server>,
    token: &Token,
    router: &str,
) -> AppResult<Arc<WindowState>> {
    srv.app
        .profiles
        .find(router)
        .map_err(|_| AppError::Invalid(format!("No saved router `{router}`. Use list_routers.")))?;
    let label = format!("api:{}:{router}", token.id);
    srv.tabs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(label.clone(), Instant::now());
    let ws = srv.app.window(&label);
    if ws.conn().await.is_err() {
        connect_saved(&srv.app, &ws, router).await?;
    }
    Ok(ws)
}

async fn call(srv: &Arc<Server>, token: &Token, name: &str, a: &Value) -> AppResult<Value> {
    let full = token.scope == Scope::Full;
    if name == "list_routers" {
        let list = srv.app.profiles.load()?;
        return Ok(Value::Array(
            list.into_iter()
                .map(|p| {
                    let id = p.id();
                    json!({ "id": id, "name": p.name, "host": p.host, "watched24x7": srv.watch.router(&id).enabled })
                })
                .collect(),
        ));
    }
    let router = s(a, "router")
        .ok_or_else(|| AppError::Invalid("`router` is required (see list_routers)".into()))?;
    if matches!(name, "apply_changes" | "confirm_changes") && !full {
        return Err(AppError::Invalid(
            "This token is read-only. Make a full-access token in VyGi to change settings.".into(),
        ));
    }
    let now = now_ms();
    // history tools read the server's files; no router connection needed
    match name {
        "get_alerts" => {
            let hours = n(a, "hours").unwrap_or(168).clamp(1, 24 * 400);
            return Ok(json!(srv
                .watch
                .store(&router)
                .alerts(now.saturating_sub(hours * 3_600_000), 500)));
        }
        "traffic_history" => {
            let hours = n(a, "hours").unwrap_or(24).clamp(1, 24 * 400);
            return Ok(json!(srv.watch.store(&router).wan(
                now.saturating_sub(hours * 3_600_000),
                now,
                300
            )));
        }
        "device_usage" => {
            let days = n(a, "days").unwrap_or(1).clamp(1, 400);
            let list = srv.watch.store(&router).devices(
                now.saturating_sub((days - 1) * 86_400_000),
                now,
                100,
            );
            return Ok(Value::Array(list.into_iter().map(|(k, t)| json!({ "key": k, "ip": t.ip, "name": t.name, "downBytes": t.down, "upBytes": t.up })).collect()));
        }
        "search_logs" => {
            let days = n(a, "days").unwrap_or(1).clamp(1, 400);
            let p = n(a, "max_priority").unwrap_or(7).min(7) as u8;
            let limit = n(a, "limit").unwrap_or(200).clamp(1, 2000) as usize;
            return Ok(json!(srv.watch.store(&router).logs(
                &s(a, "query").unwrap_or_default(),
                now.saturating_sub(days * 86_400_000),
                now,
                p,
                limit
            )));
        }
        _ => {}
    }
    let ws = router_conn(srv, token, &router).await?;
    let w = || Win(ws.clone());
    match name {
        "router_status" => {
            let (info, load, stats, routes, tx) = tokio::join!(
                sysinfo::system_info(w()),
                sysinfo::system_load(w()),
                monitor::interface_stats(w()),
                monitor::routes(w(), 4, Some("default".into())),
                transactions::tx_status(w()),
            );
            let stats = stats.unwrap_or(Value::Null);
            let addrs = stats["addrs"].as_array().cloned().unwrap_or_default();
            let ifaces: Vec<Value> = stats["links"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|l| {
                    let name = l["ifname"].as_str().unwrap_or("");
                    let ips: Vec<String> = addrs
                        .iter()
                        .filter(|a| a["ifname"] == name)
                        .flat_map(|a| a["addr_info"].as_array().cloned().unwrap_or_default())
                        .filter_map(|i| Some(format!("{}/{}", i["local"].as_str()?, i["prefixlen"])))
                        .collect();
                    json!({ "name": name, "state": l["operstate"], "addresses": ips, "rxBytes": l["stats64"]["rx"]["bytes"], "txBytes": l["stats64"]["tx"]["bytes"] })
                })
                .collect();
            let conn = ws.conn().await?;
            Ok(json!({
                "router": router,
                "hostname": transactions::get_config(w(), vec!["system".into(), "host-name".into()]).await.unwrap_or(Value::Null),
                "system": info.unwrap_or(Value::Null),
                "load": load.ok(),
                "interfaces": ifaces,
                "defaultRoute": routes.unwrap_or(Value::Null),
                "changes": tx.ok(),
                "watched24x7": srv.watch.router(&conn.profile_id).enabled,
            }))
        }
        "get_config" => {
            let path: Vec<String> = a
                .get("path")
                .and_then(|p| serde_json::from_value(p.clone()).ok())
                .unwrap_or_default();
            Ok(redact(&transactions::get_config(w(), path).await?))
        }
        "run_show" => {
            let path: Vec<String> = a
                .get("path")
                .and_then(|p| serde_json::from_value(p.clone()).ok())
                .unwrap_or_default();
            if path.is_empty() {
                return Err(AppError::Invalid(
                    "`path` is required, e.g. [\"interfaces\"]".into(),
                ));
            }
            check_show(&path).map_err(AppError::Invalid)?;
            Ok(json!(transactions::run_show(w(), path).await?))
        }
        "list_devices" => {
            let (neigh, leases) =
                tokio::join!(sysinfo::neighbors(w()), sysinfo::dhcp_leases(w(), 4));
            let leases = leases.unwrap_or(Value::Null);
            let name = |mac: &str| {
                leases
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|l| {
                        l["mac"]
                            .as_str()
                            .is_some_and(|m| m.eq_ignore_ascii_case(mac))
                    })
                    .and_then(|l| l["hostname"].as_str())
                    .unwrap_or("")
                    .to_string()
            };
            Ok(Value::Array(
                neigh?
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|x| {
                        let mac = x["lladdr"].as_str()?;
                        Some(json!({ "ip": x["dst"], "mac": mac, "name": name(mac), "interface": x["dev"], "state": x["state"] }))
                    })
                    .collect(),
            ))
        }
        "ping" => {
            let target =
                s(a, "target").ok_or_else(|| AppError::Invalid("`target` is required".into()))?;
            Ok(serde_json::to_value(
                sysinfo::ping_latency(w(), target).await?,
            )?)
        }
        "apply_changes" => {
            let cmds: Vec<ConfigCommand> =
                serde_json::from_value(a.get("commands").cloned().unwrap_or(Value::Null))
                    .map_err(|e| AppError::Invalid(format!("`commands`: {e}")))?;
            check_commands(&cmds).map_err(AppError::Invalid)?;
            let minutes = n(a, "confirm_minutes").unwrap_or(5).clamp(1, 10) as u32;
            let what = s(a, "description").unwrap_or_default();
            let tx = transactions::apply_changes(w(), cmds, minutes).await?;
            eprintln!(
                "API token \"{}\" applied changes to {router}: {what}",
                token.name
            );
            Ok(json!({
                "applied": true,
                "status": tx,
                "next": format!("Check the router still works (router_status, ping), then call confirm_changes within {minutes} minutes. If you don't, the router undoes these changes by itself."),
            }))
        }
        "confirm_changes" => {
            let tx = transactions::confirm_commit(w()).await?;
            let saved = if a.get("save").and_then(Value::as_bool).unwrap_or(true) {
                Some(transactions::save_config(w()).await?)
            } else {
                None
            };
            Ok(
                json!({ "confirmed": true, "saved": saved.is_some(), "status": saved.unwrap_or(tx) }),
            )
        }
        _ => Err(AppError::Invalid(format!("Unknown tool `{name}`"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(op: &str, path: &[&str]) -> ConfigCommand {
        serde_json::from_value(json!({ "op": op, "path": path })).unwrap()
    }

    #[test]
    fn secrets_are_redacted() {
        let cfg = json!({
            "system": { "login": { "user": { "vyos": { "authentication": { "encrypted-password": "$6$x", "public-keys": { "me": { "key": "AAAA", "type": "ssh-ed25519" } } } } } } },
            "service": { "https": { "api": { "keys": { "id": { "vygi": { "key": "abc" } } } } } },
            "interfaces": { "wireguard": { "wg0": { "private-key": "P", "address": "10.0.0.1/24", "peer": { "a": { "preshared-key": "S", "public-key": "PUB" } } } } },
        });
        let r = redact(&cfg).to_string();
        for secret in ["$6$x", "\"abc\"", "\"P\"", "\"S\""] {
            assert!(!r.contains(secret), "{secret} leaked: {r}");
        }
        assert!(r.contains("10.0.0.1/24") && r.contains("PUB") && r.contains("ssh-ed25519"));
    }

    #[test]
    fn dangerous_changes_refused() {
        assert!(check_commands(&[cmd(
            "set",
            &["firewall", "ipv4", "forward", "filter", "rule", "10", "action"]
        )])
        .is_ok());
        assert!(check_commands(&[cmd(
            "set",
            &[
                "system",
                "login",
                "user",
                "x",
                "authentication",
                "plaintext-password"
            ]
        )])
        .is_err());
        assert!(check_commands(&[cmd("delete", &["service", "https", "api"])]).is_err());
        assert!(check_commands(&[cmd(
            "set",
            &["system", "config-management", "commit-confirm", "action"]
        )])
        .is_err());
        assert!(check_commands(&[cmd("delete", &["service", "ssh"])]).is_err());
        assert!(check_commands(&[cmd("set", &["service", "ssh", "port"])]).is_ok());
        assert!(check_commands(&[cmd("delete", &["firewall"])]).is_err());
        assert!(check_commands(&[cmd("comment", &["firewall", "x"])]).is_err());
        assert!(check_commands(&[]).is_err());
    }

    #[test]
    fn secret_shows_refused() {
        let p = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(check_show(&p(&["interfaces"])).is_ok());
        assert!(check_show(&p(&["ip", "route"])).is_ok());
        assert!(check_show(&p(&["configuration", "commands"])).is_err());
        assert!(check_show(&p(&["system", "commit", "file", "0"])).is_err());
        assert!(check_show(&p(&["pki", "certificate"])).is_err());
        assert!(check_show(&p(&["interfaces", "wireguard", "wg0", "private-key"])).is_err());
    }

    #[test]
    fn tools_have_schemas() {
        let t = tools();
        let names: Vec<&str> = t
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"apply_changes") && names.contains(&"router_status"));
        for x in t.as_array().unwrap() {
            assert_eq!(x["inputSchema"]["type"], "object");
        }
    }
}
