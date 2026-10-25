// VPN client (UniFi "Traffic Routes"): the router connects to a VPN provider
// (Mullvad, Proton, …) with WireGuard, and chosen devices, device groups or
// networks send their internet traffic through it. Everything else keeps
// using the normal line.
//
// On the router:
//   interfaces wireguard wgN        description "VyGi VPN client: <name>"
//   protocols static table T        default route via wgN, plus a blackhole
//                                   (distance 250) when "kill switch" is on
//   nat source rule                 masquerade out of wgN ("VyGi VPN client wgN")
//   policy route VYGI-VPN           rule 1: private addresses stay local;
//                                   then one rule per device / group / network
//                                   ("VyGi VPN wgN: ..."), set table T;
//                                   applied to every home network
// Pure: no API calls.
import { toArray } from "./vyos.js";

export const POLICY = "VYGI-VPN";
const DESC = "VyGi VPN client: ";
const RULE_DESC = (iface) => `VyGi VPN ${iface}`;
const NAT_DESC = (iface) => `VyGi VPN client ${iface}`;
const BLOCK_DESC = (iface) => `VyGi VPN client ${iface}: block incoming`;
const PRIVATE_GROUP = "VYGI-PRIVATE";
const PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"];
const FIRST_TABLE = 150;
const KEY_RE = /^[A-Za-z0-9+/]{42,43}=$/;
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const CIDR4 = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;

/**
 * A WireGuard config file from a VPN provider -> { privateKey, address, dns, publicKey, presharedKey, host, port }.
 * Only IPv4 is used (the router routes IPv4 through the tunnel).
 */
export function parseWgConf(text) {
  const sec = {};
  let cur = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, "").trim();
    if (!line) continue;
    const s = line.match(/^\[(\w+)\]$/);
    if (s) {
      cur = s[1].toLowerCase();
      if (cur === "peer" && sec.peer) throw new Error("The config has more than one [Peer]; use a config for one server");
      sec[cur] = {};
      continue;
    }
    const kv = line.match(/^([A-Za-z]+)\s*=\s*(.+)$/);
    if (kv && cur) sec[cur][kv[1].toLowerCase()] = kv[2].trim();
  }
  const i = sec.interface;
  const p = sec.peer;
  if (!i || !p) throw new Error("Paste a WireGuard config with [Interface] and [Peer] sections (download it from your VPN provider)");
  const address = i.address?.split(",").map((a) => a.trim()).find((a) => CIDR4.test(a) || /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
  if (!address) throw new Error("The config has no IPv4 Address");
  const ep = (p.endpoint || "").match(/^\[?([^\]]+?)\]?:(\d+)$/);
  if (!ep) throw new Error("The config's Endpoint should look like host:port");
  if (!KEY_RE.test(i.privatekey || "")) throw new Error("The config's PrivateKey is missing or not a WireGuard key");
  if (!KEY_RE.test(p.publickey || "")) throw new Error("The config's PublicKey is missing or not a WireGuard key");
  if (p.presharedkey && !KEY_RE.test(p.presharedkey)) throw new Error("The config's PresharedKey is not a WireGuard key");
  return {
    privateKey: i.privatekey,
    address: address.includes("/") ? address : `${address}/32`,
    dns: (i.dns || "").split(",").map((d) => d.trim()).filter((d) => /^\d{1,3}(\.\d{1,3}){3}$/.test(d)),
    publicKey: p.publickey,
    presharedKey: p.presharedkey || "",
    host: ep[1],
    port: ep[2],
  };
}

/** True for a WireGuard interface that is one of VyGi's VPN clients (not your own VPN server). */
export const isVpnClient = (wgCfg) => String(wgCfg?.description || "").startsWith(DESC);

/** The WireGuard interfaces that are your own VPN servers. */
export const vpnServers = (wg) => Object.fromEntries(Object.entries(wg || {}).filter(([, c]) => !isVpnClient(c)));

/** The routes in policy VYGI-VPN for one tunnel: { macs, groups, networks }. */
function routesFor(cfg, iface) {
  const out = { macs: [], groups: [], networks: [] };
  for (const r of Object.values(cfg?.policy?.route?.[POLICY]?.rule || {})) {
    if (r?.description !== RULE_DESC(iface)) continue;
    const src = r.source || {};
    if (src["mac-address"]) out.macs.push(String(src["mac-address"]).toLowerCase());
    if (src.group?.["mac-group"]) out.groups.push(src.group["mac-group"]);
    if (src.address) out.networks.push(src.address);
  }
  return out;
}

/** VPN clients VyGi made: [{ iface, name, table, host, port, address, killSwitch, routes }]. */
export function readClients(cfg) {
  const out = [];
  for (const [iface, c] of Object.entries(cfg?.interfaces?.wireguard || {})) {
    const desc = String(c?.description || "");
    if (!desc.startsWith(DESC)) continue;
    const peer = Object.values(c?.peer || {})[0] || {};
    const table = Object.entries(cfg?.protocols?.static?.table || {}).find(([, t]) => t?.description === DESC + iface)?.[0] || "";
    const t = cfg?.protocols?.static?.table?.[table]?.route?.["0.0.0.0/0"] || {};
    out.push({
      iface,
      name: desc.slice(DESC.length),
      table,
      host: peer["host-name"] || peer.address || "",
      port: peer.port || "",
      address: toArray(c.address)[0] || "",
      killSwitch: "blackhole" in t,
      disabled: "disable" in c,
      routes: routesFor(cfg, iface),
    });
  }
  return out.sort((a, b) => a.iface.localeCompare(b.iface, undefined, { numeric: true }));
}

/** Every WireGuard interface name in use. */
const usedWg = (cfg) => Object.keys(cfg?.interfaces?.wireguard || {});

/**
 * Commands to add a VPN client. spec: { name, conf (text), killSwitch }.
 * Routes are set separately (routeCommands).
 */
export function addClientCommands(cfg, spec) {
  const name = String(spec.name || "").trim().replace(/['"]/g, "");
  if (!name || name.length > 32) throw new Error("Give the connection a name, e.g. Mullvad Sweden");
  const w = parseWgConf(spec.conf);
  const used = new Set(usedWg(cfg));
  let n = 10;
  while (used.has(`wg${n}`)) n++;
  const iface = `wg${n}`;
  const tables = new Set(Object.keys(cfg?.protocols?.static?.table || {}));
  let table = FIRST_TABLE;
  while (tables.has(String(table))) table++;
  const base = ["interfaces", "wireguard", iface];
  const peer = [...base, "peer", "provider"];
  const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(w.host);
  const cmds = [
    { op: "set", path: [...base, "description"], value: DESC + name },
    { op: "set", path: [...base, "address"], value: w.address },
    { op: "set", path: [...base, "private-key"], value: w.privateKey },
    { op: "set", path: [...peer, "public-key"], value: w.publicKey },
    { op: "set", path: [...peer, ip ? "address" : "host-name"], value: w.host },
    { op: "set", path: [...peer, "port"], value: w.port },
    { op: "set", path: [...peer, "allowed-ips"], value: "0.0.0.0/0" },
    { op: "set", path: [...peer, "persistent-keepalive"], value: "25" },
    ...(w.presharedKey ? [{ op: "set", path: [...peer, "preshared-key"], value: w.presharedKey }] : []),
    { op: "set", path: ["protocols", "static", "table", String(table), "description"], value: DESC + iface },
    { op: "set", path: ["protocols", "static", "table", String(table), "route", "0.0.0.0/0", "interface", iface] },
    ...(spec.killSwitch !== false ? [{ op: "set", path: ["protocols", "static", "table", String(table), "route", "0.0.0.0/0", "blackhole", "distance"], value: "250" }] : []),
  ];
  // masquerade out of the tunnel (the provider only routes the address it gave us)
  const natUsed = new Set(Object.keys(cfg?.nat?.source?.rule || {}).map(Number));
  let nat = 5000;
  while (natUsed.has(nat)) nat++;
  const r = ["nat", "source", "rule", String(nat)];
  cmds.push(
    { op: "set", path: [...r, "outbound-interface", "name"], value: iface },
    { op: "set", path: [...r, "translation", "address"], value: "masquerade" },
    { op: "set", path: [...r, "description"], value: NAT_DESC(iface) },
  );
  // nothing from the provider's side may start a connection into the network or the router
  for (const chain of ["forward", "input"]) {
    const rules = cfg?.firewall?.ipv4?.[chain]?.filter?.rule || {};
    let num = 2;
    while (rules[String(num)]) num++;
    if (num > 39) throw new Error(`No free firewall rule number before 40 in the ${chain} chain`);
    const b = ["firewall", "ipv4", chain, "filter", "rule", String(num)];
    cmds.push(
      { op: "set", path: [...b, "action"], value: "drop" },
      { op: "set", path: [...b, "inbound-interface", "name"], value: iface },
      { op: "set", path: [...b, "state"], value: "new" },
      { op: "set", path: [...b, "description"], value: BLOCK_DESC(iface) },
    );
  }
  return { iface, cmds };
}

export function killSwitchCommands(cfg, client, on) {
  const p = ["protocols", "static", "table", client.table, "route", "0.0.0.0/0", "blackhole"];
  return on ? [{ op: "set", path: [...p, "distance"], value: "250" }] : client.killSwitch ? [{ op: "delete", path: p }] : [];
}

/**
 * Commands that set which devices, groups and networks use `iface`'s tunnel.
 * routes: { macs, groups, networks }. lanIfaces: the home networks' interfaces.
 * Rebuilds the whole VYGI-VPN policy so rule numbers stay tidy.
 */
export function routeCommands(cfg, iface, routes, lanIfaces) {
  const clients = readClients(cfg);
  const me = clients.find((c) => c.iface === iface);
  if (!me) throw new Error(`No VPN client ${iface}`);
  const macs = [...new Set((routes.macs || []).map((m) => String(m).toLowerCase()))];
  for (const m of macs) if (!MAC_RE.test(m)) throw new Error(`Bad MAC address ${m}`);
  const groups = [...new Set(routes.groups || [])];
  for (const g of groups) if (!cfg?.firewall?.group?.["mac-group"]?.[g]) throw new Error(`No device group ${g}`);
  const networks = [...new Set(routes.networks || [])];
  for (const c of networks) if (!CIDR4.test(c)) throw new Error(`Bad network ${c}`);
  const want = new Map(clients.map((c) => [c.iface, c.iface === iface ? { macs, groups, networks } : c.routes]));
  return policyCommands(cfg, clients, want, lanIfaces);
}

function policyCommands(cfg, clients, want, lanIfaces) {
  const cmds = [];
  const set = (path, value) => cmds.push(value === undefined ? { op: "set", path } : { op: "set", path, value });
  const P = ["policy", "route", POLICY];
  if (cfg?.policy?.route?.[POLICY]) cmds.push({ op: "delete", path: P });
  const any = [...want.values()].some((r) => r.macs.length || r.groups.length || r.networks.length);
  const G = ["firewall", "group", "network-group", PRIVATE_GROUP];
  if (!any) {
    if (cfg?.firewall?.group?.["network-group"]?.[PRIVATE_GROUP]) cmds.push({ op: "delete", path: G });
    return cmds;
  }
  if (!cfg?.firewall?.group?.["network-group"]?.[PRIVATE_GROUP]) {
    set([...G, "description"], "VyGi: private addresses (stay off the VPN)");
    for (const n of PRIVATE) set([...G, "network"], n);
  }
  set([...P, "description"], "VyGi: send chosen devices through a VPN client");
  set([...P, "rule", "1", "description"], "VyGi VPN: local traffic stays local");
  set([...P, "rule", "1", "destination", "group", "network-group"], PRIVATE_GROUP);
  set([...P, "rule", "1", "set", "table"], "main");
  let n = 10;
  for (const c of clients) {
    const r = want.get(c.iface);
    const add = (src) => {
      const b = [...P, "rule", String(n++)];
      set([...b, "description"], RULE_DESC(c.iface));
      for (const [k, v] of src) set([...b, "source", ...k], v);
      set([...b, "set", "table"], c.table);
    };
    for (const m of r.macs) add([[["mac-address"], m]]);
    for (const g of r.groups) add([[["group", "mac-group"], g]]);
    for (const net of r.networks) add([[["address"], net]]);
  }
  for (const i of lanIfaces) set([...P, "interface"], i);
  return cmds;
}

/** Commands to remove a VPN client and its routes. */
export function removeClientCommands(cfg, client, lanIfaces) {
  const clients = readClients(cfg).filter((c) => c.iface !== client.iface);
  const want = new Map(clients.map((c) => [c.iface, c.routes]));
  const cmds = policyCommands(cfg, clients, want, lanIfaces);
  cmds.push({ op: "delete", path: ["interfaces", "wireguard", client.iface] });
  if (client.table) cmds.push({ op: "delete", path: ["protocols", "static", "table", client.table] });
  for (const [n, r] of Object.entries(cfg?.nat?.source?.rule || {})) if (r?.description === NAT_DESC(client.iface)) cmds.push({ op: "delete", path: ["nat", "source", "rule", n] });
  for (const chain of ["forward", "input"]) {
    for (const [n, r] of Object.entries(cfg?.firewall?.ipv4?.[chain]?.filter?.rule || {})) if (r?.description === BLOCK_DESC(client.iface)) cmds.push({ op: "delete", path: ["firewall", "ipv4", chain, "filter", "rule", n] });
  }
  return cmds;
}

/** `wg show <iface> dump` peer line -> { handshake (s), rx, tx } or null. */
export function tunnelState(dump, iface) {
  for (const line of String(dump || "").split("\n")) {
    const f = line.split("\t");
    if (f[0] === iface && f.length >= 9) return { handshake: Number(f[5]) || 0, rx: Number(f[6]) || 0, tx: Number(f[7]) || 0 };
  }
  return null;
}
