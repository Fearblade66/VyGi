// Flows (Insights): names for what the 24/7 server recorded, and the
// commands that make VyGi's blocking rules log what they drop (blocked
// attempts come from those log lines). Pure: no API calls.

const CHAINS = { FWD: "forward", INP: "input", OUT: "output" };
const PORTS = {
  20: "FTP data", 21: "FTP", 22: "SSH", 23: "Telnet", 25: "SMTP", 53: "DNS", 67: "DHCP", 80: "HTTP", 110: "POP3", 123: "NTP",
  137: "NetBIOS", 143: "IMAP", 161: "SNMP", 443: "HTTPS", 445: "SMB (file sharing)", 465: "SMTPS", 500: "IPsec", 587: "SMTP",
  853: "DNS over TLS", 993: "IMAPS", 1194: "OpenVPN", 1883: "MQTT", 1900: "SSDP/UPnP", 3074: "Xbox Live", 3389: "Remote Desktop",
  3478: "STUN", 5060: "SIP (phone)", 5353: "mDNS", 5900: "VNC", 8080: "HTTP (alt)", 8443: "HTTPS (alt)", 8883: "MQTT (TLS)",
  32400: "Plex", 51820: "WireGuard",
};

/** "HTTPS" for 443 (empty when unknown). */
export const portName = (port) => PORTS[port] || "";

/** The description of the rule a log tag names ("ipv4-FWD-filter-3" -> "VyGi: blocked clients"). */
export function ruleLabel(cfg, tag) {
  const m = String(tag || "").match(/^(ipv4|ipv6)-([A-Z]+)-filter-(\d+)$/);
  if (!m) return tag || "";
  const chain = CHAINS[m[2]];
  const r = chain ? cfg?.firewall?.[m[1]]?.[chain]?.filter?.rule?.[m[3]] : null;
  const d = String(r?.description || "");
  if (!d) return `${m[1]} ${chain || m[2]} rule ${m[3]}`;
  return d.replace(/^VyGi rule \d+: /, "Traffic Rule: ").replace(/^VyGi policy \d+: /, "Policy: ")
    .replace(/^VyGi net (\S+): (.*)$/, (_m, iface, what) => `${netName(cfg, iface)}: ${NET_RULES[what] || what}`)
    .replace(/^VyGi: /, "");
}

const NET_RULES = { "isolate (out)": "isolated", "isolate (in)": "isolated", "isolate router": "isolated from the router", "no internet": "no internet" };

/** A network's name (its interface description), else the interface. */
function netName(cfg, iface) {
  const [port, vlan] = iface.split(".");
  for (const type of Object.values(cfg?.interfaces || {})) {
    const node = vlan ? type?.[port]?.vif?.[vlan] : type?.[iface];
    if (node) return node.description || iface;
  }
  return iface;
}

/** VyGi's rules that drop or reject but don't log it yet: [{ path, description }]. */
export function unloggedBlocks(cfg) {
  const out = [];
  for (const fam of ["ipv4", "ipv6"]) {
    for (const chain of ["forward", "input"]) {
      for (const [n, r] of Object.entries(cfg?.firewall?.[fam]?.[chain]?.filter?.rule || {})) {
        if (!/^VyGi\b/.test(String(r?.description || ""))) continue;
        if (!["drop", "reject"].includes(r?.action) || "log" in (r || {}) || "disable" in (r || {})) continue;
        out.push({ path: ["firewall", fam, chain, "filter", "rule", n], description: r.description });
      }
    }
  }
  return out;
}

/** Commands that make those rules log (one kernel log line per blocked packet, rate-limited by VyOS). */
export function logBlocksCommands(cfg) {
  return unloggedBlocks(cfg).map((r) => ({ op: "set", path: [...r.path, "log"] }));
}
