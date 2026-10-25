// Builds a UniFi-style client list from what the router knows:
// ARP/NDP neighbors, DHCP leases and static mappings, static DNS names,
// WireGuard peers, and active connections per address.
import { api } from "./api.js";
import { toArray, flattenInterfaces, parseIpv4Cidr, ipv4InCidr } from "./vyos.js";
import { parseWgDump } from "../components/vpn.js";
import { createSampler, accountingOn } from "./flowrates.js";
import { session } from "./session.js";

export const BLOCK_GROUP = "VYGI-BLOCKED";

const isPrivateMac = (mac) => {
  const first = parseInt(String(mac).slice(0, 2), 16);
  return Number.isFinite(first) && (first & 0x02) === 0x02;
};

/** Networks = interfaces with an IPv4 address (LANs, VLANs, VPN). */
export function networksFromConfig(ifaces) {
  const nets = [];
  for (const [name, c] of flattenInterfaces(ifaces)) {
    for (const a of toArray(c.cfg.address)) {
      const p = parseIpv4Cidr(a);
      if (!p) continue;
      nets.push({ iface: name, type: c.type, cidr: p.network, routerIp: p.ip, description: c.cfg.description || "", vpn: c.type === "wireguard" || c.type === "openvpn" });
    }
  }
  return nets;
}

/**
 * Pure merge (testable without a router). Inputs are the raw API results.
 * Returns clients sorted online-first, then by name/IP.
 */
export function mergeClients({ neighbors = [], leases = [], dhcpConfig = {}, hosts = {}, wgDump = "", wgConfig = {}, flows = [], ifaces = {}, blocked = [] }) {
  const nets = networksFromConfig(ifaces);
  const netOf = (ip) => nets.find((n) => ipv4InCidr(ip, n.cidr));
  const byKey = new Map(); // mac (or ip for VPN) -> client
  const blockedSet = new Set(blocked.map((m) => m.toLowerCase()));

  const conns = new Map();
  for (const f of flows) conns.set(f.src, (conns.get(f.src) || 0) + 1);

  // Static names
  const dnsName = new Map();
  for (const [name, h] of Object.entries(hosts || {})) for (const ip of toArray(h?.inet)) dnsName.set(ip, name);
  const fixed = new Map(); // mac -> {name, ip, network, subnet}
  for (const [net, n] of Object.entries(dhcpConfig?.["shared-network-name"] || {})) {
    for (const [subnet, s] of Object.entries(n?.subnet || {})) {
      for (const [name, m] of Object.entries(s?.["static-mapping"] || {})) {
        const mac = String(m?.mac || m?.["mac-address"] || "").toLowerCase();
        if (mac) fixed.set(mac, { name, ip: m?.["ip-address"] || "", network: net, subnet });
      }
    }
  }

  const get = (key, init) => {
    if (!byKey.has(key)) byKey.set(key, { key, name: "", ip: "", ip6: [], mac: "", iface: "", network: "", kind: "wired", online: false, state: "", source: [], connections: 0, fixedIp: false, privateMac: false, blocked: false, lastSeen: null, ...init });
    return byKey.get(key);
  };

  for (const n of neighbors) {
    if (!n.lladdr) continue;
    const st = toArray(n.state).join(",");
    if (/FAILED|INCOMPLETE/.test(st)) continue;
    const c = get(n.lladdr.toLowerCase(), { mac: n.lladdr.toLowerCase() });
    if (n.dst.includes(":")) {
      if (!n.dst.startsWith("fe80")) c.ip6.push(n.dst);
    } else c.ip = c.ip || n.dst;
    c.iface = c.iface || n.dev;
    c.online = c.online || /REACHABLE|DELAY|PROBE|STALE|PERMANENT/.test(st);
    c.state = c.state || st;
    if (!c.source.includes("arp")) c.source.push("arp");
  }
  for (const l of leases) {
    const mac = String(l.mac || "").toLowerCase();
    if (!mac) continue;
    const c = get(mac, { mac });
    c.ip = c.ip || l.ip;
    if (l.hostname && !c.name) c.name = l.hostname;
    c.network = c.network || l.pool || "";
    if (l.state === "active" && !c.online && c.source.includes("arp")) c.online = true;
    c.leaseEnd = l.end;
    if (!c.source.includes("dhcp")) c.source.push("dhcp");
  }
  for (const [mac, f] of fixed) {
    const c = get(mac, { mac });
    c.name = f.name || c.name;
    c.ip = c.ip || f.ip;
    c.fixedIp = true;
    c.fixed = f;
    if (!c.source.includes("fixed")) c.source.push("fixed");
  }

  // WireGuard peers are clients too (keyed by public key).
  const peerNames = new Map();
  for (const [iface, w] of Object.entries(wgConfig || {})) for (const [name, p] of Object.entries(w?.peer || {})) peerNames.set(p?.["public-key"], { name, iface });
  const now = Date.now() / 1000;
  for (const p of parseWgDump(wgDump || "")) {
    const meta = peerNames.get(p.publicKey);
    const c = get(`wg:${p.publicKey}`, { kind: "vpn" });
    c.name = meta?.name || "";
    c.ip = (p.allowedIps.split(",")[0] || "").trim().split("/")[0];
    c.iface = p.iface;
    c.online = !!p.handshake && now - p.handshake < 180;
    c.lastSeen = p.handshake || null;
    c.endpoint = p.endpoint;
    c.rx = p.rx;
    c.tx = p.tx;
    c.source.push("wireguard");
  }

  for (const c of byKey.values()) {
    if (!c.name && c.ip && dnsName.has(c.ip)) c.name = dnsName.get(c.ip);
    c.privateMac = !!c.mac && isPrivateMac(c.mac);
    c.connections = c.ip ? conns.get(c.ip) || 0 : 0;
    c.blocked = !!c.mac && blockedSet.has(c.mac);
    const net = c.ip ? netOf(c.ip) : null;
    if (net) {
      c.network = c.network || net.description || net.iface;
      c.iface = c.iface || net.iface;
      if (net.vpn) c.kind = "vpn";
    }
    c.label = c.name || c.ip || c.mac;
  }
  const num = (ip) => (ip && !ip.includes(":") ? ip.split(".").reduce((a, b) => a * 256 + Number(b), 0) : Infinity);
  return [...byKey.values()].sort((a, b) => (b.online - a.online) || num(a.ip) - num(b.ip));
}

// One traffic sampler per router; rates come from consecutive collectClients() calls.
const sampler = createSampler();
let samplerKey = null;
/** The latest traffic sample: { ready, clients, remotes, accounting } (see flowrates.js). */
export let lastTraffic = { ready: false, clients: new Map(), remotes: new Map(), accounting: false };

/** isLan(ip) for the router's networks, excluding the router's own addresses. */
export function lanTester(networks) {
  const own = new Set(networks.map((n) => n.routerIp));
  return (ip) => !!ip && !own.has(ip) && networks.some((n) => ipv4InCidr(ip, n.cidr));
}

/** Fetches everything and merges. Failures of optional sources are ignored. */
export async function collectClients() {
  const safe = (p, fallback) => p.catch(() => fallback);
  const [neighbors, leases, dhcpConfig, hosts, wgDump, ifaces, flows, groups] = await Promise.all([
    safe(api.neighbors(), []),
    safe(api.dhcpLeases(4), []),
    safe(api.getConfig(["service", "dhcp-server"]), {}),
    safe(api.getConfig(["system", "static-host-mapping", "host-name"]), {}),
    safe(api.wireguardDump(), ""),
    safe(api.getConfig(["interfaces"]), {}),
    safe(api.connections(), []),
    safe(api.getConfig(["firewall", "group", "mac-group", BLOCK_GROUP]), {}),
  ]);
  const clients = mergeClients({
    neighbors, leases: Array.isArray(leases) ? leases : [], dhcpConfig, hosts, wgDump, wgConfig: ifaces?.wireguard || {}, flows, ifaces, blocked: toArray(groups?.["mac-address"]),
  });
  const networks = networksFromConfig(ifaces);
  if (samplerKey !== session.info?.profileId) {
    sampler.reset();
    samplerKey = session.info?.profileId;
  }
  const accounting = accountingOn(flows);
  lastTraffic = { ...sampler.sample(flows, Date.now(), lanTester(networks)), accounting };
  for (const c of clients) {
    const t = c.ip ? lastTraffic.clients.get(c.ip) : null;
    if (t && accounting) Object.assign(c, { down: t.down, up: t.up, totalDown: t.totalDown, totalUp: t.totalUp, rateReady: lastTraffic.ready });
  }
  return { clients, networks, ifaces, flows, traffic: lastTraffic };
}
