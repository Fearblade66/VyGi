// "Where does the traffic go": sites and countries for one device or the whole
// network, from the latest traffic sample + Technitium's query log + GeoIP.
import { api, errorText } from "./api.js";
import { h, formatBits, formatBytes, setStatus } from "./dom.js";
import { lastTraffic } from "./netdata.js";
import { groupSites, ipDomainMap, isPrivateIp, flagEmoji, countryName } from "./sites.js";
import { siteIcon } from "./siteicon.js";
import { recentQueries } from "../components/technitium.js";

// Windows has no flag emoji; it would show two letters instead.
const FLAGS = !/Win/i.test(navigator.platform || navigator.userAgent || "");
export const flag = (cc) => (FLAGS ? `${flagEmoji(cc)} ` : "");

let geoInstalled = null;
export async function geoReady() {
  if (geoInstalled === null) geoInstalled = await api.geoipStatus().then((s) => s.installed).catch(() => false);
  return geoInstalled;
}

/** Downloads the DB-IP Lite databases. Resolves true on success. */
export async function downloadGeo() {
  setStatus("Downloading location data (about 18 MB)…");
  try {
    await api.geoipUpdate();
    geoInstalled = true;
    setStatus("Location data installed. IP data by DB-IP (db-ip.com, CC BY 4.0).");
    return true;
  } catch (e) {
    setStatus(`Location data: ${errorText(e)}`, true);
    return false;
  }
}

/**
 * client: device IP, or null for the whole network.
 * Returns { sites, countries, hasDomains, hasGeo, measured }.
 */
export async function loadSites({ client = null } = {}) {
  const remotes = [...lastTraffic.remotes.values()].filter((r) => !client || r.client === client);
  const pub = remotes.filter((r) => !isPrivateIp(r.remote));
  const local = remotes.filter((r) => isPrivateIp(r.remote));
  const ips = [...new Set(pub.map((r) => r.remote))];
  const hasGeo = await geoReady();
  const [geo, entries] = await Promise.all([
    hasGeo && ips.length ? api.geoipLookup(ips).catch(() => ({})) : {},
    recentQueries({ client: client || "", limit: client ? 1000 : 2000 }),
  ]);
  const sites = groupSites(pub, ipDomainMap(entries || []), geo);
  if (local.length) {
    const l = groupSites(local)[0];
    sites.push({ ...l, key: "local", name: "Local network", icon: null, orgs: new Set() });
  }
  const byCountry = new Map();
  for (const r of pub) {
    const cc = geo[r.remote]?.country;
    if (!cc) continue;
    const c = byCountry.get(cc) || { cc, down: 0, up: 0, total: 0, conns: 0 };
    c.down += r.down || 0;
    c.up += r.up || 0;
    c.total += (r.totalDown || 0) + (r.totalUp || 0);
    c.conns += r.conns || 1;
    byCountry.set(cc, c);
  }
  const countries = [...byCountry.values()].sort((a, b) => (b.down + b.up) - (a.down + a.up) || b.total - a.total);
  return { sites, countries, hasDomains: !!entries, hasGeo, measured: lastTraffic.ready };
}

const rate = (s) => (s.down + s.up >= 1 ? `↓ ${formatBits(s.down * 8)}${s.up >= 1 ? ` ↑ ${formatBits(s.up * 8)}` : ""}` : "");

/** List of sites with icon, domains/owner, countries and speed. */
export function siteRows(sites, { limit = 12 } = {}) {
  if (!sites.length) return h("div.empty", "No connections right now.");
  return h("div.list-rows", sites.slice(0, limit).map((s) => {
    const where = [...s.countries].slice(0, 3).map((cc) => `${flag(cc)}${countryName(cc)}`).join(", ");
    const what = s.domains.size ? [...s.domains].slice(0, 2).join(", ") + (s.domains.size > 2 ? ` +${s.domains.size - 2}` : "") : [...s.orgs][0] || "";
    const sub = [what, where].filter(Boolean).join(" · ");
    return h("div.site-row", { title: `${[...s.ips].slice(0, 8).join(", ")}${s.ips.size > 8 ? " …" : ""}\n${s.conns} connections` },
      siteIcon(s.icon, s.name),
      h("span.grow", h("b", s.name), h("span.sub", sub || " ")),
      h("span.rate", rate(s) || h("span.hint", "idle"), h("span.sub", formatBytes(s.totalDown + s.totalUp))));
  }));
}

/** List of countries with flag, share bar and speed. */
export function countryRows(countries, { limit = 8 } = {}) {
  if (!countries.length) return h("div.empty", "No internet connections right now.");
  const max = Math.max(1, ...countries.map((c) => c.down + c.up || c.total));
  return h("div.list-rows", countries.slice(0, limit).map((c) => h("div",
    h("span.grow", `${flag(c.cc)}${countryName(c.cc)}`),
    h("span", { style: { width: "80px" } }, h("div.bar", h("span", { style: { width: `${((c.down + c.up || c.total) / max) * 100}%` } }))),
    h("span.num", { style: { minWidth: "90px", textAlign: "right" } }, c.down + c.up >= 1 ? `↓ ${formatBits(c.down * 8)}` : formatBytes(c.total)))));
}

/** Footer: what the data is based on, with buttons to improve it. */
export function sitesFootnote({ hasDomains, hasGeo }, onChange) {
  return h("div.hint", { style: { marginTop: "6px" } },
    hasDomains ? "Names from Technitium's query log. " : "Grouped by network owner. Link Technitium with a query log app (IP > DNS Server) to see site names. ",
    hasGeo
      ? "IP data by DB-IP (db-ip.com, CC BY 4.0)."
      : h("button", { on: { click: async () => { if (await downloadGeo()) onChange?.(); } } }, "Download location data (18 MB)"));
}
