// Insights page (web version): what the VyGi server recorded while watching
// the router 24/7: internet traffic over time, data per device, and the
// router's system log with search.
import { api, errorText } from "../lib/api.js";
import { h, clear, formatBits, formatBytes } from "../lib/dom.js";
import { isConnected, onSessionChange } from "../lib/session.js";
import { registerView, welcome, loadingPage } from "../lib/views.js";
import { icon } from "../lib/icons.js";
import { niceMax, splitAtGaps } from "../lib/chart.js";
import { collectClients } from "../lib/netdata.js";

const RANGES = [
  { label: "24 hours", hours: 24, days: 1 },
  { label: "7 days", hours: 24 * 7, days: 7 },
  { label: "30 days", hours: 24 * 30, days: 30 },
];
const LEVELS = [
  { label: "everything", p: 7 },
  { label: "warnings and worse", p: 4 },
  { label: "errors only", p: 3 },
];

/** Static line chart of [[t, down, up], ...] as SVG. */
function trafficChart(points) {
  const W = 900;
  const H = 220;
  const PAD = { l: 64, r: 10, t: 10, b: 26 };
  if (points.length < 2) return h("div.empty", "Not enough data yet. The server records a point every minute.");
  points = [...points].sort((a, b) => a[0] - b[0]);
  const t0 = points[0][0];
  const t1 = points[points.length - 1][0];
  const max = niceMax(Math.max(1000, ...points.map((p) => Math.max(p[1], p[2]))));
  const x = (t) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (v) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  // no line across times nothing was recorded (server or router off): break it at gaps
  const runs = splitAtGaps(points);
  const lines = (i, cls) => runs.map((run) => el(run.length === 1 ? "circle" : "polyline", run.length === 1
    ? { cx: x(run[0][0]).toFixed(1), cy: y(run[0][i]).toFixed(1), r: 1.5, class: `${cls} dot` }
    : { points: run.map((p) => `${x(p[0]).toFixed(1)},${y(p[i]).toFixed(1)}`).join(" "), class: cls }));
  const ns = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, text) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "insight-chart", preserveAspectRatio: "none" });
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    svg.append(el("line", { x1: PAD.l, x2: W - PAD.r, y1: y(v), y2: y(v), class: "grid" }));
    svg.append(el("text", { x: PAD.l - 6, y: y(v) + 4, "text-anchor": "end", class: "axis" }, formatBits(v)));
  }
  const span = t1 - t0;
  for (let i = 0; i <= 4; i++) {
    const t = t0 + (span * i) / 4;
    const d = new Date(t);
    const label = span > 2 * 86_400_000 ? d.toLocaleDateString([], { month: "short", day: "numeric" }) : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    svg.append(el("text", { x: x(t), y: H - 6, "text-anchor": i === 0 ? "start" : i === 4 ? "end" : "middle", class: "axis" }, label));
  }
  svg.append(...lines(1, "down"), ...lines(2, "up"));
  const peak = points.reduce((a, p) => (p[1] > a[1] ? p : a));
  const avg = (i) => points.reduce((s, p) => s + p[i], 0) / points.length;
  return h("div",
    svg,
    h("div.legend", h("span.sw.down"), `Download · average ${formatBits(avg(1))} · peak ${formatBits(peak[1])} (${new Date(peak[0]).toLocaleString([], { dateStyle: "short", timeStyle: "short" })})`,
      h("span.sw.up", { style: { marginLeft: "14px" } }), `Upload · average ${formatBits(avg(2))}`));
}

export function initInsights() {
  const root = document.getElementById("insights");
  let range = RANGES[0];
  let names = new Map(); // mac / ip -> current name
  let seq = 0;
  const logQuery = h("input", { type: "search", placeholder: "Search the log (e.g. sshd, eth1, failed)" });
  const logLevel = h("select", LEVELS.map((l) => h("option", { value: String(l.p) }, l.label)));
  const logBox = h("div.log-results");

  async function render() {
    const mine = ++seq;
    if (!isConnected()) {
      clear(root).append(welcome(() => document.getElementById("btn-connect").click()));
      return;
    }
    if (!root.querySelector(".page")) clear(root).append(loadingPage(2));
    let w;
    try {
      w = await api.watchGet();
    } catch (e) {
      if (mine === seq) clear(root).append(h("div.page", h("div.err-box", errorText(e))));
      return;
    }
    if (mine !== seq) return;
    if (!w.router?.enabled) {
      const on = h("button.primary", { on: { click: async () => {
        on.disabled = true;
        try {
          await api.watchSet({ enabled: true });
        } catch (e) {
          on.disabled = false;
          return clear(root.querySelector(".page")).append(h("div.err-box", errorText(e)));
        }
        render();
      } } }, "Watch this router 24/7");
      clear(root).append(h("div.page", h("div.empty-state",
        h("span.net-icon", icon("dashboard", 20)),
        h("div", h("b", "Nothing recorded yet"), h("div.hint", "When the VyGi server watches this router 24/7, it records internet traffic, data used per device and the router's system log, and alerts you even when no VyGi tab is open.")),
        on)));
      return;
    }
    const [traffic, devices, clients] = await Promise.all([
      api.watchTraffic(range.hours).catch(() => []),
      api.watchDevices(range.days).catch(() => []),
      collectClients().then((r) => r.clients).catch(() => []),
    ]);
    if (mine !== seq) return;
    names = new Map();
    for (const c of clients) {
      if (c.mac) names.set(c.mac, c.label);
      if (c.ip) names.set(c.ip, c.label);
    }
    const st = w.status || {};
    const head = h("div.page-head",
      h("div.hint", st.error ? `Watching: ${st.error}` : `Watched 24/7 by the VyGi server${st.lastCheck ? `, last check ${new Date(st.lastCheck).toLocaleTimeString()}` : ""}.`),
      h("span.grow"),
      h("span.seg", RANGES.map((r) => h(`button${r === range ? ".on" : ""}`, { on: { click: () => { range = r; render(); } } }, r.label))));
    const total = devices.reduce((s, d) => s + d.down + d.up, 0);
    const devTable = devices.length
      ? h("table.grid.insight-devices", h("thead", h("tr", h("th", "Device"), h("th.num", "Download"), h("th.num", "Upload"), h("th.num", "Share"))),
          h("tbody", devices.slice(0, 25).map((d) => h("tr",
            h("td", h("div", names.get(d.key) || d.name || d.ip || d.key), h("div.hint", [d.ip, d.key !== d.ip ? d.key : ""].filter(Boolean).join(" · "))),
            h("td.num", formatBytes(d.down)), h("td.num", formatBytes(d.up)),
            h("td.num", total ? `${Math.round(((d.down + d.up) / total) * 100)}%` : "")))))
      : h("div.empty", "No data per device yet. This needs traffic counting on the router (Clients → Turn on traffic counting).");
    clear(root).append(h("div.page", head,
      h("div.card", h("h3", h("span", `Internet traffic, last ${range.label}`)), trafficChart(traffic)),
      h("div.card", h("h3", h("span", `Data per device, last ${range.label}`)), devTable),
      h("div.card", h("h3", h("span", "System log")),
        h("div.log-bar", logQuery, logLevel, h("button", { on: { click: searchLogs } }, "Search")),
        logBox)));
    searchLogs();
  }

  async function searchLogs() {
    logBox.replaceChildren(h("div.hint", "Searching…"));
    try {
      const lines = await api.watchLogs(logQuery.value.trim(), range.days, Number(logLevel.value), 500);
      if (!lines.length) return logBox.replaceChildren(h("div.empty", logQuery.value.trim() ? "No matching log lines." : "No log lines recorded yet."));
      logBox.replaceChildren(h("div.log-lines", lines.map((l) => h(`div.log-line.p${l.p}`,
        h("span.t", new Date(l.t).toLocaleString([], { dateStyle: "short", timeStyle: "medium" })),
        h("span.id", l.id),
        h("span.m", l.m)))),
        ...(lines.length >= 500 ? [h("div.hint", "Showing the newest 500 matches. Narrow the search to see older ones.")] : []));
    } catch (e) {
      logBox.replaceChildren(h("div.err-box", errorText(e)));
    }
  }
  logQuery.addEventListener("keydown", (e) => e.key === "Enter" && searchLogs());
  logLevel.addEventListener("change", searchLogs);

  onSessionChange(() => {
    if (!root.hidden) render();
  });
  registerView("insights", { show: render, hide: () => {} });
}
