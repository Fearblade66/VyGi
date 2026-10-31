// "Make it a router": the internet connection, a home network (addresses by
// DHCP, the router as DNS server, NAT to the internet) and the basic firewall
// in one change. Pure: it combines the Internet, Networks and Health Check
// builders, each run on the config the previous step leaves.
import { toArray, flattenInterfaces, parseIpv4Cidr, ipv4InCidr } from "./vyos.js";
import { readInternet, internetCommands } from "./wanconf.js";
import { readNetworks, suggestSubnet, suggestPool, networkCommands } from "./netplan.js";
import { securityFindings } from "./secure.js";
import { simulate } from "./doctor.js";

// Health Check fixes that every router facing the internet wants.
const BASICS = ["wan-input", "wan-forward6", "dns-open", "ssh-guess"];

/** Ethernet ports: [{ name, addrs, bridge, free }] (free: no address, not in a bridge). */
export function routerPorts(cfg) {
  const eth = cfg?.interfaces?.ethernet || {};
  const bridges = cfg?.interfaces?.bridge || {};
  return Object.keys(eth)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => {
      const addrs = toArray(eth[name]?.address).map(String);
      const bridge = Object.keys(bridges).find((b) => bridges[b]?.member?.interface?.[name]) || "";
      return { name, addrs, bridge, free: !addrs.length && !bridge };
    });
}

/**
 * Starting values for the form. ctx: { wan (live internet interface), mgmtIface, mgmtHost }.
 * Returns { internet: readInternet(), lanChoices: [{ value, label }], lan, ports, cidr, pool }.
 */
export function routerDefaults(cfg, ctx = {}) {
  const internet = readInternet(cfg, ctx.wan || "");
  const ports = routerPorts(cfg);
  if (!internet.port) internet.port = (ports.find((p) => p.name !== ctx.mgmtIface) || ports[0])?.name || "";
  const nets = readNetworks(cfg, internet.wan || internet.port);
  const mine = nets.find((n) => n.iface === ctx.mgmtIface);
  const cidr = cidrFree(cfg, "192.168.1.1/24") ? "192.168.1.1/24" : suggestSubnet(cfg, "");
  return {
    internet,
    ports,
    nets,
    lan: (mine || nets[0])?.iface || "new",
    newPorts: ports.filter((p) => p.free && p.name !== internet.port).slice(0, 1).map((p) => p.name),
    cidr,
    pool: suggestPool(cidr),
  };
}

/** No address on the router is inside cidr's network (and it isn't inside one). */
function cidrFree(cfg, cidr) {
  const want = parseIpv4Cidr(cidr);
  for (const { cfg: c } of flattenInterfaces(cfg?.interfaces).values()) {
    for (const a of toArray(c?.address).map(String)) {
      const have = parseIpv4Cidr(a);
      if (have && (ipv4InCidr(have.ip, want.network) || ipv4InCidr(want.ip, have.network))) return false;
    }
  }
  return true;
}

/**
 * The whole change. v: { port, vlan, mode, user, password, staticAddr, gateway, dns,
 * lan: iface of an existing network | "new", newPorts[], cidr, poolStart, poolStop }.
 * ctx: { wan, mgmtHost, mgmtIface, ...routerContext() for the security checks }.
 * Returns { cmds, notes[] }. Throws with a plain message on bad input.
 */
export function routerPlan(cfg, v, ctx = {}) {
  const notes = [];
  const cur = readInternet(cfg, ctx.wan || "");
  if (v.lan === "new" ? (v.newPorts || []).includes(v.port) : v.lan === v.port) throw new Error(`${v.port} can't be both the internet port and the home network`);

  // 1. internet ("keep": it already works, leave it alone)
  let net;
  if (v.mode === "keep") {
    if (!ctx.wan || v.port !== cur.port) throw new Error(`"Keep the current connection" only works with the port it's on (${cur.port || "none"})`);
    net = { cmds: [], wan: ctx.wan };
  } else {
    const lanIfaces = readNetworks(cfg, cur.wan).map((n) => n.iface);
    net = internetCommands(cfg, cur, { ...v, ipv6: false, pdLans: [] }, lanIfaces);
  }
  const cmds = [...net.cmds];
  const wan = net.wan;
  let after = simulate(cfg, cmds);
  if (ctx.mgmtIface && ctx.mgmtIface === v.port && net.cmds.some((c) => c.path?.includes("address"))) {
    notes.push(`VyGi reaches the router through ${v.port}, the port you chose for the internet, and its address changes. If VyGi loses the router, Safe Mode puts everything back after the countdown.`);
  }

  // 2. home network
  const nets = readNetworks(after, wan);
  const existing = v.lan === "new" ? null : nets.find((n) => n.iface === v.lan);
  if (v.lan !== "new" && !existing) throw new Error("Choose the home network");
  const pool = existing?.dhcp ? { start: existing.dhcp.start, stop: existing.dhcp.stop } : existing ? suggestPool(existing.cidr) : null;
  const spec = existing
    ? { name: existing.name === existing.iface ? "Home" : existing.name, dhcp: true, poolStart: pool.start, poolStop: pool.stop, dnsMode: existing.dhcp ? existing.dnsMode : "router", dnsServers: existing.dnsServers.join(" "), internet: true, isolate: false, ...(existing.type === "bridge" ? { ports: existing.ports } : {}) }
    : { name: freeName(after), mode: "port", ports: v.newPorts || [], cidr: v.cidr, dhcp: true, poolStart: v.poolStart, poolStop: v.poolStop, dnsMode: "router", internet: true, isolate: false };
  if (!existing && !spec.ports.length) throw new Error("Choose at least one port for the home network");
  const done = existing?.dhcp && existing.internet && natCovers(after, existing, wan);
  if (!done) cmds.push(...networkCommands(after, spec, { wan, mgmtHost: ctx.mgmtHost }, existing));
  after = simulate(after, cmds.slice(net.cmds.length));

  // 3. basic firewall: the Health Check fixes, on the config after 1 and 2
  const viaWan = ctx.mgmtIface && ctx.mgmtIface === v.port;
  const sctx = { ...ctx, wan, wanCidr: viaWan ? `${ctx.mgmtHost}/32` : "" };
  for (const f of securityFindings(after, sctx)) {
    if (!BASICS.includes(f.id)) continue;
    if (f.fix) cmds.push(...f.fix);
    else if (f.id === "wan-input" && viaWan) notes.push(`The router stays reachable from ${v.port} for now, because VyGi connects through it. Once VyGi connects from the home network, run Health Check to block it.`);
  }
  return { cmds, notes };
}

/** A masquerade rule takes net's traffic out to wan. */
function natCovers(cfg, net, wan) {
  return Object.values(cfg?.nat?.source?.rule || {}).some((r) => r?.translation?.address === "masquerade"
    && (!r?.["outbound-interface"]?.name || r["outbound-interface"].name === wan)
    && (!r?.source?.address || ipv4InCidr(net.routerIp, String(r.source.address))));
}

/** "Home", or "Home 2", "Home 3"... when a network or DHCP server has that name. */
function freeName(cfg) {
  const nets = readNetworks(cfg, "").map((n) => n.name.toLowerCase());
  const dhcp = Object.keys(cfg?.service?.["dhcp-server"]?.["shared-network-name"] || {}).map((x) => x.toLowerCase());
  for (let i = 1; ; i++) {
    const name = i === 1 ? "Home" : `Home ${i}`;
    const shared = name.replace(/[^A-Za-z0-9_-]+/g, "-").toLowerCase();
    if (!nets.includes(name.toLowerCase()) && !dhcp.includes(shared)) return name;
  }
}
