// Search bar matching: plain words people use, mapped to where that lives in
// VyGi, plus a scorer. Pure: the search component feeds it live data.

/** Everyday words -> page (p:) or Advanced tool (t:) names. */
export const SYNONYMS = [
  [["password", "login", "account", "admin"], ["t:Users", "p:dashboard"]],
  [["security", "hacked", "safe", "exposed", "health", "problem", "conflict", "doctor", "fix"], ["p:simple", "p:dashboard"]],
  [["easy", "simple", "switch", "lag", "gaming", "bufferbloat", "video call", "guest wifi", "ad block", "adblock", "ads"], ["p:simple"]],
  [["time", "timezone", "time zone", "clock", "ntp", "date"], ["t:Identity & Clock"]],
  [["hostname", "router name", "rename router"], ["t:Identity & Clock"]],
  [["upgrade", "update", "firmware", "version", "image"], ["t:Images (Upgrade)"]],
  [["backup", "restore", "export", "import"], ["t:Backup / Restore"]],
  [["reboot", "restart"], ["t:Reboot"]],
  [["shutdown", "power off", "turn off"], ["t:Shut Down"]],
  [["dhcp", "lease", "ip address", "fixed ip", "static ip", "reservation"], ["t:DHCP Server", "t:DHCP Leases", "p:clients"]],
  [["port forward", "forward", "open port", "nat", "game server", "minecraft", "plex"], ["p:ports", "t:NAT"]],
  [["vpn", "wireguard", "qr", "remote access", "teleport"], ["p:vpn"]],
  [["block", "parental", "kids", "bedtime", "schedule", "tiktok", "country", "region", "geo"], ["p:rules"]],
  [["vlan", "bridge", "subnet", "guest", "iot", "network", "lan"], ["p:networks", "t:Interfaces"]],
  [["port", "ethernet", "cable", "link", "interface", "wan"], ["t:Interfaces"]],
  [["speed", "bandwidth", "limit", "qos", "throttle", "queue"], ["t:Queues", "p:dashboard"]],
  [["speed test", "speedtest", "internet speed"], ["p:dashboard"]],
  [["dns", "ad block", "adblock", "ads", "technitium", "pihole"], ["t:DNS", "t:DNS Server (Technitium)"]],
  [["ddns", "dynamic dns", "duckdns", "no-ip", "cloudflare"], ["t:Dynamic DNS"]],
  [["firewall", "filter", "rule"], ["t:Filter Rules", "p:rules"]],
  [["log", "syslog", "events"], ["t:Log"]],
  [["terminal", "cli", "ssh", "command"], ["t:New Terminal"]],
  [["undo", "history", "changes", "revert", "rollback"], ["p:history", "t:Revisions / Rollback"]],
  [["alert", "notify", "notification", "watch", "netwatch", "monitor"], ["a:alerts"]],
  [["device", "devices", "client", "phone", "laptop", "wake", "wol"], ["p:clients"]],
  [["traffic", "usage", "sites", "where"], ["p:clients", "p:dashboard"]],
  [["ping", "traceroute", "scan", "torch", "sniffer", "capture"], ["t:Ping", "t:Traceroute", "t:IP Scan", "t:Torch"]],
  [["cpu", "memory", "temperature", "disk", "uptime"], ["t:Resources"]],
  [["route", "routing", "gateway", "bgp", "ospf"], ["t:Routes", "t:Routing Protocols"]],
  [["setup", "wizard", "quick", "start"], ["t:Quick Set"]],
  [["claude", "ai", "report", "support", "help", "diagnose"], ["t:Report for Claude"]],
];

/** 0 = no match; higher is better. Word starts and exact matches win. */
export function score(text, q) {
  const t = String(text || "").toLowerCase();
  if (!q || !t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t)) return 60;
  if (t.includes(q)) return 40;
  return 0;
}

/** Targets ("p:..", "t:..", "a:..") whose everyday words match q. */
export function synonymTargets(q) {
  const out = new Map();
  for (const [words, targets] of SYNONYMS) {
    const best = Math.max(...words.map((w) => (w.startsWith(q) || q.startsWith(w) ? 50 : w.includes(q) && q.length >= 3 ? 30 : 0)));
    if (best) for (const t of targets) out.set(t, Math.max(out.get(t) || 0, best));
  }
  return out;
}

/** Config leaves as "path words = value" lines (for searching settings). */
export function flattenConfig(node, path = [], out = [], limit = 5000) {
  if (out.length >= limit) return out;
  if (node == null || typeof node !== "object" || Array.isArray(node)) {
    const vals = Array.isArray(node) ? node : node == null ? [] : [node];
    out.push({ path, text: `${path.join(" ")}${vals.length ? ` ${vals.join(" ")}` : ""}` });
    return out;
  }
  const keys = Object.keys(node);
  if (!keys.length) out.push({ path, text: path.join(" ") });
  for (const k of keys) {
    // secrets never become searchable text
    if (/private-key|password|preshared|secret|^key$/.test(k)) continue;
    flattenConfig(node[k], [...path, k], out, limit);
  }
  return out;
}
