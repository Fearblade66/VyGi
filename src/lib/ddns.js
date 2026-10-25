// Dynamic DNS (VyOS `service dns dynamic`, ddclient). Rules mirror vyos-1x
// conf_mode/service_dns_dynamic.py so mistakes are caught before commit.
// Pure: no API calls.

export const BASE = ["service", "dns", "dynamic", "name"];

/** Providers (ddclient protocols VyOS offers), popular ones first, with labels. */
export const PROVIDERS = [
  ["cloudflare", "Cloudflare"],
  ["duckdns", "DuckDNS"],
  ["noip", "No-IP"],
  ["dyndns2", "DynDNS2-compatible (Dyn, Dynu, deSEC, many others)"],
  ["namecheap", "Namecheap"],
  ["porkbun", "Porkbun"],
  ["freedns", "FreeDNS (afraid.org)"],
  ["he.net", "Hurricane Electric"],
  ["godaddy", "GoDaddy"],
  ["digitalocean", "DigitalOcean"],
  ["hetzner", "Hetzner"],
  ["gandi", "Gandi"],
  ["ovh", "OVH"],
  ["inwx", "INWX"],
  ["njalla", "Njalla"],
  ["dnsmadeeasy", "DNS Made Easy"],
  ["easydns", "easyDNS"],
  ["freemyip", "freemyip"],
  ...["1984", "changeip", "ddns.fm", "dinahosting", "dnsexit2", "domeneshop", "dondominio", "dslreports1", "dyndns1", "enom", "infomaniak", "keysystems", "mythicdyn", "nfsn", "regfishde", "sitelutions", "yandex", "zoneedit1"].map((p) => [p, p]),
];

const ZONE_REQUIRED = new Set(["cloudflare", "digitalocean", "godaddy", "hetzner", "gandi", "nfsn"]);
const ZONE_ALLOWED = new Set([...ZONE_REQUIRED, "dnsexit2", "porkbun", "zoneedit1"]);
const NO_USERNAME = new Set(["1984", "cloudflare", "ddns.fm", "digitalocean", "dnsexit2", "duckdns", "freemyip", "gandi", "he.net", "hetzner", "keysystems", "njalla", "regfishde"]);

/** What the form should ask for with this provider. */
export function needs(protocol) {
  return {
    username: !NO_USERNAME.has(protocol),
    zone: ZONE_REQUIRED.has(protocol) ? "required" : ZONE_ALLOWED.has(protocol) ? "optional" : "no",
    hint: {
      cloudflare: "Password = a Cloudflare API token with Zone.DNS edit permission. Zone = your domain (example.com).",
      duckdns: "Host name = yourname.duckdns.org. Password = your DuckDNS token.",
      noip: "Username and password of your No-IP account (or a DDNS key).",
      dyndns2: "Set Server to your provider's update host if it isn't Dyn (e.g. api.dynu.com, update.dedyn.io).",
      porkbun: "Username = API key, password = secret API key. Zone = your domain if the host name is a subdomain.",
      namecheap: "Username = your domain, password = the Dynamic DNS password from Namecheap's Advanced DNS page.",
      "he.net": "Password = the dynamic DNS key of that host name in dns.he.net.",
    }[protocol] || "",
  };
}

const toArr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** Config subtree -> rows for the table/form. */
export function parseDdns(cfg) {
  return Object.entries(cfg || {}).map(([name, c]) => ({
    name,
    protocol: c?.protocol || "",
    hosts: toArr(c?.["host-name"]),
    username: c?.username || "",
    hasPassword: !!c?.password,
    password: c?.password || "",
    zone: c?.zone || "",
    server: c?.server || "",
    source: c?.address?.web ? "web" : "interface",
    iface: c?.address?.interface || "",
    url: c?.address?.web?.url || "",
    ipVersion: c?.["ip-version"] || "",
    description: c?.description || "",
  }));
}

/**
 * Validates form values and returns VyOS commands. `old` is the existing row
 * when editing (a blank password keeps the old one). Throws Error with a
 * user-facing message on bad input.
 */
export function ddnsCommands(v, old = null) {
  const name = String(v.name || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error("Name: letters, digits, - and _");
  const protocol = v.protocol;
  if (!PROVIDERS.some(([p]) => p === protocol)) throw new Error("Choose a provider");
  const n = needs(protocol);
  const hosts = String(v.hosts || "").split(/[\s,]+/).filter(Boolean);
  if (!hosts.length) throw new Error("Enter the host name to keep updated");
  for (const h of hosts) if (!/^(@|\*)?[-.A-Za-z0-9]*$/.test(h) || h.length > 253) throw new Error(`Bad host name: ${h}`);
  const username = String(v.username || "").trim();
  if (n.username && !username) throw new Error("This provider needs a username");
  const password = String(v.password || "") || old?.password || "";
  if (!password) throw new Error("Enter the password / token");
  const zone = String(v.zone || "").trim();
  if (n.zone === "required" && !zone) throw new Error("This provider needs the zone (your domain, e.g. example.com)");
  if (zone && !/^[A-Za-z0-9.-]{1,253}$/.test(zone)) throw new Error("Bad zone");
  const server = String(v.server || "").trim();
  if (server && !/^[A-Za-z0-9.:-]{1,253}$/.test(server)) throw new Error("Server: a host name like api.dynu.com");
  let address;
  if (v.source === "web") {
    const url = String(v.url || "").trim();
    if (!/^https?:\/\/[^\s"']+$/.test(url)) throw new Error("Enter the web address that returns your public IP");
    address = [["web", "url", url]];
  } else {
    if (!v.iface) throw new Error("Choose the internet interface");
    address = [["interface", v.iface]];
  }

  const base = [...BASE, name];
  const cmds = [];
  if (old) cmds.push({ op: "delete", path: [...BASE, old.name] });
  const set = (path, value) => cmds.push({ op: "set", path: [...base, ...path], value });
  set(["protocol"], protocol);
  for (const h of hosts) set(["host-name"], h);
  if (username && n.username) set(["username"], username);
  set(["password"], password);
  if (zone && n.zone !== "no") set(["zone"], zone);
  if (server) set(["server"], server);
  for (const a of address) set(["address", ...a.slice(0, -1)], a.at(-1));
  if (v.ipVersion && v.ipVersion !== "ipv4") set(["ip-version"], v.ipVersion);
  if (String(v.description || "").trim()) set(["description"], String(v.description).trim().replace(/['"]/g, ""));
  return cmds;
}

/** Status rows from `dns.py show_dynamic_status --raw` (entries may be empty objects). */
export function parseStatus(raw) {
  return toArr(raw).filter((e) => e && e.host).map((e) => ({
    host: e.host,
    ip: e.ipv4 || e.ipv6 || "",
    status: e["status-ipv4"] || e["status-ipv6"] || "",
    updated: e.mtime || "",
  }));
}
