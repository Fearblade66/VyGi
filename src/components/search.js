// Search bar (top bar, Ctrl+K): pages, Advanced tools, everyday words
// ("password", "open port"), devices, networks, rules, forwards, VPN devices
// and any setting in the router's configuration.
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

const PER_GROUP = 6;
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
  const tool = (t) => () => {
    showView("windows");
    t.open();
  };

  function staticResults(q) {
    const out = [];
    const pages = pageList();
    for (const p of pages) {
      const sc = score(p.title, q);
      if (sc) out.push({ group: "Pages", label: p.title, sc, go: page(p.name) });
    }
    for (const t of tools) {
      const sc = Math.max(score(t.label, q), t.parent ? score(`${t.parent} ${t.label}`, q) - 10 : 0);
      if (sc) out.push({ group: "Tools", label: t.label, sub: t.parent ? `Advanced → ${t.parent}` : "Advanced", sc, go: tool(t) });
    }
    for (const [target, sc] of synonymTargets(q)) {
      const [kind, name] = [target.slice(0, 1), target.slice(2)];
      if (kind === "p") {
        // "settings/management": a page's own tab
        const [base, tab] = name.split("/");
        const p = pages.find((x) => x.name === base);
        const label = p && tab ? `${p.title} → ${tab[0].toUpperCase()}${tab.slice(1)}` : p?.title;
        if (p && !out.some((r) => r.label === label)) out.push({ group: "Pages", label, sub: "related", sc: sc - 5, go: tab ? () => showView(base, { tab }) : page(base) });
      } else if (kind === "t") {
        const t = tools.find((x) => x.label === name);
        if (t && !out.some((r) => r.label === t.label)) out.push({ group: "Tools", label: t.label, sub: t.parent ? `Advanced → ${t.parent} · related` : "Advanced · related", sc: sc - 5, go: tool(t) });
      } else if (name === "alerts") {
        out.push({ group: "Pages", label: "Alerts", sub: "bell in the top bar", sc: sc - 5, go: () => document.getElementById("btn-alerts").click() });
      } else if (name === "setup") {
        out.push({ group: "Pages", label: "Set up this router", sub: "checklist of the basics", sc: sc - 5, go: () => openSetup() });
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
    if (!input.value.trim()) {
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

  async function run() {
    const mine = ++seq;
    const q = input.value.trim().toLowerCase();
    if (!q) return show([]);
    const quick = staticResults(q);
    show(quick, isConnected() && !fresh()); // pages and tools right away; devices and settings when loaded
    const d = await data().catch(() => null);
    if (mine !== seq || !d) return;
    show([...quick, ...liveResults(q, d)]);
  }

  input.addEventListener("input", run);
  input.addEventListener("focus", () => input.value.trim() && run());
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
