// Turns a device's connections into "sites" (YouTube, Netflix, github.com, …),
// UniFi-style. Domains come from Technitium's query log (IP -> name it resolved
// to); without it, connections are grouped by the network that owns the IP.
// Pure: no API calls.

/** Known services: domain suffixes -> display name and the domain to take its icon from. */
const BRANDS = [
  ["YouTube", "youtube.com", ["youtube.com", "googlevideo.com", "ytimg.com", "youtu.be", "youtube-nocookie.com", "yt3.ggpht.com", "youtubei.googleapis.com"]],
  ["Google Ads & Analytics", "google.com", ["doubleclick.net", "googlesyndication.com", "googleadservices.com", "google-analytics.com", "googletagmanager.com", "app-measurement.com"]],
  ["Google", "google.com", ["google.com", "googleapis.com", "gstatic.com", "googleusercontent.com", "1e100.net", "gvt1.com", "gvt2.com", "ggpht.com", "google.co.uk", "android.com", "gmail.com"]],
  ["Netflix", "netflix.com", ["netflix.com", "nflxvideo.net", "nflximg.net", "nflxso.net", "nflxext.com", "netflix.net"]],
  ["Facebook", "facebook.com", ["facebook.com", "fbcdn.net", "fbsbx.com", "facebook.net", "fb.com", "messenger.com"]],
  ["Instagram", "instagram.com", ["instagram.com", "cdninstagram.com"]],
  ["WhatsApp", "whatsapp.com", ["whatsapp.com", "whatsapp.net"]],
  ["Apple", "apple.com", ["apple.com", "icloud.com", "mzstatic.com", "apple-dns.net", "cdn-apple.com", "aaplimg.com", "icloud-content.com", "apple-cloudkit.com"]],
  ["Xbox", "xbox.com", ["xbox.com", "xboxlive.com", "xboxservices.com"]],
  ["Microsoft", "microsoft.com", ["microsoft.com", "windowsupdate.com", "live.com", "office.com", "office.net", "msftconnecttest.com", "msn.com", "bing.com", "skype.com", "windows.com", "microsoftonline.com", "outlook.com", "sharepoint.com", "onedrive.com", "msedge.net"]],
  ["Prime Video", "primevideo.com", ["primevideo.com", "aiv-cdn.net", "aiv-delivery.net", "amazonvideo.com"]],
  ["Amazon", "amazon.com", ["amazon.com", "media-amazon.com", "ssl-images-amazon.com", "amazon.co.uk", "amazon.de"]],
  ["Amazon AWS", "aws.amazon.com", ["amazonaws.com", "cloudfront.net"]],
  ["Spotify", "spotify.com", ["spotify.com", "scdn.co", "spotifycdn.com", "spotifycdn.net"]],
  ["TikTok", "tiktok.com", ["tiktok.com", "tiktokcdn.com", "tiktokv.com", "byteoversea.com", "ibytedtos.com", "tiktokcdn-us.com", "ttwstatic.com"]],
  ["Twitch", "twitch.tv", ["twitch.tv", "ttvnw.net", "jtvnw.net"]],
  ["Discord", "discord.com", ["discord.com", "discord.gg", "discordapp.com", "discordapp.net", "discord.media"]],
  ["Steam", "steampowered.com", ["steampowered.com", "steamcommunity.com", "steamcontent.com", "steamstatic.com", "steamserver.net"]],
  ["Reddit", "reddit.com", ["reddit.com", "redd.it", "redditmedia.com", "redditstatic.com"]],
  ["X (Twitter)", "x.com", ["x.com", "twitter.com", "twimg.com", "t.co"]],
  ["Roblox", "roblox.com", ["roblox.com", "rbxcdn.com"]],
  ["Epic Games", "epicgames.com", ["epicgames.com", "unrealengine.com", "fortnite.com"]],
  ["PlayStation", "playstation.com", ["playstation.com", "playstation.net", "sonyentertainmentnetwork.com"]],
  ["Nintendo", "nintendo.com", ["nintendo.com", "nintendo.net"]],
  ["Disney+", "disneyplus.com", ["disneyplus.com", "bamgrid.com", "dssott.com", "disney-plus.net"]],
  ["Hulu", "hulu.com", ["hulu.com", "hulustream.com", "huluim.com"]],
  ["Zoom", "zoom.us", ["zoom.us", "zoom.com"]],
  ["GitHub", "github.com", ["github.com", "githubusercontent.com", "github.io", "githubassets.com"]],
  ["Wikipedia", "wikipedia.org", ["wikipedia.org", "wikimedia.org"]],
  ["LinkedIn", "linkedin.com", ["linkedin.com", "licdn.com"]],
  ["Snapchat", "snapchat.com", ["snapchat.com", "sc-cdn.net", "snapkit.com"]],
  ["Pinterest", "pinterest.com", ["pinterest.com", "pinimg.com"]],
  ["Cloudflare", "cloudflare.com", ["cloudflare.com", "cloudflare-dns.com", "one.one.one.one"]],
  ["Akamai (CDN)", "akamai.com", ["akamaihd.net", "akamaized.net", "akamaiedge.net", "akamai.net", "edgekey.net", "edgesuite.net"]],
];

/** Network owners (from GeoIP) that map to a known service when no domain is known. */
const ORG_BRANDS = [
  [/google/i, "Google", "google.com"],
  [/netflix/i, "Netflix", "netflix.com"],
  [/facebook|meta platforms/i, "Meta (Facebook)", "facebook.com"],
  [/apple/i, "Apple", "apple.com"],
  [/microsoft/i, "Microsoft", "microsoft.com"],
  [/amazon/i, "Amazon AWS", "aws.amazon.com"],
  [/cloudflare/i, "Cloudflare", "cloudflare.com"],
  [/akamai/i, "Akamai (CDN)", "akamai.com"],
  [/fastly/i, "Fastly (CDN)", "fastly.com"],
  [/valve/i, "Steam", "steampowered.com"],
  [/tiktok|bytedance/i, "TikTok", "tiktok.com"],
];

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go", "gob", "nic", "mil"]);

const endsWith = (d, suffix) => d === suffix || d.endsWith(`.${suffix}`);

/** "i.ytimg.com" -> { key, name, icon } of the site it belongs to. */
export function siteOf(domain) {
  const d = String(domain || "").toLowerCase().replace(/\.$/, "");
  for (const [name, icon, suffixes] of BRANDS) {
    if (suffixes.some((s) => endsWith(d, s))) return { key: `brand:${name}`, name, icon };
  }
  const labels = d.split(".").filter(Boolean);
  let n = 2;
  if (labels.length >= 3 && labels.at(-1).length === 2 && SECOND_LEVEL.has(labels.at(-2))) n = 3; // bbc.co.uk
  const reg = labels.slice(-n).join(".");
  return { key: `domain:${reg}`, name: reg, icon: reg };
}

/** Site for a connection with no known domain, from its network owner. */
export function siteFromOrg(org, asn) {
  for (const [re, name, icon] of ORG_BRANDS) if (re.test(org || "")) return { key: `brand:${name}`, name, icon };
  if (org) return { key: `org:${asn || org}`, name: prettyOrg(org), icon: null };
  return { key: "unknown", name: "Unknown", icon: null };
}

/** "GOOGLE-CLOUD-PLATFORM" / "Hetzner Online GmbH" -> readable. */
export function prettyOrg(org) {
  const s = String(org || "").trim();
  if (s === s.toUpperCase() && /[A-Z]/.test(s)) return s.toLowerCase().replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return s;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f]*:[0-9a-f:]+$/i;

/** IPs in a Technitium query-log "answer" ("cname.example., 1.2.3.4, 5.6.7.8"). */
export function answerIps(answer) {
  return String(answer || "").split(/[\s,]+/).map((t) => t.replace(/^\[|\]$/g, "")).filter((t) => IPV4.test(t) || IPV6.test(t));
}

/** Query-log entries (newest first) -> Map ip -> domain (newest answer wins). */
export function ipDomainMap(entries) {
  const map = new Map();
  for (const e of entries || []) {
    if (!e?.qname || /Blocked/.test(e.responseType || "")) continue;
    for (const ip of answerIps(e.answer)) if (!map.has(ip)) map.set(ip, String(e.qname).toLowerCase().replace(/\.$/, ""));
  }
  return map;
}

/**
 * remotes: [{ remote, down, up, totalDown, totalUp, conns, port }] for one device (or all).
 * ipToDomain: Map ip -> domain. geo: { ip: { country, asn, org } }.
 * Returns sites sorted by data, each with domains, countries and totals.
 */
export function groupSites(remotes, ipToDomain = new Map(), geo = {}) {
  const sites = new Map();
  for (const r of remotes) {
    const domain = ipToDomain.get(r.remote);
    const g = geo[r.remote] || {};
    const site = domain ? siteOf(domain) : siteFromOrg(g.org, g.asn);
    const s = sites.get(site.key) || { ...site, domains: new Set(), ips: new Set(), countries: new Set(), orgs: new Set(), down: 0, up: 0, totalDown: 0, totalUp: 0, conns: 0 };
    if (domain) s.domains.add(domain);
    s.ips.add(r.remote);
    if (g.country) s.countries.add(g.country);
    if (g.org) s.orgs.add(prettyOrg(g.org));
    s.down += r.down || 0;
    s.up += r.up || 0;
    s.totalDown += r.totalDown || 0;
    s.totalUp += r.totalUp || 0;
    s.conns += r.conns || 1;
    sites.set(site.key, s);
  }
  return [...sites.values()].sort((a, b) => (b.down + b.up) - (a.down + a.up) || (b.totalDown + b.totalUp) - (a.totalDown + a.totalUp));
}

/** "US" -> "🇺🇸" (regional indicator letters). */
export function flagEmoji(cc) {
  if (!/^[A-Za-z]{2}$/.test(cc || "")) return "";
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

let regionNames = null;
/** "DE" -> "Germany". */
export function countryName(cc) {
  try {
    regionNames ||= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(cc) || cc;
  } catch {
    return cc;
  }
}

/** True for addresses that never leave the local network. */
export function isPrivateIp(ip) {
  return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.|22[4-9]\.|23\d\.|255\.)/.test(ip) || /^(fe80|fc|fd|ff|::1$)/i.test(ip);
}
