// Search bar and command palette (top bar, Ctrl+K): actions (save, Safe
// Mode, switch router, add a forward...), pages, Advanced tools, everyday
// words ("password", "open port"), devices, networks, rules, forwards, VPN
// devices and any setting in the router's configuration. Opened empty, it
// suggests common actions.
import { openSetup } from "./setup.js";
import { api } from "../lib/api.js";
import { vpnServers } from "../lib/vpnclient.js";
import { h, clear } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { isConnected, session, onSessionChange } from "../lib/session.js";
import { pageList, showView } from "../lib/views.js";
import { collectClients } from "../lib/netdata.js";
import { readNetworks } from "../lib/netplan.js";
import { parseRules } from "../lib/trafficrules.js";
import { parseForwards } from "../lib/portfwd.js";
import { score, synonymTargets, flattenConfig } from "../lib/searchindex.js";
import { openClient } from "./clients.js";
import { openConfigTree } from "./config_tree.js";
import { saveNow } from "../lib/session.js";
import { runCheckup } from "./checkup.js";
import { openDiagnosticsReport } from "./report.js";
import { showConnectDialog } from "./connect.js";
import { switchToRouter, disconnectRouter, profileId } from "./switcher.js";

const PER_GROUP = 6;
const VIEW_EL = { ports: "ports", vpn: "vpnpage", networks: "networks", rules: "rules" };
const CACHE_MS = 30_000;

/** tools: [{ label, parent, open }] from the Advanced menu. */
export function initSearch(tools) {
  const input = document.getElementById("search");
  const box = h("div#search-results", { hidden: true });
  input.after(box);
  let results = [];
  let active = 0;
  let cache = { at: 0, router: null, cfg: null, clients: null, wan: "" };
  let seq = 0;

  onSessionChange((s) => {
    if (s.info?.profileId !== cache.router) cache = { at: 0, router: null, cfg: null, clients: null, wan: "" };
  });

  const fresh = () => cache.cfg && cache.router === session.info?.profileId && Date.now() - cache.at < CACHE_MS;
  let loading = null; // one load shared by every keystroke typed while it runs

  async function data() {
    if (!isConnected()) return null;
    if (fresh()) return cache;
    loading ??= load().finally(() => (loading = null));
    return loading;
  }

  async function load() {
    const router = session.info.profileId;
    const [cfg, routes, clients] = await Promise.all([
      api.getConfig([]).catch(() => ({})),
      api.routes(4, "default").catch(() => []),
      cache.clients && cache.router === session.info.profileId ? cache.clients : collectClients().then((r) => r.clients).catch(() => []),
    ]);
    if (session.info?.profileId !== router) return null; // switched router meanwhile
    const def = routes.find((r) => r.dst === "default");
    cache = { at: Date.now(), router, cfg: cfg || {}, clients, wan: def?.dev || (def?.nexthops || [])[0]?.dev || "" };
    return cache;
  }

  const page = (name) => () => showView(name);
  const el = (id) => document.getElementById(id);
  // opens a page, then clicks its button (New forward, Add device...) once drawn
  // labels: the button to click, in order of preference (Add device, else Set up VPN)
  const pageThen = (view, ...labels) => () => {
    showView(view);
    const t0 = Date.now();
    const tick = () => {
      const btns = [...(el(VIEW_EL[view])?.querySelectorAll("button") || [])];
      const b = labels.map((l) => btns.find((x) => x.textContent.trim() === l)).find(Boolean);
      if (b) b.click();
      else if (Date.now() - t0 < 5000) setTimeout(tick, 150);
    };
    setTimeout(tick, 50);
  };
  let routers = [];

  /** What you can do from here: [{ label, words, when?, go }]. */
  function actions() {
    const on = isConnected();
    const safe = el("safe-mode");
    const dark = document.documentElement.dataset.mode === "dark";
    const list = [
      { label: "Save configuration", sub: "keep changes after a restart", words: "save write boot config", when: on && !el("btn-save").disabled, go: () => saveNow() },
      { label: safe.checked ? "Turn Safe Mode off" : "Turn Safe Mode on", sub: "undo changes that cut you off", words: "safe mode rollback", when: on && !safe.disabled, go: () => safe.click() },
      { label: "Open terminal", sub: "SSH to the router", words: "terminal ssh cli shell command", when: on, go: () => el("btn-terminal").click() },
      { label: "Run Health Check", sub: "problems and how to fix them", words: "health check security problems doctor fix", when: on, go: () => runCheckup({ alwaysShow: true }) },
      { label: "Add a port forward", sub: "Security → Port Forwarding", words: "add new port forward open port game server", when: on, go: pageThen("ports", "New forward") },
      { label: "Add a VPN device", sub: "Network → VPN", words: "add new vpn device phone wireguard peer", when: on, go: pageThen("vpn", "Add device", "Set up VPN") },
      { label: "Add a network", sub: "Network → Local Networks", words: "add new network vlan guest iot", when: on, go: pageThen("networks", "New network") },
      { label: "Add a traffic rule", sub: "Security → Traffic Rules", words: "add new traffic rule block schedule", when: on, go: pageThen("rules", "New rule") },
      { label: "Set up this router", sub: "checklist of the basics", words: "setup set up wizard checklist basics getting started first new router", when: on, go: () => openSetup() },
      { label: "Diagnostics Report", sub: "everything about the router, for Claude or support", words: "diagnostics report claude support help", when: on, go: () => openDiagnosticsReport() },
      { label: "Add router", sub: "connect to another VyOS router", words: "add new router connect", go: () => showConnectDialog({ blank: true }) },
      ...routers.filter((p) => profileId(p) !== session.info?.profileId).map((p) => (
        { label: `Switch to ${p.name || p.host}`, sub: p.host, words: `switch router ${p.name || ""} ${p.host}`, go: () => switchToRouter(p) })),
      { label: "Disconnect", sub: `from ${session.info?.profile?.name || session.info?.hostname || "this router"}`, words: "disconnect log off", when: on, go: () => disconnectRouter() },
      { label: dark ? "Use light look" : "Use dark look", sub: "Account and settings → Look", words: "dark light theme look mode", go: () => {
        el("theme").value = dark ? "modern-light" : "modern-dark";
        el("theme").dispatchEvent(new Event("change"));
      } },
    ];
    return list.filter((a) => a.when !== false);
  }
  const loadRouters = () => api.listRouters().then((r) => (routers = r || [])).catch(() => {});
  const tool = (t) => () => {
    showView("windows");
    t.open();
  };

  function staticResults(q) {
    const out = [];
    for (const a of actions()) {
      const sc = Math.max(score(a.label, q), score(a.words, q) - 5);
      if (sc) out.push({ group: "Actions", label: a.label, sub: a.sub, sc: sc + 5, go: a.go });
    }
    const pages = pageList();
    const pageGo = (p) => () => showView(p.name, { tab: p.tab });
    for (const p of pages) {
      const sc = Math.max(score(p.title, q), p.group ? score(`${p.group} ${p.title}`, q) - 10 : 0);
      if (sc) out.push({ group: "Pages", label: p.title, sub: p.group || "", sc, go: pageGo(p) });
    }
    for (const t of tools) {
      const sc = Math.max(score(t.label, q), t.parent ? score(`${t.parent} ${t.label}`, q) - 10 : 0);
      if (sc) out.push({ group: "Advanced", label: t.label, sub: t.parent ? `Advanced → ${t.parent}` : "Advanced", sc, go: tool(t) });
    }
    for (const [target, sc] of synonymTargets(q)) {
      const [kind, name] = [target.slice(0, 1), target.slice(2)];
      if (kind === "p") {
        // "settings/router": a page's own tab
        const [base, tab] = name.split("/");
        const p = pages.find((x) => x.name === base && (!tab || x.tab === tab));
        if (p && !out.some((r) => r.group === "Pages" && r.label === p.title)) out.push({ group: "Pages", label: p.title, sub: p.group ? `${p.group} · related` : "related", sc: sc - 5, go: pageGo(p) });
      } else if (kind === "t") {
        const t = tools.find((x) => x.label === name);
        if (t && !out.some((r) => r.label === t.label)) out.push({ group: "Advanced", label: t.label, sub: t.parent ? `Advanced → ${t.parent} · related` : "Advanced · related", sc: sc - 5, go: tool(t) });
      } else if (name === "alerts") {
        out.push({ group: "Pages", label: "Alerts", sub: "bell in the top bar", sc: sc - 5, go: () => document.getElementById("btn-alerts").click() });
      }
    }
    return out;
  }

  function liveResults(q, d) {
    const out = [];
    for (const c of d.clients || []) {
      const sc = Math.max(score(c.label, q), score(c.name, q), score(c.ip, q), score(c.mac, q));
      if (sc) out.push({ group: "Devices", label: c.label, sub: [c.ip, c.mac, c.online ? "online" : "offline"].filter(Boolean).join(" · "), sc, go: () => openClient(c.key, c.ip || c.mac || c.label) });
    }
    for (const n of readNetworks(d.cfg, d.wan)) {
      const sc = Math.max(score(n.name, q), score(n.network, q), score(n.iface, q), n.vlan ? score(`vlan ${n.vlan}`, q) : 0);
      if (sc) out.push({ group: "Networks", label: n.name, sub: `${n.network} · ${n.iface}`, sc, go: page("networks") });
    }
    for (const r of parseRules(d.cfg)) {
      const sc = Math.max(score(r.name, q), ...r.domains.map((x) => score(x, q)));
      if (sc) out.push({ group: "Traffic Rules", label: r.name, sub: r.enabled ? "on" : "paused", sc, go: page("rules") });
    }
    for (const f of parseForwards(d.cfg)) {
      const sc = Math.max(score(f.name, q), score(f.outside, q), score(f.ip, q));
      if (sc) out.push({ group: "Port Forwards", label: f.name, sub: `${f.outside} → ${f.ip}`, sc, go: page("ports") });
    }
    for (const [iface, w] of Object.entries(vpnServers(d.cfg?.interfaces?.wireguard))) {
      for (const name of Object.keys(w?.peer || {})) {
        const sc = score(name, q);
        if (sc) out.push({ group: "VPN devices", label: name, sub: iface, sc, go: page("vpn") });
      }
    }
    // any setting: matches in the configuration open the config tree there
    if (q.length >= 3) {
      const seen = new Set();
      for (const row of flattenConfig(d.cfg)) {
        const sc = score(row.text, q);
        if (!sc) continue;
        const at = row.path.slice(0, Math.min(row.path.length - 1, 3));
        const k = at.join(" ");
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ group: "Settings", label: row.text.length > 70 ? `${row.text.slice(0, 70)}…` : row.text, sub: "configuration", sc: sc - 20, go: () => { showView("windows"); openConfigTree(at, at.join(" ") || "Configuration"); } });
        if (seen.size >= PER_GROUP) break;
      }
    }
    return out;
  }

  function show(list, searching = false) {
    // best groups first, a few results per group
    const groups = new Map();
    for (const r of list.sort((a, b) => b.sc - a.sc)) {
      if (!groups.has(r.group)) groups.set(r.group, []);
      if (groups.get(r.group).length < PER_GROUP) groups.get(r.group).push(r);
    }
    results = [...groups.values()].flat();
    active = 0;
    clear(box);
    if (!input.value.trim() && !suggesting) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    if (!results.length) {
      box.append(h("div.search-empty", searching ? "Searching devices and settings…" : isConnected() ? "Nothing found." : "Nothing found. Connect to a router to search devices and settings."));
      return;
    }
    let i = 0;
    for (const [group, rows] of groups) {
      box.append(h("div.search-group", group));
      for (const r of rows) {
        const idx = i++;
        r.el = h("div.search-item", { on: { mousedown: (e) => { e.preventDefault(); pick(idx); }, mousemove: () => highlight(idx) } },
          h("span.search-label", r.label), r.sub ? h("span.search-sub", r.sub) : null);
        box.append(r.el);
      }
    }
    highlight(0);
  }

  function highlight(i) {
    active = i;
    results.forEach((r, j) => r.el?.classList.toggle("on", j === i));
    results[i]?.el?.scrollIntoView({ block: "nearest" });
  }

  function pick(i) {
    const r = results[i];
    if (!r) return;
    input.value = "";
    box.hidden = true;
    input.blur();
    r.go();
  }

  // opened empty: the common actions, then the pages
  let suggesting = false;
  function suggest() {
    suggesting = true;
    const acts = actions().slice(0, PER_GROUP).map((a, i) => ({ group: "Actions", label: a.label, sub: a.sub, sc: 100 - i, go: a.go }));
    const pages = pageList().map((p, i) => ({ group: "Pages", label: p.title, sub: p.group || "", sc: 50 - i, go: () => showView(p.name, { tab: p.tab }) }));
    show([...acts, ...pages]);
    suggesting = false;
  }

  async function run() {
    const mine = ++seq;
    const q = input.value.trim().toLowerCase();
    if (!q) return document.activeElement === input ? suggest() : show([]);
    const quick = staticResults(q);
    show(quick, isConnected() && !fresh()); // pages and tools right away; devices and settings when loaded
    const d = await data().catch(() => null);
    if (mine !== seq || !d) return;
    show([...quick, ...liveResults(q, d)]);
  }

  input.addEventListener("input", run);
  input.addEventListener("focus", () => {
    run();
    loadRouters().then(() => document.activeElement === input && !input.value.trim() && suggest());
  });
  input.placeholder = "Search or do something (Ctrl+K)";
  input.addEventListener("blur", () => setTimeout(() => (box.hidden = true), 150));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); highlight(Math.min(active + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlight(Math.max(active - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(active); }
    else if (e.key === "Escape") { input.value = ""; box.hidden = true; input.blur(); }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
  input.parentElement.prepend(icon("search", 15));
}
