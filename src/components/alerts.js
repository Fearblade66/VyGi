// Alerts while VyGi is open: checks the router every minute (also when
// minimized) and reports changes as a pop-up, a desktop notification when
// VyGi isn't in front, and in the bell list in the top bar.
import { notify, isDesktop } from "../lib/platform.js";
import { isVpnClient } from "../lib/vpnclient.js";
import { formDialog } from "../lib/dialog.js";
import { showView } from "../lib/views.js";
import { api, errorText } from "../lib/api.js";
import { h, clear, toast } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { session, onSessionChange } from "../lib/session.js";
import { evaluate, KINDS, DEFAULT_ON } from "../lib/alerts.js";
import { parseStatus } from "../lib/ddns.js";
import { parseWgDump } from "./vpn.js";

const INTERVAL = 60_000;
const LOG_MAX = 50;

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: alerts still work for this session */
  }
}

const kindsKey = "vygi.alerts.kinds";
const watchKey = () => `vygi.watch.${session.info?.profileId}`;
const HOST_RE = /^[A-Za-z0-9.:-]{1,253}$/;
const routerKey = () => `vygi.alerts.${session.info?.profileId}`;
const enabled = () => ({ ...DEFAULT_ON, ...load(kindsKey, {}) });

/** One snapshot of what the enabled checks need. */
async function snapshot(on) {
  const safe = (p) => p.catch(() => null);
  const ping = async () => {
    for (const target of ["1.1.1.1", "9.9.9.9"]) {
      const r = await safe(api.pingLatency(target));
      if (r == null) return null; // couldn't ask the router: unknown, not "down"
      if (r.lossPercent != null && r.lossPercent < 100) return true;
    }
    return false;
  };
  const watched = on.watch ? load(watchKey(), []) : [];
  const watchOne = async (w) => {
    const r = await safe(api.pingLatency(w.host));
    return { key: w.host, name: w.name ? `${w.name} (${w.host})` : w.host, ok: r == null ? null : r.lossPercent != null && r.lossPercent < 100 };
  };
  const [internetOk, neighbors, leases, ddnsRaw, sysLoad, dump, watch] = await Promise.all([
    on.internet ? ping() : null,
    on.device ? safe(api.neighbors()) : null,
    on.device ? safe(api.dhcpLeases(4)) : null,
    on.ddns ? safe(api.getConfig(["service", "dns", "dynamic"]).then((c) => (c && Object.keys(c).length ? api.ddnsStatus() : []))) : null,
    on.reboot ? safe(api.systemLoad()) : null,
    on.vpn ? safe(api.wireguardDump()) : null,
    watched.length ? Promise.all(watched.map(watchOne)) : null,
  ]);
  let devices = null;
  if (on.device && neighbors) {
    const names = new Map((Array.isArray(leases) ? leases : []).map((l) => [String(l.mac || "").toLowerCase(), l.hostname || ""]));
    const byMac = new Map();
    for (const n of neighbors) {
      const mac = String(n.lladdr || "").toLowerCase();
      if (!mac || n.dst?.includes(":") || /FAILED|INCOMPLETE/.test([].concat(n.state || []).join())) continue;
      if (!byMac.has(mac)) byMac.set(mac, { mac, ip: n.dst, name: names.get(mac) || "" });
    }
    devices = [...byMac.values()];
  }
  return {
    at: Date.now(),
    internetOk,
    devices,
    ddns: ddnsRaw ? parseStatus(ddnsRaw) : null,
    uptime: sysLoad?.uptimeSecs ?? null,
    vpn: dump != null ? parseWgDump(dump).map((p) => ({ key: p.publicKey, name: p.allowedIps.split(",")[0], handshake: p.handshake })) : null,
    watch,
  };
}

const notifyDesktop = notify;

export function initAlerts() {
  const btn = document.getElementById("btn-alerts");
  btn.append(icon("bell", 16), h("span.alert-count", { hidden: true }));
  const count = btn.querySelector(".alert-count");
  let panel = null;
  let timer = null;
  let running = false;
  let names = new Map(); // wireguard public key -> peer name
  let tunnelKeys = new Set(); // public keys of VPN providers (VyGi's VPN clients)

  const routerData = () => load(routerKey(), { state: {}, log: [], unread: 0 });
  // Web version: the VyGi server may watch this router 24/7; then its alerts
  // and settings are used instead of checking from this tab.
  let server = null; // { router: {enabled, kinds, hosts}, status, notify } or null (desktop / unknown)
  const serverMode = () => !!server?.router?.enabled;

  async function loadServer() {
    server = isDesktop ? null : await api.watchGet().catch(() => null);
  }

  /** New alerts from the server since the last look: shown like local ones. */
  async function pullServer() {
    const d = routerData();
    const since = d.serverSeen || Date.now() - 60_000;
    const list = await api.watchAlerts(since);
    if (!list.length) return;
    d.serverSeen = Math.max(...list.map((a) => a.at));
    d.log = [...list, ...(d.log || [])].slice(0, LOG_MAX);
    d.unread = (d.unread || 0) + list.length;
    store(routerKey(), d);
    updateBadge();
    const host = session.info?.hostname;
    for (const a of [...list].reverse()) {
      toast(a.text, { error: a.level === "bad", warn: a.level === "warn" });
      if (document.hidden || !document.hasFocus()) notifyDesktop(`VyGi: ${host}`, a.text);
    }
    if (panel) renderPanel();
  }

  function updateBadge() {
    const d = session.info ? routerData() : { unread: 0 };
    count.hidden = !d.unread;
    count.textContent = d.unread > 9 ? "9+" : String(d.unread || "");
    btn.disabled = !session.info;
  }

  async function check() {
    if (running || !session.info) return;
    running = true;
    const router = session.info.profileId;
    try {
      if (serverMode()) return await pullServer();
      const on = enabled();
      if (on.vpn) {
        const wg = await api.getConfig(["interfaces", "wireguard"]).catch(() => ({}));
        names = new Map();
        tunnelKeys = new Set();
        for (const c of Object.values(wg || {})) {
          for (const [n, p] of Object.entries(c?.peer || {})) {
            if (isVpnClient(c)) tunnelKeys.add(p?.["public-key"]); // a VPN provider, not a device
            else names.set(p?.["public-key"], n);
          }
        }
      }
      const snap = await snapshot(on);
      if (session.info?.profileId !== router) return; // switched router meanwhile
      if (snap.vpn) {
        snap.vpn = snap.vpn.filter((p) => !tunnelKeys.has(p.key));
        for (const p of snap.vpn) p.name = names.get(p.key) || p.name;
      }
      const d = routerData();
      const { state, alerts } = evaluate(d.state || {}, snap);
      const shown = alerts.filter((a) => on[a.kind]);
      d.state = state;
      d.log = [...shown.map((a) => ({ ...a, at: snap.at })), ...(d.log || [])].slice(0, LOG_MAX);
      d.unread = (d.unread || 0) + shown.length;
      store(routerKey(), d);
      updateBadge();
      const host = session.info.hostname;
      for (const a of shown) {
        toast(a.text, { error: a.level === "bad", warn: a.level === "warn" });
        if (document.hidden || !document.hasFocus()) notifyDesktop(`VyGi: ${host}`, a.text);
      }
      if (panel) renderPanel();
    } catch (e) {
      console.warn("alerts check failed", e); // try again next minute
    } finally {
      running = false;
    }
  }

  function renderPanel() {
    const d = routerData();
    const on = serverMode() ? { ...DEFAULT_ON, ...server.router.kinds } : enabled();
    const list = (d.log || []).length
      ? h("div.alert-list", d.log.map((a) => h(`div.alert-item.${a.level || "info"}`,
          h("span.alert-dot"),
          h("div", h("div", a.text), h("div.hint", new Date(a.at).toLocaleString())))))
      : h("div.hint", { style: { padding: "10px 0" } }, "Nothing yet. VyGi checks the router every minute while it's open.");
    const kinds = h("div.alert-kinds", Object.entries(KINDS).map(([k, label]) => {
      const cb = h("input", { type: "checkbox", checked: !!on[k] });
      cb.addEventListener("change", () => {
        store(kindsKey, { ...load(kindsKey, {}), [k]: cb.checked });
        if (serverMode()) saveServer({ kinds: { ...server.router.kinds, [k]: cb.checked } });
      });
      return h("label", cb, " ", label);
    }));
    clear(panel).append(
      h("div.alert-head", h("b", "Alerts"), h("span.grow"),
        d.log?.length ? h("button", { on: { click: () => { store(routerKey(), { ...routerData(), log: [], unread: 0 }); renderPanel(); updateBadge(); } } }, "Clear") : null),
      list,
      h("div.alert-foot", serverBox(), h("div.hint", "Alert me about:"), kinds, watchEditor(),
        serverMode() ? null : h("div.hint", isDesktop ? "Alerts only work while VyGi is open (it can be minimized)." : "Alerts only work while a VyGi tab is open, unless the server watches this router 24/7.")));
  }

  // Netwatch-style: hosts the router pings every minute (a NAS, a camera, a server outside).
  function watchEditor() {
    const list = serverMode() ? server.router.hosts || [] : load(watchKey(), []);
    const save = (l) => {
      store(watchKey(), l);
      if (serverMode()) saveServer({ hosts: l });
      renderPanel();
    };
    const host = h("input", { placeholder: "address, e.g. 192.168.1.5" });
    const name = h("input", { placeholder: "name (optional)" });
    const add = () => {
      const v = host.value.trim();
      if (!HOST_RE.test(v)) return host.focus();
      if (!list.some((w) => w.host === v)) save([...list, { host: v, name: name.value.trim() }]);
    };
    return h("div.watch-box",
      h("div.hint", "Watch these (the router pings them every minute):"),
      list.map((w) => h("div.watch-row", h("span.grow", w.name ? `${w.name} · ${w.host}` : w.host),
        h("button", { title: "Stop watching", on: { click: () => save(list.filter((x) => x.host !== w.host)) } }, "✕"))),
      h("div.watch-row", host, name, h("button", { on: { click: add } }, "Add")));
  }

  async function saveServer(patch) {
    try {
      await api.watchSet(patch);
      await loadServer();
    } catch (e) {
      toast(`Couldn't change the server's watching: ${errorText(e)}`, { error: true });
    }
    if (panel) renderPanel();
  }

  /** Web version: 24/7 watching on the server, and phone notifications. */
  function serverBox() {
    if (isDesktop || !server) return null;
    const on = serverMode();
    const st = server.status || {};
    const sw = h("input", { type: "checkbox", checked: on });
    sw.addEventListener("change", async () => {
      // switching on takes this tab's choices along
      await saveServer(sw.checked ? { enabled: true, kinds: load(kindsKey, {}), hosts: load(watchKey(), []), name: session.info?.hostname || "" } : { enabled: false });
      store(routerKey(), { ...routerData(), serverSeen: Date.now() }); // only alerts from now on pop up
    });
    const state = !on ? "Off: alerts only while a VyGi tab is open."
      : st.error ? `Problem: ${st.error}`
      : st.connected ? `Watching. Last check ${st.lastCheck ? new Date(st.lastCheck).toLocaleTimeString() : "soon"}.`
      : "Starting…";
    const n = server.notify || {};
    const phone = n.ntfyUrl || n.webhookUrl ? "Phone notifications on" : "Phone notifications off";
    return h("div.server-box",
      h("label.switch", sw, " ", h("b", "Watch this router 24/7 on the VyGi server")),
      h("div.hint", state, on ? " Traffic, data per device and the system log are recorded (see Insights)." : ""),
      h("div", h("a", { href: "#", on: { click: (e) => { e.preventDefault(); notifySettings(); } } }, phone), " · ", h("a", { href: "#", on: { click: (e) => { e.preventDefault(); togglePanel(false); showView("insights"); } } }, "Insights")));
  }

  async function notifySettings() {
    const n = server?.notify || {};
    await formDialog("Phone notifications", [
      { name: "ntfyUrl", label: "ntfy topic URL", value: n.ntfyUrl || "", placeholder: "https://ntfy.sh/vygi-6f3a9c2e", hint: "Install the free ntfy app, subscribe to a hard-to-guess topic (anyone who knows it can read it), and paste its URL here. Or use your own ntfy server." },
      { name: "ntfyToken", label: "ntfy access token", type: "password", value: n.ntfyToken || "", placeholder: "optional", hint: "Only for protected topics." },
      { name: "webhookUrl", label: "Webhook URL", value: n.webhookUrl || "", placeholder: "optional: Discord, Slack, Home Assistant…", hint: "Discord and Slack webhooks get a message; anything else gets JSON {title, text, level, kind, at}." },
    ], async (v) => {
      await api.watchNotifySet({ ntfyUrl: v.ntfyUrl.trim(), ntfyToken: v.ntfyToken.trim(), webhookUrl: v.webhookUrl.trim() });
      await loadServer();
      if (v.ntfyUrl.trim() || v.webhookUrl.trim()) {
        try {
          await api.watchNotifyTest();
          toast("Sent a test notification.");
        } catch (e) {
          throw new Error(`Saved, but the test failed: ${errorText(e)}`);
        }
      }
      return true;
    }, { okLabel: "Save and test", intro: "The VyGi server sends alerts here, also when no VyGi tab is open (only for routers it watches 24/7)." });
    if (panel) renderPanel();
  }

  function togglePanel(open = !panel) {
    if (!open) {
      panel?.remove();
      panel = null;
      return;
    }
    panel = h("div#alert-panel");
    document.getElementById("app").append(panel);
    renderPanel();
    if (!isDesktop) loadServer().then(() => panel && renderPanel());
    store(routerKey(), { ...routerData(), unread: 0 });
    updateBadge();
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePanel();
  });
  document.addEventListener("click", (e) => {
    // a button that re-rendered the panel is no longer in the page: not an outside click
    if (panel && e.target.isConnected && !panel.contains(e.target)) togglePanel(false);
  });

  let activeRouter = null;
  onSessionChange((s) => {
    updateBadge();
    // also called after every change applied: only (re)start when the router changes
    const router = s.info?.profileId || null;
    if (router === activeRouter) return;
    activeRouter = router;
    clearInterval(timer);
    timer = null;
    togglePanel(false);
    server = null;
    if (!router) return;
    // first check soon after connecting, then every minute (also while minimized);
    // with the server watching, its alerts are fetched every 30 s instead
    loadServer().finally(() => {
      setTimeout(check, 5000);
      timer = setInterval(check, serverMode() ? 30_000 : INTERVAL);
    });
  });
  updateBadge();
}
