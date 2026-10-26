// Where VyGi runs: the desktop app (Tauri) or a browser talking to the VyGi
// web server (Docker). Everything that differs between the two lives here:
// calling the backend, streams, files, notifications, window title.
import { invoke as tauriInvoke, Channel } from "@tauri-apps/api/core";

export const isDesktop = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

// One id per page load: each browser tab gets its own router connection.
const TAB = (() => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
})();

let onLoginNeeded = null;
/** Called when the web server says the session has ended (show the login). */
export function setLoginHandler(fn) {
  onLoginNeeded = fn;
}

async function webCall(cmd, args) {
  const res = await fetch(`/api/invoke/${cmd}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-vygi-tab": TAB },
    body: JSON.stringify(args || {}),
    credentials: "same-origin",
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (res.status === 401) {
    onLoginNeeded?.();
    throw { kind: "LoggedOut", message: "Logged out of VyGi. Log in again." };
  }
  if (!res.ok) throw body || { kind: "Web", message: `HTTP ${res.status}` };
  return body;
}

/** Runs a backend command (same names and arguments on desktop and web). */
export function call(cmd, args) {
  return isDesktop ? tauriInvoke(cmd, args) : webCall(cmd, args);
}

/** Starts a streaming command; `onEvent` gets each event. Resolves to its session id. */
export function stream(cmd, args, onEvent) {
  if (isDesktop) {
    const ch = new Channel();
    ch.onmessage = onEvent;
    return tauriInvoke(cmd, { ...args, onData: ch });
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/stream?tab=${TAB}`);
    let started = false;
    let closedSeen = false;
    ws.onopen = () => ws.send(JSON.stringify({ cmd, args }));
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (!started) {
        started = true;
        if (msg.error) {
          reject(msg.error);
          ws.close();
        } else resolve(msg.result);
        return;
      }
      if (msg.event === "closed") closedSeen = true;
      onEvent(msg);
    };
    ws.onerror = () => {
      if (!started) reject({ kind: "Web", message: "Couldn't open a live connection to the VyGi server" });
    };
    ws.onclose = () => {
      if (started && !closedSeen) onEvent({ event: "closed", data: null });
    };
  });
}

/** Saves text: a save dialog on desktop, a download in a browser. Returns where, or null if cancelled. */
export async function saveText(defaultName, text, filters = []) {
  if (isDesktop) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const file = await save({ title: "Save", defaultPath: defaultName, filters });
    if (!file) return null;
    await tauriInvoke("save_text_file", { file, contents: text });
    return file;
  }
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return defaultName;
}

/** Lets the user pick a text file; resolves to { name, text } or null. */
export async function pickText(accept = "") {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const file = await open({ multiple: false, directory: false });
    return file ? { name: String(file), path: String(file), text: null } : null;
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      if (f.size > 10 * 1024 * 1024) return resolve({ name: f.name, text: null, tooBig: true });
      resolve({ name: f.name, text: await f.text() });
    };
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** Desktop notification (desktop app) or browser notification. */
export async function notify(title, body) {
  try {
    if (isDesktop) {
      const n = await import("@tauri-apps/plugin-notification");
      let ok = await n.isPermissionGranted();
      if (!ok) ok = (await n.requestPermission()) === "granted";
      if (ok) n.sendNotification({ title, body });
    } else if ("Notification" in window) {
      if (Notification.permission === "default") await Notification.requestPermission();
      if (Notification.permission === "granted") new Notification(title, { body });
    }
  } catch {
    /* no notifications: the pop-up and bell list still have it */
  }
}

export function setTitle(title) {
  document.title = title;
  if (isDesktop) import("@tauri-apps/api/window").then((w) => w.getCurrentWindow().setTitle(title)).catch(() => {});
}

/** Another window (desktop) or browser tab, for a second router. */
export function newWindow() {
  if (isDesktop) return tauriInvoke("new_window");
  window.open(location.href, "_blank", "noopener");
  return Promise.resolve();
}

// ---- web only: login session, keep-alive, tab close

export async function webSession() {
  const r = await fetch("/api/session", { credentials: "same-origin" });
  return (await r.json()).loggedIn;
}

export async function webLogin(password) {
  const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }), credentials: "same-origin" });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.message || "Login failed");
}

export async function webLogout() {
  await fetch("/api/logout", { method: "POST", headers: { "x-vygi-tab": TAB }, credentials: "same-origin" }).catch(() => {});
  location.reload();
}

export async function webChangePassword(current, newPassword) {
  const r = await fetch("/api/password", { method: "POST", headers: { "content-type": "application/json", "x-vygi-tab": TAB }, body: JSON.stringify({ current, newPassword }), credentials: "same-origin" });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.message || "Couldn't change the password");
}

if (!isDesktop && typeof window !== "undefined") {
  // The server drops a tab's router connection after 10 quiet minutes; say we're still here.
  setInterval(() => webCall("ping", {}).catch(() => {}), 60_000);
  // Closing the tab disconnects right away.
  window.addEventListener("pagehide", () => navigator.sendBeacon(`/api/bye?tab=${TAB}`));
}

// ---- web only: API tokens (for Claude / MCP and scripts)

async function tokenFetch(path, opts = {}) {
  const r = await fetch(path, { credentials: "same-origin", ...opts, headers: { "content-type": "application/json", "x-vygi-tab": TAB, ...(opts.headers || {}) } });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.message || `HTTP ${r.status}`);
  return body;
}
export const webTokens = () => tokenFetch("/api/tokens");
export const webTokenCreate = (name, scope, days = null) => tokenFetch("/api/tokens", { method: "POST", body: JSON.stringify({ name, scope, days }) });
export const webTokenRevoke = (id) => tokenFetch(`/api/tokens/${encodeURIComponent(id)}/revoke`, { method: "POST" });

// ---- web only: activity log and logged-in browsers
export const webAudit = ({ before = 0, q = "", limit = 200 } = {}) => tokenFetch(`/api/audit?before=${before}&limit=${limit}&q=${encodeURIComponent(q)}`);
export const webSessions = () => tokenFetch("/api/sessions");
export const webSessionEnd = (id) => tokenFetch(`/api/sessions/${encodeURIComponent(id)}/end`, { method: "POST" });
