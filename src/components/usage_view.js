// Insights, "Data usage": data used per day (download and upload stacked),
// for all devices or one, over a week to a year, and the devices that used
// the most in that period. Click a device to see only its days.
import { api, errorText } from "../lib/api.js";
import { h, clear, formatBytes } from "../lib/dom.js";
import { niceMax, fitWidth } from "../lib/chart.js";

const PERIODS = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "3 months", days: 91 },
  { label: "1 year", days: 365 },
];

let wanted = null; // { key, label }: set by the Clients page before opening Insights

/** Open Insights with this device selected (Clients → a device → Data usage). */
export function showUsageFor(key, label) {
  wanted = { key, label };
}

/** A device is waiting to be shown (Insights then doesn't keep the old page up while it loads). */
export const usagePending = () => !!wanted;

const ns = "http://www.w3.org/2000/svg";
function el(tag, attrs, text) {
  const n = document.createElementNS(ns, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

/** Bars per day: [{ day: "YYYY-MM-DD", down, up }] over `days` days ending today. */
export function usageChart(list, days, W = 900) {
  const H = 200;
  const PAD = { l: 64, r: 8, t: 8, b: 24 };
  const byDay = new Map(list.map((d) => [d.day, d]));
  const end = new Date();
  const all = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    all.push(byDay.get(key) || { day: key, down: 0, up: 0 });
  }
  const max = niceMax(Math.max(1e6, ...all.map((d) => d.down + d.up)));
  const bw = (W - PAD.l - PAD.r) / all.length;
  const y = (v) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "insight-chart usage-chart", width: W, height: H });
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    svg.append(el("line", { x1: PAD.l, x2: W - PAD.r, y1: y(v), y2: y(v), class: "grid" }));
    svg.append(el("text", { x: PAD.l - 6, y: y(v) + 4, "text-anchor": "end", class: "axis" }, formatBytes(v)));
  }
  all.forEach((d, i) => {
    const x = PAD.l + i * bw + Math.min(1, bw * 0.15);
    const w = Math.max(1, bw - Math.min(2, bw * 0.3));
    const g = el("g", {});
    g.append(el("title", {}, `${d.day}: ↓ ${formatBytes(d.down)} ↑ ${formatBytes(d.up)}`));
    if (d.down) g.append(el("rect", { x, y: y(d.down), width: w, height: y(0) - y(d.down), class: "down" }));
    if (d.up) g.append(el("rect", { x, y: y(d.down + d.up), width: w, height: y(d.down) - y(d.down + d.up), class: "up" }));
    svg.append(g);
  });
  const labels = Math.min(6, all.length);
  for (let i = 0; i < labels; i++) {
    const idx = Math.round((i * (all.length - 1)) / Math.max(1, labels - 1));
    const d = new Date(`${all[idx].day}T12:00:00`);
    svg.append(el("text", { x: PAD.l + idx * bw + bw / 2, y: H - 6, "text-anchor": i === 0 ? "start" : i === labels - 1 ? "end" : "middle", class: "axis" }, d.toLocaleDateString([], { month: "short", day: "numeric" })));
  }
  const down = all.reduce((s, d) => s + d.down, 0);
  const up = all.reduce((s, d) => s + d.up, 0);
  const counted = all.filter((d) => d.down || d.up).length;
  return h("div", svg,
    h("div.legend", h("span.sw.down"), `Download ${formatBytes(down)}`, h("span.sw.up", { style: { marginLeft: "14px" } }), `Upload ${formatBytes(up)}`,
      h("span", { style: { marginLeft: "14px" } }, counted ? `· ${formatBytes((down + up) / counted)} a day on average` : "")));
}

/** The card; `names` maps MAC/IP to device names. Loads itself. */
export function usageCard(names) {
  let period = PERIODS[1];
  let selected = wanted;
  wanted = null;
  if (selected) period = PERIODS[1];
  const body = h("div", h("div.hint", "Loading…"));
  const title = h("span");
  const seg = h("span.seg");
  const card = h("div.card.usage-card", h("h3", title, seg), body);

  async function load() {
    title.textContent = selected ? `Data usage: ${selected.label}` : "Data usage";
    clear(seg).append(...PERIODS.map((p) => h(`button${p === period ? ".on" : ""}`, { on: { click: () => { period = p; load(); } } }, p.label)));
    let r;
    try {
      r = await api.watchUsage(period.days, selected?.key || null);
    } catch (e) {
      clear(body).append(h("div.err-box", errorText(e)));
      return;
    }
    const total = r.devices.reduce((s, d) => s + d.down + d.up, 0);
    const name = (d) => names.get(d.key) || d.name || d.ip || d.key;
    const rows = r.devices.slice(0, 50).map((d) => h(`tr${selected?.key === d.key ? ".sel" : ""}`, {
      style: { cursor: "pointer" },
      title: "Show this device's days",
      on: { click: () => {
        selected = selected?.key === d.key ? null : { key: d.key, label: name(d) };
        load();
      } },
    },
    h("td", h("div", name(d)), h("div.hint", [d.ip, d.key !== d.ip ? d.key : ""].filter(Boolean).join(" · "))),
    h("td.num", formatBytes(d.down)), h("td.num", formatBytes(d.up)),
    h("td.num", h("div.share", h("span", { style: { width: `${total ? Math.round(((d.down + d.up) / total) * 100) : 0}%` } }), total ? `${Math.round(((d.down + d.up) / total) * 100)}%` : ""))));
    clear(body).append(
      selected ? h("div.hint", { style: { marginBottom: "6px" } }, `Only ${selected.label}. `, h("button.link", { on: { click: () => { selected = null; load(); } } }, "All devices")) : "",
      r.days.length ? fitWidth((w) => usageChart(r.days, period.days, w)) : h("div.empty", "Nothing recorded in this period yet."),
      r.devices.length
        ? h("table.grid.insight-devices", { style: { marginTop: "12px" } },
          h("thead", h("tr", h("th", `Devices, last ${period.label}`), h("th.num", "Download"), h("th.num", "Upload"), h("th.num", "Share"))),
          h("tbody", rows))
        : h("div.empty", "No data per device yet. This needs traffic counting on the router (Clients → Turn on traffic counting)."),
      h("div.hint", { style: { marginTop: "6px" } }, "Counted from the router's connection tracking every minute while 24/7 watching is on; kept for a year."));
  }
  load();
  return card;
}
