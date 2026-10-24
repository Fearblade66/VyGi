// Dashboard: a UniFi-style overview of the connected router.
import { api, errorText } from "../lib/api.js";
import { h, clear, formatBits, formatBytes } from "../lib/dom.js";
import { liveChart } from "../lib/chart.js";
import { registerView, showView } from "../lib/views.js";
import { session, isConnected } from "../lib/session.js";
import { collectClients } from "../lib/netdata.js";
import { ipv4InCidr, flattenInterfaces, has } from "../lib/vyos.js";
import { cpuPercent, fmtUptime } from "./resources.js";
import { openInterfaces } from "./interfaces.js";
import { openVpn } from "./vpn.js";
import { openResources } from "./resources.js";
import { openDhcp } from "./dhcp.js";
import { openDnsServer, dnsSummary } from "./technitium.js";

const PING_TARGET = "1.1.1.1";

function card(cls, title, link) {
  const body = h("div");
  const head = h("h3", h("span", title), link ? h("a", { on: { click: link.go } }, link.label) : null);
  return { el: h(`div.card.${cls}`, head, body), body };
}

const kv = (rows) => h("dl.kv-list", rows.filter(Boolean).flatMap(([k, v]) => [h("dt", k), h("dd", { title: typeof v === "string" ? v : "" }, v)]));
const pct = (n) => (Number.isFinite(n) ? `${Math.round(n)}%` : "–");

export function initDashboard() {
  const root = document.getElementById("dashboard");
  let timers = [];
  let chart = null;
  let state = {};

  function build() {
    clear(root);
    chart?.dispose();
    const head = h("div.dash-head");
    const internet = card("span-4", "Internet", { label: "Interfaces", go: () => goWin(openInterfaces) });
    const gateway = card("span-4", "Gateway", { label: "Resources", go: () => goWin(openResources) });
    const clients = card("span-4", "Clients", { label: "All clients", go: () => showView("clients") });
    const traffic = card("span-8", "Internet traffic");
    const networks = card("span-4", "Networks", { label: "DHCP", go: () => goWin(() => openDhcp()) });
    const top = card("span-6", "Most active clients", { label: "All clients", go: () => showView("clients") });
    const vpn = card("span-3", "VPN", { label: "Open", go: () => goWin(openVpn) });
    const alerts = card("span-3", "Alerts");
    const dns = card("span-12", "DNS (Technitium, last hour)", { label: "Open", go: () => goWin(openDnsServer) });
    dns.el.hidden = true;
    chart = liveChart([{ label: "Download", color: "#006fff" }, { label: "Upload", color: "#12a150" }], { points: 150, format: formatBits, height: 190 });
    traffic.body.append(chart.el);
    chart.el.style.background = "transparent";
    chart.el.style.border = "none";
    chart.el.style.padding = "0";
    root.append(h("div.dash", head, internet.el, gateway.el, clients.el, traffic.el, networks.el, top.el, vpn.el, alerts.el, dns.el));
    return { dnsCard: dns.el, dns: dns.body, head, internet: internet.body, gateway: gateway.body, clients: clients.body, networks: networks.body, top: top.body, vpn: vpn.body, alerts: alerts.body };
  }

  function goWin(open) {
    showView("windows");
    open();
  }

  let ui = null;
  let prevCpu = null;
  let prevWan = null;

  async function pollTraffic() {
    if (!state.wan) return;
    try {
      const stats = await api.interfaceStats();
      state.links = stats.links || [];
      state.addrs = stats.addrs || [];
      const l = state.links.find((x) => x.ifname === state.wan);
      if (!l) return;
      const s = l.stats64 || l.stats || {};
      const now = performance.now();
      if (prevWan && now > prevWan.t) {
        const dt = (now - prevWan.t) / 1000;
        state.down = Math.max(0, (((s.rx?.bytes ?? 0) - prevWan.rx) * 8) / dt);
        state.up = Math.max(0, (((s.tx?.bytes ?? 0) - prevWan.tx) * 8) / dt);
        chart.push([state.down, state.up]);
      }
      prevWan = { t: now, rx: s.rx?.bytes ?? 0, tx: s.tx?.bytes ?? 0 };
      renderInternet();
    } catch {
      /* transient */
    }
  }

  async function pollLoad() {
    try {
      const l = await api.systemLoad();
      state.cpu = cpuPercent(prevCpu, l.cpuTimes);
      prevCpu = l.cpuTimes;
      state.load = l;
      renderGateway();
      renderAlerts();
    } catch {
      /* transient */
    }
  }

  async function pollClients() {
    try {
      const [{ clients, networks, ifaces }, dhcp, routes] = await Promise.all([
        collectClients(),
        api.getConfig(["service", "dhcp-server", "shared-network-name"]).catch(() => ({})),
        api.routes(4, "default").catch(() => []),
      ]);
      Object.assign(state, { clients, networks, ifaces, dhcp });
      const def = routes.find((r) => r.dst === "default");
      state.wan = def?.dev || (def?.nexthops || [])[0]?.dev || state.wan;
      state.gatewayIp = def?.gateway || (def?.nexthops || [])[0]?.gateway || "";
      renderClients();
      renderNetworks();
      renderTop();
      renderVpn();
      renderInternet();
      renderAlerts();
    } catch (e) {
      ui.alerts.textContent = errorText(e);
    }
  }

  async function pollLatency() {
    try {
      state.latency = await api.pingLatency(PING_TARGET);
    } catch {
      state.latency = { lossPercent: 100, avgMs: null };
    }
    renderInternet();
    renderAlerts();
  }

  function renderHead() {
    const i = session.info;
    clear(ui.head).append(
      h("h2", i?.hostname || "Router"),
      h("span.hint", `VyOS ${i?.version ?? ""}`),
      h("span.hint", i?.profile?.host ?? ""),
      state.load ? h("span.pill.muted", `up ${fmtUptime(state.load.uptimeSecs)}`) : null,
    );
  }

  function renderInternet() {
    const lat = state.latency;
    const online = lat ? lat.lossPercent != null && lat.lossPercent < 100 : null;
    const wanAddr = (state.addrs || []).find((a) => a.ifname === state.wan)?.addr_info?.find((x) => x.family === "inet");
    clear(ui.internet).append(
      h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" } },
        h("span.big", online == null ? "…" : online ? "Online" : "Offline"),
        h(`span.pill.${online == null ? "muted" : online ? "ok" : "bad"}`, online == null ? "checking" : online ? "connected" : "no internet")),
      kv([
        ["WAN", state.wan || "?"],
        ["Address", wanAddr ? `${wanAddr.local}/${wanAddr.prefixlen}` : "–"],
        ["Gateway", state.gatewayIp || "–"],
        ["Latency", lat?.avgMs != null ? `${lat.avgMs.toFixed(1)} ms to ${PING_TARGET}` : "–"],
        ["Packet loss", lat?.lossPercent != null ? `${lat.lossPercent}%` : "–"],
        ["Now", Number.isFinite(state.down) ? `↓ ${formatBits(state.down)}  ↑ ${formatBits(state.up)}` : "–"],
      ]),
    );
  }

  function renderGateway() {
    const l = state.load;
    if (!l) return;
    const mem = l.memTotalKb ? ((l.memTotalKb - (l.memAvailableKb ?? 0)) / l.memTotalKb) * 100 : NaN;
    const bar = (v) => h("div.bar", h("span", { style: { width: `${Math.min(100, v || 0)}%`, background: v >= 90 ? "var(--bad)" : v >= 75 ? "var(--warn)" : "var(--accent, #2b6cb0)" } }));
    clear(ui.gateway).append(
      h("div.split-2",
        h("div.metric", h("div.k", "CPU"), h("div.v", pct(state.cpu)), bar(state.cpu)),
        h("div.metric", h("div.k", "Memory"), h("div.v", pct(mem)), bar(mem))),
      h("div", { style: { height: "10px" } }),
      kv([
        ["Uptime", fmtUptime(l.uptimeSecs)],
        ["Load", (l.load || []).map((x) => x.toFixed(2)).join(" / ")],
        ["Memory", l.memTotalKb ? `${formatBytes((l.memTotalKb - l.memAvailableKb) * 1024)} of ${formatBytes(l.memTotalKb * 1024)}` : "–"],
        (l.temperatures || []).length ? ["Temperature", `${Math.max(...l.temperatures).toFixed(0)} °C`] : null,
      ]),
    );
    renderHead();
  }

  function renderClients() {
    const c = state.clients || [];
    const online = c.filter((x) => x.online);
    const wired = online.filter((x) => x.kind !== "vpn").length;
    const vpnN = online.filter((x) => x.kind === "vpn").length;
    clear(ui.clients).append(
      h("div.big", String(online.length)),
      h("div.hint", { style: { marginBottom: "8px" } }, `online now · ${c.length} known`),
      kv([["Wired / LAN", String(wired)], ["VPN", String(vpnN)], ["Fixed IP", String(c.filter((x) => x.fixedIp).length)], ["Blocked", String(c.filter((x) => x.blocked).length)]]),
    );
  }

  function renderNetworks() {
    const nets = (state.networks || []).filter((n) => !n.vpn && n.iface !== state.wan && n.type !== "loopback");
    const pools = [];
    for (const [name, n] of Object.entries(state.dhcp || {})) {
      for (const [cidr, s] of Object.entries(n?.subnet || {})) {
        for (const r of Object.values(s?.range || {})) {
          const num = (ip) => ip.split(".").reduce((a, b) => a * 256 + Number(b), 0);
          if (r?.start && r?.stop) pools.push({ name, cidr, size: num(r.stop) - num(r.start) + 1 });
        }
      }
    }
    const rows = nets.map((n) => {
      const inNet = (state.clients || []).filter((c) => c.online && c.ip && ipv4InCidr(c.ip, n.cidr)).length;
      const pool = pools.find((p) => p.cidr === n.cidr);
      const used = pool ? (state.clients || []).filter((c) => c.source.includes("dhcp") && c.ip && ipv4InCidr(c.ip, n.cidr)).length : 0;
      return h("div",
        h("span.grow", h("b", n.description || n.iface), h("span.hint", ` ${n.cidr}`)),
        pool ? h("span", { style: { width: "70px" } }, h("div.bar", h("span", { style: { width: `${Math.min(100, (used / pool.size) * 100)}%` } }))) : h("span.hint", "no DHCP"),
        h("span.num", `${inNet} online`));
    });
    clear(ui.networks).append(rows.length ? h("div.list-rows", rows) : h("div.empty", "No LAN networks configured yet. Try Quick Set."));
  }

  function renderTop() {
    const c = (state.clients || []).filter((x) => x.connections > 0).sort((a, b) => b.connections - a.connections).slice(0, 6);
    const max = Math.max(1, ...c.map((x) => x.connections));
    clear(ui.top).append(c.length
      ? h("div.list-rows", c.map((x) => h("div",
          h("span.dot.on"),
          h("span.grow", h("b", x.label), x.label !== x.ip ? h("span.hint", ` ${x.ip}`) : null),
          h("span", { style: { width: "90px" } }, h("div.bar", h("span", { style: { width: `${(x.connections / max) * 100}%` } }))),
          h("span.num", `${x.connections} conn.`))))
      : h("div.empty", "No active connections right now."));
  }

  function renderVpn() {
    const peers = (state.clients || []).filter((x) => x.kind === "vpn" && x.source.includes("wireguard"));
    const on = peers.filter((p) => p.online);
    clear(ui.vpn).append(
      h("div.big", `${on.length}/${peers.length}`),
      h("div.hint", { style: { marginBottom: "8px" } }, "WireGuard devices connected"),
      peers.length
        ? h("div.list-rows", peers.slice(0, 5).map((p) => h("div", h(`span.dot${p.online ? ".on" : ""}`), h("span.grow", p.label), h("span.num", p.online ? "online" : "offline"))))
        : h("div.empty", "No WireGuard devices. Use VPN → Quick Setup."),
    );
  }

  function renderAlerts() {
    const list = [];
    if (session.unsaved) list.push(["warn", "Unsaved changes: lost on reboot until you Save."]);
    if (session.confirmDeadline) list.push(["warn", "Safe Mode change waiting for Confirm."]);
    if (state.latency && state.latency.lossPercent >= 100) list.push(["bad", `No reply from ${PING_TARGET}: internet may be down.`]);
    else if (state.latency?.lossPercent > 0) list.push(["warn", `${state.latency.lossPercent}% packet loss to ${PING_TARGET}.`]);
    if (state.cpu >= 90) list.push(["warn", `CPU at ${Math.round(state.cpu)}%.`]);
    const l = state.load;
    if (l?.memTotalKb && l.memAvailableKb / l.memTotalKb < 0.1) list.push(["warn", "Memory almost full."]);
    if (state.ifaces && state.links) {
      for (const [name, c] of flattenInterfaces(state.ifaces)) {
        if (has(c.cfg, "disable") || c.type === "loopback" || c.type === "wireguard") continue;
        const link = state.links.find((x) => x.ifname === name);
        if (link && !(link.flags || []).includes("LOWER_UP") && link.operstate !== "UP" && link.operstate !== "UNKNOWN") list.push(["bad", `${name} is down.`]);
      }
    }
    if (state.dns?.error) list.push(["bad", "The Technitium DNS server is unreachable."]);
    if (state.clients?.some((c) => c.blocked && c.online)) list.push(["warn", "A blocked client is still present on the network."]);
    clear(ui.alerts).append(list.length
      ? h("div", list.map(([lvl, t]) => h("div.alert-item", h(`span.pill.${lvl}`, lvl === "bad" ? "problem" : "notice"), h("span", t))))
      : h("div.empty", h("span.pill.ok", "all good"), " Nothing needs attention."));
  }

  async function pollDns() {
    const sum = await dnsSummary().catch(() => null);
    if (!ui) return;
    state.dns = sum;
    ui.dnsCard.hidden = !sum;
    if (!sum) return;
    if (sum.error) {
      clear(ui.dns).append(h("div.empty", h("span.pill.bad", "unreachable"), ` ${sum.error}`));
      renderAlerts();
      return;
    }
    const st = sum.stats || {};
    const names = new Map((state.clients || []).filter((c) => c.ip).map((c) => [c.ip, c.label]));
    const list = (title, rows, label) => h("div", { style: { flex: "1", minWidth: "200px" } },
      h("div.hint", title),
      rows.length
        ? h("div.list-rows", rows.slice(0, 5).map((r) => h("div", h("span.grow", label(r)), h("span.num", r.hits.toLocaleString()))))
        : h("div.empty", "None"));
    const blockedPct = st.totalQueries ? (st.totalBlocked / st.totalQueries) * 100 : NaN;
    clear(ui.dns).append(h("div", { style: { display: "flex", gap: "24px", flexWrap: "wrap" } },
      h("div", { style: { minWidth: "150px" } },
        h("div.big", (st.totalQueries ?? 0).toLocaleString()),
        h("div.hint", "queries"),
        h("div", { style: { marginTop: "6px" } }, h("b", `${(st.totalBlocked ?? 0).toLocaleString()} blocked`), ` (${pct(blockedPct)})`),
        h("div.hint", `${st.totalClients ?? 0} clients · ${pct(st.totalQueries ? (st.totalCached / st.totalQueries) * 100 : NaN)} from cache`)),
      list("Most active clients", sum.allClients || [], (r) => names.get(r.name) || r.domain || r.name),
      list("Top domains", sum.topDomains || [], (r) => r.name),
      list("Top blocked", sum.topBlockedDomains || [], (r) => r.name)));
    renderAlerts();
  }

  function start() {
    if (!isConnected()) {
      clear(root).append(h("div.dash", h("div.card.span-12", h("h3", "Not connected"), h("div", "Connect to a router to see its dashboard."))));
      return;
    }
    stop();
    ui = build();
    state = {};
    prevCpu = null;
    prevWan = null;
    renderHead();
    pollClients().then(pollTraffic);
    pollLoad();
    pollLatency();
    pollDns();
    timers = [setInterval(pollTraffic, 2000), setInterval(pollLoad, 3000), setInterval(pollClients, 10000), setInterval(pollLatency, 20000), setInterval(pollDns, 60000)];
  }

  function stop() {
    timers.forEach(clearInterval);
    timers = [];
  }

  registerView("dashboard", { show: start, hide: stop });
  return { refresh: () => (!root.hidden ? start() : null), stop };
}
