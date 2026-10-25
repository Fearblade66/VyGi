// Alerts while VyGi is open: checks the router every minute (also when
// minimized) and reports changes as a pop-up, a desktop notification when
// VyGi isn't in front, and in the bell list in the top bar.
import { notify } from "../lib/platform.js";
import { api } from "../lib/api.js";
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

  const routerData = () => load(routerKey(), { state: {}, log: [], unread: 0 });

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
      const on = enabled();
      if (on.vpn) {
        const wg = await api.getConfig(["interfaces", "wireguard"]).catch(() => ({}));
        names = new Map();
        for (const c of Object.values(wg || {})) for (const [n, p] of Object.entries(c?.peer || {})) names.set(p?.["public-key"], n);
      }
      const snap = await snapshot(on);
      if (session.info?.profileId !== router) return; // switched router meanwhile
      if (snap.vpn) for (const p of snap.vpn) p.name = names.get(p.key) || p.name;
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
    const on = enabled();
    const list = (d.log || []).length
      ? h("div.alert-list", d.log.map((a) => h(`div.alert-item.${a.level || "info"}`,
          h("span.alert-dot"),
          h("div", h("div", a.text), h("div.hint", new Date(a.at).toLocaleString())))))
      : h("div.hint", { style: { padding: "10px 0" } }, "Nothing yet. VyGi checks the router every minute while it's open.");
    const kinds = h("div.alert-kinds", Object.entries(KINDS).map(([k, label]) => {
      const cb = h("input", { type: "checkbox", checked: !!on[k] });
      cb.addEventListener("change", () => store(kindsKey, { ...load(kindsKey, {}), [k]: cb.checked }));
      return h("label", cb, " ", label);
    }));
    clear(panel).append(
      h("div.alert-head", h("b", "Alerts"), h("span.grow"),
        d.log?.length ? h("button", { on: { click: () => { store(routerKey(), { ...routerData(), log: [], unread: 0 }); renderPanel(); updateBadge(); } } }, "Clear") : null),
      list,
      h("div.alert-foot", h("div.hint", "Alert me about:"), kinds, watchEditor(),
        h("div.hint", "Alerts only work while VyGi is open (it can be minimized).")));
  }

  // Netwatch-style: hosts the router pings every minute (a NAS, a camera, a server outside).
  function watchEditor() {
    const list = load(watchKey(), []);
    const save = (l) => {
      store(watchKey(), l);
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

  function togglePanel(open = !panel) {
    if (!open) {
      panel?.remove();
      panel = null;
      return;
    }
    panel = h("div#alert-panel");
    document.getElementById("app").append(panel);
    renderPanel();
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
    if (!router) return;
    // first check soon after connecting, then every minute (also while minimized)
    setTimeout(check, 5000);
    timer = setInterval(check, INTERVAL);
  });
  updateBadge();
}
