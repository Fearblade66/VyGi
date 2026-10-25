// IP > DNS Server (Technitium): stats, top clients/domains, block/allow lists,
// pause blocking, query log, and handing the server out to LAN devices by DHCP.
import { api, errorText } from "../lib/api.js";
import { h, clear, setStatus } from "../lib/dom.js";
import { openWindow, tabs } from "../lib/mdi.js";
import { makeTable, filterBox } from "../lib/table.js";
import { formDialog, confirmBox, alertBox, modal } from "../lib/dialog.js";
import { applyChanges, session, onSessionChange } from "../lib/session.js";
import { liveChart } from "../lib/chart.js";
import { toArray } from "../lib/vyos.js";
import { siteIcon } from "../lib/siteicon.js";
import { siteOf } from "../lib/sites.js";

/** Table cell: site icon + domain. */
const domainCell = (key) => (r) => h("span.cell-icon", siteIcon(siteOf(r[key]).icon, r[key]), h("span", r[key]));

const PERIODS = { LastHour: "Last hour", LastDay: "Last 24 hours", LastWeek: "Last 7 days", LastMonth: "Last 30 days" };
const DOMAIN_RE = /^(\*\.)?[A-Za-z0-9_]([A-Za-z0-9_-]{0,62}\.)*[A-Za-z0-9_-]{1,63}\.?$/;

// ---- link + cached summary (shared with the Dashboard and Clients views) ----
let linkCache = { key: null, url: undefined, hasToken: false };
let summaryCache = { key: null, at: 0, data: null };
onSessionChange(() => {
  linkCache = { key: null, url: undefined, hasToken: false };
  summaryCache = { key: null, at: 0, data: null };
});

const connKey = () => session.info?.profileId || null;

async function loadLink() {
  const key = connKey();
  if (!key) return { url: null, hasToken: false };
  if (linkCache.key !== key || linkCache.url === undefined) {
    const l = await api.dnsServerLink().catch(() => null);
    linkCache = { key, url: l?.url || null, hasToken: !!l?.hasToken };
  }
  return linkCache;
}

/** URL of the usable Technitium server linked to this router, or null. */
export async function dnsServerUrl() {
  const l = await loadLink();
  return l.hasToken ? l.url : null;
}

export const dnsCall = (endpoint, params = {}) => api.dnsServer(endpoint, params);

/**
 * Last-hour stats + top lists, cached 30 s. Returns null when no server is linked
 * (or it is unreachable: then { error }).
 */
export async function dnsSummary() {
  const key = connKey();
  if (!key || !(await dnsServerUrl())) return null;
  if (summaryCache.key === key && Date.now() - summaryCache.at < 30_000) return summaryCache.data;
  let data;
  try {
    const [stats, clients] = await Promise.all([
      dnsCall("dashboard/stats/get", { type: "LastHour", utc: "true" }),
      dnsCall("dashboard/stats/getTop", { type: "LastHour", statsType: "TopClients", limit: "1000" }).catch(() => ({})),
    ]);
    data = { ...stats, allClients: clients?.topClients || stats.topClients || [] };
  } catch (e) {
    data = { error: errorText(e) };
  }
  summaryCache = { key, at: Date.now(), data };
  return data;
}

let loggerCache = { key: null, list: null };
onSessionChange(() => (loggerCache = { key: null, list: null }));

/** Installed Technitium apps that keep a query log: [{ name, classPath }]. */
export async function queryLoggers() {
  const key = connKey();
  if (loggerCache.key === key && loggerCache.list) return loggerCache.list;
  let list = [];
  try {
    const r = await dnsCall("apps/list");
    list = (r.apps || []).flatMap((a) => (a.dnsApps || []).filter((d) => d.isQueryLogger).map((d) => ({ name: a.name, classPath: d.classPath })));
  } catch {
    list = [];
  }
  loggerCache = { key, list };
  return list;
}

const recentCache = new Map(); // "client|limit" -> { at, entries }

/**
 * Newest query-log entries (optionally for one client IP), cached 60 s.
 * Returns null when no DNS server or no query log app is available.
 */
export async function recentQueries({ client = "", limit = 1000 } = {}) {
  if (!(await dnsServerUrl())) return null;
  const lg = (await queryLoggers())[0];
  if (!lg) return null;
  const key = `${connKey()}|${client}|${limit}`;
  const hit = recentCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.entries;
  const params = { name: lg.name, classPath: lg.classPath, pageNumber: "1", entriesPerPage: String(limit), descendingOrder: "true" };
  if (client) params.clientIpAddress = client;
  try {
    const r = await dnsCall("logs/query", params);
    const entries = r.entries || [];
    recentCache.set(key, { at: Date.now(), entries });
    return entries;
  } catch {
    return null;
  }
}

/** Queries per client IP (last hour) from a summary. */
export function dnsHitsByIp(summary) {
  return new Map((summary?.allClients || []).map((c) => [c.name, c.hits]));
}

const n = (v) => (Number.isFinite(v) ? v.toLocaleString() : "–");
const share = (part, total) => (total ? `${((part / total) * 100).toFixed(1)}%` : "–");

/** Host part of the server URL if it is an IPv4 literal. */
export function serverIpv4(url) {
  const host = String(url || "").replace(/^https?:\/\//, "").split(/[/:]/)[0];
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : "";
}

// ---- setup ----

async function trustPrompt(e) {
  const changed = e.kind === "CertMismatch";
  const body = h("div", { style: { width: "460px" } },
    changed
      ? h("div.err-box", "WARNING: the DNS server's HTTPS certificate is different from the one trusted before. Only continue if you replaced it.")
      : h("div.warn-box", "First HTTPS connection to this DNS server. Check the fingerprint (Technitium: Settings > Web Service) before trusting it."),
    h("div", { style: { marginTop: "6px" } }, h("b", "Presented now:"), h("div.fp", e.fingerprint)));
  return (await modal(changed ? "Certificate changed!" : "Trust this DNS server?", body, [
    { label: "Cancel", value: "cancel", primary: changed },
    { label: "Trust", value: "trust", primary: !changed },
  ])) === "trust";
}

/** Links a Technitium server to the connected router. Resolves true on success. */
export async function setupDnsServer() {
  const current = (await loadLink()).url;
  let ok = false;
  await formDialog("Link Technitium DNS Server", [
    { name: "url", label: "Server address", value: current || "", placeholder: "192.168.1.5  or  https://dns.lan:53443", hint: "The Technitium web console address. Plain addresses use http on port 5380." },
    { name: "token", label: "API token", type: "password", placeholder: "recommended", hint: "Technitium: Administration > Sessions > Create Token. Best with a user that only has the permissions VyGi needs (Dashboard, Blocked, Allowed, Settings, Cache, Logs)." },
    { name: "user", label: "…or username", placeholder: "admin" },
    { name: "password", label: "Password", type: "password", hint: "Used once to create a token named \"VyGi (…)\". The password itself is not stored." },
  ], async (v) => {
    const req = { url: v.url, token: v.token || null, user: v.user || null, password: v.password || null, trustTls: null };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const info = await api.dnsServerSetup(req);
        linkCache = { key: connKey(), url: info.url, hasToken: true };
        summaryCache = { key: null, at: 0, data: null };
        setStatus(`Linked Technitium ${info.version}${info.serverName ? ` (${info.serverName})` : ""}.${info.tokenSaved ? "" : " The OS keychain is unavailable, so the token is kept only until VyGi quits."}`, !info.tokenSaved);
        ok = true;
        return true;
      } catch (e) {
        if (attempt === 0 && (e?.kind === "UntrustedCert" || e?.kind === "CertMismatch")) {
          if (!(await trustPrompt(e))) throw new Error("Certificate not trusted.");
          req.trustTls = e.fingerprint;
          continue;
        }
        throw e;
      }
    }
    return true;
  }, { okLabel: "Link", intro: "Technitium DNS Server is a separate DNS server (ad/tracker blocking, local zones). VyGi shows its statistics and lets you block domains from here. The link is saved per router." });
  return ok;
}

// ---- hand out to LAN devices ----

/** Commands that make every DHCP subnet hand out `ip` as the only DNS server. */
export function dhcpDnsCommands(dhcp, ip) {
  const cmds = [];
  for (const [net, nw] of Object.entries(dhcp?.["shared-network-name"] || {})) {
    for (const [subnet, s] of Object.entries(nw?.subnet || {})) {
      const base = ["service", "dhcp-server", "shared-network-name", net, "subnet", subnet, "option"];
      const cur = toArray(s?.option?.["name-server"]);
      if (cur.length === 1 && cur[0] === ip) continue;
      if (cur.length) cmds.push({ op: "delete", path: [...base, "name-server"] });
      cmds.push({ op: "set", path: [...base, "name-server"], value: ip });
    }
  }
  return cmds;
}

async function useForLan(url) {
  let dhcp;
  try {
    dhcp = await api.getConfig(["service", "dhcp-server"]);
  } catch (e) {
    return alertBox("Failed", errorText(e));
  }
  await formDialog("Use for LAN devices", [
    { name: "ip", label: "DNS server IP", value: serverIpv4(url), placeholder: "192.168.1.5" },
  ], async (v) => {
    const ip = v.ip.trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error("Enter the DNS server's IPv4 address");
    const cmds = dhcpDnsCommands(dhcp, ip);
    if (!cmds.length) {
      const hasDhcp = Object.keys(dhcp?.["shared-network-name"] || {}).length > 0;
      setStatus(hasDhcp ? "DHCP already hands out this DNS server." : "No DHCP server is configured on the router.", !hasDhcp);
      return true;
    }
    await applyChanges(cmds, "DHCP: hand out Technitium as DNS");
    return true;
  }, { okLabel: "Apply", intro: "Sets the DNS server option on every DHCP network, so devices ask Technitium directly. That way Technitium sees (and can block per) each device instead of only the router. Devices pick it up when they renew their lease (or reconnect)." });
}

// ---- window ----

/** opts.client: open straight at the query log for that client IP. */
export function openDnsServer(opts = {}) {
  const win = openWindow({ key: "dns-server", title: "DNS Server (Technitium)", width: 920, height: 560 });
  if (!win.isNew) {
    if (opts.client) win.body.dispatchEvent(new CustomEvent("dns-client", { detail: opts.client }));
    return;
  }
  win.body.style.overflow = "auto";
  let url = null;
  let period = "LastHour";
  let current = "Dashboard";

  const periodSel = h("select", { on: { change: () => { period = periodSel.value; reload(); } } }, Object.entries(PERIODS).map(([v, l]) => h("option", { value: v }, l)));
  const blockState = h("span.pill", "…");
  const blockBtns = h("span");
  const urlNote = h("span.hint");
  const toolbar = h("div.win-toolbar",
    h("span", "Period:"), periodSel,
    h("button", { on: { click: () => reload() } }, "⟳"),
    h("span", "Blocking:"), blockState, blockBtns,
    h("button", { title: "Clear Technitium's DNS cache", on: { click: flush } }, "Flush cache"),
    h("button", { title: "Make DHCP hand out this DNS server", on: { click: () => useForLan(url) } }, "Use for LAN…"),
    h("span.grow"), urlNote,
    h("button", { on: { click: settings } }, "Settings…"));

  const t = tabs(["Dashboard", "Top Clients", "Top Domains", "Blocked Domains", "Block / Allow Lists", "Query Log"], (name) => {
    current = name;
    loaders[name]?.();
  });
  const emptyText = h("p", "No Technitium DNS Server is linked to this router.");
  const empty = h("div", { style: { padding: "24px" } },
    emptyText,
    h("button", { style: { fontWeight: "bold" }, on: { click: async () => { if (await setupDnsServer()) init(); } } }, "Link DNS server…"));
  win.body.append(toolbar, t.el, empty);

  // Dashboard
  const tiles = h("div.stat-grid");
  const chart = liveChart([{ label: "Queries", color: "#2b6cb0" }, { label: "Blocked", color: "#d9480f" }], { points: 60, format: (v) => n(Math.round(v)), height: 170 });
  const breakdown = h("div.stat-grid");
  t.pages.Dashboard.append(tiles, h("div.section-title", "Queries over time"), chart.el, h("div.section-title", "Answers"), breakdown);

  // Top lists
  const topClients = makeTable([
    { key: "name", label: "Client", width: "140px" },
    { key: "host", label: "Name", width: "220px" },
    { key: "hits", label: "Queries", width: "90px", className: "num" },
    { key: "share", label: "Share", width: "70px", className: "num" },
    { key: "limited", label: "" },
  ], { rowKey: (r) => r.name, onOpen: (r) => showLogFor({ client: r.name }) });
  t.pages["Top Clients"].append(h("div.win-toolbar",
    h("button", { on: { click: () => { const r = topClients.selected(); r ? showLogFor({ client: r.name }) : setStatus("Select a client first.", true); } } }, "Show queries"),
    h("span.hint", "Double-click a client to see its queries (needs a query log app)."), h("span.grow"), filterBox(topClients)), topClients.wrap, topClients.count);

  const topDomains = makeTable([
    { key: "name", label: "Domain", width: "420px", render: domainCell("name") },
    { key: "hits", label: "Queries", width: "90px", className: "num" },
    { key: "share", label: "Share", className: "num" },
  ], { rowKey: (r) => r.name });
  t.pages["Top Domains"].append(h("div.win-toolbar",
    h("button", { on: { click: () => withSel(topDomains, (r) => block(r.name)) } }, "Block"),
    h("span.grow"), filterBox(topDomains)), topDomains.wrap, topDomains.count);

  const topBlocked = makeTable([
    { key: "name", label: "Blocked domain", width: "420px", render: domainCell("name") },
    { key: "hits", label: "Times blocked", width: "110px", className: "num" },
    { key: "share", label: "Share", className: "num" },
  ], { rowKey: (r) => r.name });
  t.pages["Blocked Domains"].append(h("div.win-toolbar",
    h("button", { title: "Add to the allow list so it is never blocked", on: { click: () => withSel(topBlocked, (r) => allow(r.name)) } }, "Allow"),
    h("span.grow"), filterBox(topBlocked)), topBlocked.wrap, topBlocked.count);

  // Custom block / allow lists
  const lists = {};
  const listPane = (kind, title, hint) => {
    const table = makeTable([{ key: "domain", label: title, render: domainCell("domain") }], { rowKey: (r) => r.domain });
    lists[kind] = table;
    return h("div", { style: { flex: "1", minWidth: "0", display: "flex", flexDirection: "column" } },
      h("div.win-toolbar",
        h("button.icon-add", { title: `Add to ${title}`, on: { click: () => (kind === "blocked" ? block() : allow()) } }, "+"),
        h("button.icon-remove", { title: "Remove", on: { click: () => withSel(table, (r) => unlist(kind, r.domain)) } }, "−"),
        h("span.hint", hint)),
      table.wrap, table.count);
  };
  t.pages["Block / Allow Lists"].append(h("div", { style: { display: "flex", gap: "8px", height: "100%" } },
    listPane("blocked", "Blocked (custom)", "Always blocked, with subdomains."),
    listPane("allowed", "Allowed (custom)", "Never blocked, even if a block list has it.")));

  // Query log
  const qClient = h("input", { type: "text", placeholder: "client IP", style: { width: "120px" } });
  const qName = h("input", { type: "text", placeholder: "domain", style: { width: "180px" } });
  const qBlocked = h("input", { type: "checkbox" });
  const qPage = h("span.hint");
  let page = 1;
  let pages = 1;
  const logTable = makeTable([
    { key: "time", label: "Time", width: "150px" },
    { key: "clientIpAddress", label: "Client", width: "120px" },
    { key: "qname", label: "Domain", width: "240px", render: domainCell("qname") },
    { key: "qtype", label: "Type", width: "60px" },
    { key: "responseType", label: "Result", width: "100px" },
    { key: "rcode", label: "Code", width: "80px" },
    { key: "answer", label: "Answer" },
  ], { rowKey: (r) => r.rowNumber, rowClass: (r) => (/Blocked/.test(r.responseType) ? "dim" : "") });
  const logNote = h("div.hint", { style: { padding: "8px" } });
  t.pages["Query Log"].append(h("div.win-toolbar",
    qClient, qName, h("label", qBlocked, " blocked only"),
    h("button", { on: { click: () => { page = 1; loadLog(); } } }, "Search"),
    h("button", { on: { click: () => { if (page > 1) { page--; loadLog(); } } } }, "◀"),
    h("button", { on: { click: () => { if (page < pages) { page++; loadLog(); } } } }, "▶"), qPage,
    h("button", { on: { click: () => withSel(logTable, (r) => block(r.qname)) } }, "Block domain")), logNote, logTable.wrap, logTable.count);

  const withSel = (table, fn) => {
    const r = table.selected();
    if (!r) return setStatus("Select a row first.", true);
    fn(r);
  };

  const fail = (e) => setStatus(`DNS server: ${errorText(e)}`, true);

  async function loadDashboard() {
    let s;
    try {
      s = await dnsCall("dashboard/stats/get", { type: period, utc: "true" });
    } catch (e) {
      return fail(e);
    }
    const st = s.stats || {};
    const tile = (k, v, sub) => h("div.stat", h("div.k", k), h("div.v", v), sub ? h("div.hint", sub) : null);
    clear(tiles).append(
      tile("Queries", n(st.totalQueries)),
      tile("Blocked", n(st.totalBlocked), share(st.totalBlocked, st.totalQueries)),
      tile("Clients", n(st.totalClients)),
      tile("Answered from cache", n(st.totalCached), share(st.totalCached, st.totalQueries)),
      tile("Failed (SERVFAIL)", n(st.totalServerFailure), share(st.totalServerFailure, st.totalQueries)),
      tile("Not found (NXDOMAIN)", n(st.totalNxDomain), share(st.totalNxDomain, st.totalQueries)),
      tile("Block list entries", n(st.blockListZones), `${n(st.blockedZones)} custom blocked · ${n(st.allowedZones)} allowed`),
      tile("Cached records", n(st.cachedEntries)),
    );
    const ds = s.mainChartData?.datasets || [];
    const total = ds.find((d) => d.label === "Total")?.data || [];
    const blocked = ds.find((d) => d.label === "Blocked")?.data || [];
    chart.reset(Math.max(2, total.length));
    for (let i = 0; i < total.length; i++) chart.push([total[i], blocked[i] ?? 0]);
    const qr = s.queryResponseChartData;
    clear(breakdown).append(...(qr?.labels || []).map((l, i) => tile(l, n(qr.datasets?.[0]?.data?.[i]), share(qr.datasets?.[0]?.data?.[i], st.totalQueries))));
    const qt = s.queryTypeChartData;
    if (qt?.labels?.length) breakdown.append(tile("Query types", qt.labels.slice(0, 5).map((l, i) => `${l} ${n(qt.datasets?.[0]?.data?.[i])}`).join(" · ")));
  }

  async function loadTop(statsType, table, key) {
    try {
      const [r, s, leases] = await Promise.all([
        dnsCall("dashboard/stats/getTop", { type: period, statsType, limit: "500" }),
        dnsCall("dashboard/stats/get", { type: period, utc: "true" }),
        statsType === "TopClients" ? api.dhcpLeases(4).catch(() => []) : Promise.resolve([]),
      ]);
      const total = statsType === "TopBlockedDomains" ? s.stats?.totalBlocked : s.stats?.totalQueries;
      const names = new Map((Array.isArray(leases) ? leases : []).map((l) => [l.ip, l.hostname]));
      table.setRows((r[key] || []).map((x) => ({ ...x, share: share(x.hits, total), host: x.domain || names.get(x.name) || "", limited: x.rateLimited ? "rate limited" : "" })));
    } catch (e) {
      fail(e);
    }
  }

  async function loadLists() {
    try {
      const [b, a] = await Promise.all([dnsCall("blocked/export"), dnsCall("allowed/export")]);
      const rows = (text) => String(text || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((domain) => ({ domain }));
      lists.blocked.setRows(rows(b));
      lists.allowed.setRows(rows(a));
    } catch (e) {
      fail(e);
    }
  }

  async function loadLog() {
    const lg = (await queryLoggers())[0];
    if (!lg) {
      logNote.textContent = "No query log app is installed in Technitium. Install \"Query Logs (Sqlite)\" from Technitium's App Store (Apps > App Store) to see every query here.";
      logTable.setRows([]);
      return;
    }
    logNote.textContent = `From the "${lg.name}" app.`;
    const params = { name: lg.name, classPath: lg.classPath, pageNumber: String(page), entriesPerPage: "100", descendingOrder: "true" };
    if (qClient.value.trim()) params.clientIpAddress = qClient.value.trim();
    if (qName.value.trim()) params.qname = qName.value.trim();
    if (qBlocked.checked) params.responseType = "Blocked";
    try {
      const r = await dnsCall("logs/query", params);
      pages = Math.max(1, r.totalPages || 1);
      qPage.textContent = `page ${r.pageNumber || page} of ${pages} · ${n(r.totalEntries)} entries`;
      logTable.setRows((r.entries || []).map((e) => ({ ...e, time: new Date(e.timestamp).toLocaleString() })));
    } catch (e) {
      fail(e);
    }
  }

  function showLogFor({ client }) {
    qClient.value = client || "";
    qName.value = "";
    page = 1;
    t.select("Query Log");
  }

  async function loadBlocking() {
    try {
      const s = await dnsCall("settings/get");
      const until = s.temporaryDisableBlockingTill ? new Date(s.temporaryDisableBlockingTill) : null;
      // While paused, Technitium reports enableBlocking=false plus the resume time.
      const paused = until && until > new Date();
      blockState.textContent = paused ? `paused until ${until.toLocaleTimeString()}` : s.enableBlocking ? "on" : "off";
      blockState.className = `pill ${s.enableBlocking && !paused ? "ok" : "warn"}`;
      clear(blockBtns).append(...(s.enableBlocking && !paused
        ? [h("button", { title: "Turn blocking off for 5 minutes", on: { click: () => pause(5) } }, "Pause 5 min"), h("button", { on: { click: () => pause(60) } }, "1 h"), h("button", { on: { click: () => setBlocking(false) } }, "Turn off")]
        : [h("button", { style: { fontWeight: "bold" }, on: { click: () => setBlocking(true) } }, paused ? "Resume now" : "Turn on")]));
      urlNote.textContent = `${url} · Technitium ${s.version}`;
    } catch (e) {
      blockState.textContent = "unreachable";
      blockState.className = "pill bad";
      fail(e);
    }
  }

  async function pause(minutes) {
    try {
      await dnsCall("settings/temporaryDisableBlocking", { minutes: String(minutes) });
      setStatus(`Blocking paused for ${minutes} minutes.`);
      loadBlocking();
    } catch (e) {
      fail(e);
    }
  }

  async function setBlocking(on) {
    if (!on && !(await confirmBox("Turn off blocking", "Turn off ad/tracker blocking for every device until you turn it back on?", "Turn off"))) return;
    try {
      await dnsCall("settings/set", { enableBlocking: String(on) });
      setStatus(on ? "Blocking turned on." : "Blocking turned off.");
      loadBlocking();
    } catch (e) {
      fail(e);
    }
  }

  async function flush() {
    if (!(await confirmBox("Flush cache", "Clear the DNS server's cache? Lookups are a little slower until it refills.", "Flush"))) return;
    try {
      await dnsCall("cache/flush");
      setStatus("DNS cache flushed.");
    } catch (e) {
      fail(e);
    }
  }

  async function askDomain(title, value, intro) {
    let out = null;
    await formDialog(title, [{ name: "domain", label: "Domain", value: value || "", placeholder: "ads.example.com" }], (v) => {
      const d = v.domain.trim().toLowerCase();
      if (!DOMAIN_RE.test(d)) throw new Error("Enter a domain name like ads.example.com");
      out = d;
      return true;
    }, { okLabel: "OK", intro });
    return out;
  }

  async function block(domain) {
    const d = await askDomain("Block domain", domain, "Blocks the domain and all its subdomains for every device using this DNS server.");
    if (!d) return;
    try {
      await dnsCall("blocked/add", { domain: d });
      setStatus(`${d} blocked.`);
      loaders["Block / Allow Lists"]();
    } catch (e) {
      fail(e);
    }
  }

  async function allow(domain) {
    const d = await askDomain("Allow domain", domain, "Allowed domains are never blocked, even when a block list contains them.");
    if (!d) return;
    try {
      await dnsCall("allowed/add", { domain: d });
      setStatus(`${d} allowed.`);
      loaders["Block / Allow Lists"]();
    } catch (e) {
      fail(e);
    }
  }

  async function unlist(kind, domain) {
    try {
      await dnsCall(`${kind}/delete`, { domain });
      setStatus(`${domain} removed from the ${kind} list.`);
      loadLists();
    } catch (e) {
      fail(e);
    }
  }

  async function settings() {
    const r = await modal("DNS server link", h("div", { style: { width: "420px" } }, h("p", `Linked: ${url || "nothing"}`)), [
      { label: "Close", value: "close" },
      { label: "Unlink", value: "unlink" },
      { label: "Change…", value: "change", primary: true },
    ]);
    if (r === "change" && (await setupDnsServer())) init();
    if (r === "unlink" && (await confirmBox("Unlink", "Forget this DNS server and its token for this router? Technitium itself is not changed.", "Unlink"))) {
      await api.dnsServerForget().catch(fail);
      linkCache = { key: null, url: undefined, hasToken: false };
      init();
    }
  }

  const loaders = {
    Dashboard: loadDashboard,
    "Top Clients": () => loadTop("TopClients", topClients, "topClients"),
    "Top Domains": () => loadTop("TopDomains", topDomains, "topDomains"),
    "Blocked Domains": () => loadTop("TopBlockedDomains", topBlocked, "topBlockedDomains"),
    "Block / Allow Lists": loadLists,
    "Query Log": loadLog,
  };
  function reload() {
    loadBlocking();
    loaders[current]?.();
  }

  async function init() {
    const l = await loadLink();
    url = l.hasToken ? l.url : null;
    emptyText.textContent = l.url && !l.hasToken
      ? `${l.url} is linked, but its API token is gone (this computer has no OS keychain, so VyGi only kept it until it last quit). Link it again.`
      : "No Technitium DNS Server is linked to this router.";
    toolbar.hidden = !url;
    t.el.hidden = !url;
    empty.hidden = !!url;
    if (!url) return;
    t.select(opts.client ? "Query Log" : "Dashboard");
    loadBlocking();
  }

  if (opts.client) qClient.value = opts.client;
  win.body.addEventListener("dns-client", (e) => showLogFor({ client: e.detail }));
  init();
  const timer = setInterval(() => { if (url && current === "Dashboard") loadDashboard(); }, 60_000);
  win.onClose(() => { clearInterval(timer); chart.dispose(); });
}
