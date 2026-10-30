// Which simple page made a setting, from the description VyGi gives
// everything it creates ("VyGi rule 3: Kids bedtime", "VyGi fwd 2: Plex", …),
// so the Advanced windows can say so and send people there. Pure: no API calls.

const OWNERS = [
  // [pattern, feature, view, tab?]  name = first capture group, if any
  [/^VyGi rule \d+: (.*)$/, "Traffic Rules", "rules"],
  [/^VyGi policy \d+: (.*)$/, "Network Policies", "access"],
  [/^VyGi fwd \d+: (.*)$/, "Port Forwarding", "ports"],
  [/^VyGi net (\S+): mDNS$/, "Device discovery", "access"],
  [/^VyGi net (\S+):/, "Networks", "networks"],
  [/^VyGi: blocked clients/, "Blocked devices", "clients"],
  [/^VyGi group: ([^[]*?)(?: \[limit .*\])?$/, "Device groups", "clients"],
  [/^VyGi(?::)? intrusion detection|^VyGi: addresses blocked after an attack/, "Intrusion Prevention", "ids"],
  [/^VyGi region block/, "Region Blocking", "filtering"],
  [/^VyGi VPN client(?: \S+)?(?::)? ?(.*)$/, "VPN client", "vpn"],
  [/^VyGi: (?:send chosen devices through a VPN client|private addresses \(stay off the VPN\))/, "VPN client", "vpn"],
  [/^VyGi(?: VPN|: WireGuard)/, "VPN", "vpn"],
  [/^VyGi: (?:backup internet|block new connections on the backup|DHCPv6 on the backup)/, "Backup internet", "settings", "internet"],
  [/^VyGi: DHCPv6 from the provider/, "Internet connection", "settings", "internet"],
  [/^VyGi: Smart Queues/, "Smart Queues", "settings", "internet"],
  [/^VyGi: (?:block new connections from the internet|allow replies)/, "Router Access", "settings", "management"],
  [/^VyGi[: ]/, "VyGi", null],
];

/**
 * description -> { feature, name, view, tab } for settings VyGi made, else null.
 * view: the page to change it on (null: made by VyGi, but no page owns it).
 */
export function ownerOf(description) {
  const d = String(description || "").trim();
  if (!d.startsWith("VyGi")) return null;
  for (const [re, feature, view, tab] of OWNERS) {
    const m = d.match(re);
    if (m) return { feature, name: (m[1] || "").trim(), view, tab: tab || null };
  }
  return null;
}

/** "Traffic Rules: Kids bedtime" */
export function ownerText(o) {
  return o.name ? `${o.feature}: ${o.name}` : o.feature;
}

/**
 * The description after "making it manual": VyGi's prefix goes, so no page
 * reads (or rewrites) it any more; the name stays.
 */
export function manualDescription(description) {
  const o = ownerOf(description);
  const rest = o?.name || String(description || "").replace(/^VyGi[^:]*:\s*/, "");
  return `${rest || "rule"} (was ${o ? o.feature : "VyGi"})`.slice(0, 255);
}
