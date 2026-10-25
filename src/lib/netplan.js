// Networks (UniFi-style): a LAN = an interface (port or VLAN) with a gateway
// address, optional DHCP and DNS, internet access and isolation. Builds the
// VyOS commands; firewall/NAT rules VyGi adds carry "VyGi net <iface>: ..."
// descriptions so they can be found again. Pure: no API calls.
import { toArray, flattenInterfaces, parseIpv4Cidr, ipv4InCidr } from "./vyos.js";

export const LOCAL_GROUP = "VYGI-LOCAL";
const LOCAL_NETS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
const DHCP = ["service", "dhcp-server", "shared-network-name"];
const DNSF = ["service", "dns", "forwarding"];

const desc = (iface, what) => `VyGi net ${iface}: ${what}`;
const isOurs = (r, iface) => String(r?.description || "").startsWith(`VyGi net ${iface}:`);
const ipNum = (ip) => ip.split(".").reduce((a, b) => a * 256 + Number(b), 0);
const numIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
const isPrivate = (ip) => LOCAL_NETS.some((c) => ipv4InCidr(ip, c));

/** "eth1.20" -> { parent: "eth1", vlan: "20" }. */
export function splitVlan(iface) {
  const m = String(iface).match(/^([^.]+)\.(\d+)$/);
  return m ? { parent: m[1], vlan: m[2] } : { parent: iface, vlan: "" };
}

function cidrsOverlap(a, b) {
  const x = parseIpv4Cidr(a);
  const y = parseIpv4Cidr(b);
  if (!x || !y) return false;
  return ipNum(x.first) <= ipNum(y.last) && ipNum(y.first) <= ipNum(x.last);
}

/** Every IPv4 network on the router: [{ iface, cidr, network }]. */
function allNets(cfg) {
  const out = [];
  for (const [iface, c] of flattenInterfaces(cfg?.interfaces)) {
    for (const a of toArray(c.cfg.address)) {
      const p = parseIpv4Cidr(a);
      if (p) out.push({ iface, cidr: a, network: p.network, type: c.type, path: c.path, cfg: c.cfg });
    }
  }
  return out;
}

/** DHCP subnet serving a network, if any. */
function dhcpFor(cfg, network) {
  for (const [name, n] of Object.entries(cfg?.service?.["dhcp-server"]?.["shared-network-name"] || {})) {
    for (const [subnet, s] of Object.entries(n?.subnet || {})) {
      if (subnet === network) {
        const range = Object.values(s?.range || {})[0] || {};
        return { name, subnet, id: s?.["subnet-id"], start: range.start || "", stop: range.stop || "", dns: toArray(s?.option?.["name-server"]), cfg: s };
      }
    }
  }
  return null;
}

function chainRules(cfg, chain) {
  return cfg?.firewall?.ipv4?.[chain]?.filter?.rule || {};
}

/**
 * Networks for the Networks page. wan = the internet interface.
 * Each: { iface, name, cidr, network, routerIp, vlan, parent, type, dhcp, dnsMode, internet, isolated, path }.
 */
export function readNetworks(cfg, wan) {
  return allNets(cfg)
    .filter((n) => n.iface !== wan && n.iface !== "lo" && isPrivate(parseIpv4Cidr(n.cidr).ip) && !/wireguard|openvpn|loopback/.test(n.type))
    .map((n) => {
      const p = parseIpv4Cidr(n.cidr);
      const fwd = Object.values(chainRules(cfg, "forward")).filter((r) => isOurs(r, n.iface));
      const dhcp = dhcpFor(cfg, n.network);
      const { parent, vlan } = splitVlan(n.iface);
      return {
        iface: n.iface,
        name: n.cfg.description || n.iface,
        cidr: n.cidr,
        network: n.network,
        routerIp: p.ip,
        vlan,
        parent,
        type: n.type,
        path: n.path,
        dhcp,
        dnsMode: dhcp && dhcp.dns.length === 1 && dhcp.dns[0] === p.ip ? "router" : dhcp?.dns.length ? "custom" : "router",
        dnsServers: dhcp?.dns || [],
        internet: !fwd.some((r) => /no internet/.test(r.description)),
        isolated: fwd.some((r) => /isolate/.test(r.description)),
      };
    })
    .sort((a, b) => a.iface.localeCompare(b.iface, undefined, { numeric: true }));
}

/** First free 192.168.X.0/24 (X = VLAN id when possible): "192.168.20.1/24". */
export function suggestSubnet(cfg, vlan) {
  const used = allNets(cfg).map((n) => n.network);
  const tries = [];
  const v = Number(vlan);
  if (v >= 2 && v <= 254) tries.push(v);
  for (let x = 10; x <= 250; x += 10) tries.push(x);
  for (let x = 2; x <= 254; x++) tries.push(x);
  for (const x of tries) {
    const cand = `192.168.${x}.0/24`;
    if (!used.some((u) => cidrsOverlap(u, cand))) return `192.168.${x}.1/24`;
  }
  return "";
}

/** First VLAN id (10, 20, 30, …) not used on the parent. */
export function suggestVlan(cfg, parent) {
  const used = new Set(allNets(cfg).filter((n) => splitVlan(n.iface).parent === parent).map((n) => Number(splitVlan(n.iface).vlan)));
  for (const t of Object.values(cfg?.interfaces || {})) for (const [name, c] of Object.entries(t || {})) if (name === parent) for (const id of Object.keys(c?.vif || {})) used.add(Number(id));
  for (let v = 10; v < 4000; v += 10) if (!used.has(v)) return String(v);
  return "";
}

/** DHCP pool for a gateway address: .100-.200 on a /24, else the upper half. */
export function suggestPool(routerCidr) {
  const c = parseIpv4Cidr(routerCidr);
  if (!c) return { start: "", stop: "" };
  const first = ipNum(c.first);
  const last = ipNum(c.last);
  if (last - first >= 250) return { start: numIp(first + 99), stop: numIp(first + 199) };
  const mid = first + Math.ceil((last - first) / 2);
  return { start: numIp(mid), stop: numIp(last) };
}

class Numbers {
  constructor(rules) {
    this.used = new Set(Object.keys(rules || {}).map(Number));
  }
  free(n) {
    this.used.delete(Number(n));
  }
  take(from, to) {
    for (let n = from; n <= to; n++) {
      if (!this.used.has(n)) {
        this.used.add(n);
        return String(n);
      }
    }
    throw new Error(`No free firewall rule numbers between ${from} and ${to}`);
  }
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/;
const dhcpName = (name) => name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toUpperCase() || "NET";

/**
 * Commands to create (existing = null) or update a network.
 * spec: { name, mode: "vlan"|"port", parent, vlan, port, cidr, dhcp, poolStart, poolStop,
 *         dnsMode: "router"|"custom", dnsServers, internet, isolate }
 * env: { wan, mgmtHost } (mgmtHost = the address VyGi is connected to).
 */
export function networkCommands(cfg, spec, env, existing = null) {
  const cmds = [];
  const set = (path, value) => cmds.push(value === undefined ? { op: "set", path } : { op: "set", path, value });
  const del = (path) => cmds.push({ op: "delete", path });
  const name = String(spec.name || "").trim();
  if (!NAME_RE.test(name)) throw new Error("Name: letters, digits, spaces, - and _ (up to 32)");
  if (!env.wan) throw new Error("Can't tell which interface is the internet (no default route)");

  // ---- interface
  let iface;
  let ifPath;
  let gw;
  if (existing) {
    iface = existing.iface;
    ifPath = existing.path;
    gw = parseIpv4Cidr(existing.cidr);
    if ((existing.name || "") !== name) set([...ifPath, "description"], name);
  } else {
    gw = parseIpv4Cidr(String(spec.cidr || "").trim());
    if (!gw || gw.bits < 16 || gw.bits > 30) throw new Error("Gateway: an address with prefix, e.g. 192.168.20.1/24 (/16 to /30)");
    if (ipNum(gw.ip) < ipNum(gw.first) || ipNum(gw.ip) > ipNum(gw.last)) throw new Error("Gateway can't be the network or broadcast address");
    if (!isPrivate(gw.ip)) throw new Error("Use a private range (10.x, 172.16-31.x or 192.168.x)");
    const clash = allNets(cfg).find((n) => cidrsOverlap(n.network, gw.network));
    if (clash) throw new Error(`${gw.network} overlaps ${clash.network} on ${clash.iface}`);
    const types = cfg?.interfaces || {};
    if (spec.mode === "vlan") {
      const vlan = Number(spec.vlan);
      if (!Number.isInteger(vlan) || vlan < 2 || vlan > 4094) throw new Error("VLAN ID: 2 to 4094");
      const type = Object.keys(types).find((t) => types[t]?.[spec.parent]) || (/^eth/.test(spec.parent) ? "ethernet" : /^br/.test(spec.parent) ? "bridge" : /^bond/.test(spec.parent) ? "bonding" : "");
      if (!type) throw new Error("Choose the port the VLAN runs on");
      if (types[type]?.[spec.parent]?.vif?.[vlan]) throw new Error(`VLAN ${vlan} already exists on ${spec.parent}`);
      iface = `${spec.parent}.${vlan}`;
      ifPath = ["interfaces", type, spec.parent, "vif", String(vlan)];
    } else {
      if (!/^eth\d+$/.test(spec.port || "")) throw new Error("Choose a free port");
      if (toArray(types.ethernet?.[spec.port]?.address).length) throw new Error(`${spec.port} already has an address`);
      if (Object.values(types.bridge || {}).some((b) => b?.member?.interface?.[spec.port])) throw new Error(`${spec.port} is part of a bridge`);
      iface = spec.port;
      ifPath = ["interfaces", "ethernet", spec.port];
    }
    set([...ifPath, "address"], `${gw.ip}/${gw.bits}`);
    set([...ifPath, "description"], name);
  }
  const net = gw.network;
  const mgmt = env.mgmtHost && ipv4InCidr(env.mgmtHost, net);
  if (mgmt && spec.isolate) throw new Error("VyGi is connected through this network, so isolating it would lock VyGi out. Connect through another network first.");

  // ---- forget our old rules for this network
  const nums = { forward: new Numbers(chainRules(cfg, "forward")), input: new Numbers(chainRules(cfg, "input")) };
  if (existing) {
    for (const chain of ["forward", "input"]) {
      for (const [n, r] of Object.entries(chainRules(cfg, chain))) {
        if (isOurs(r, iface)) {
          del(["firewall", "ipv4", chain, "filter", "rule", n]);
          nums[chain].free(n);
        }
      }
    }
  }
  const natRules = cfg?.nat?.source?.rule || {};
  const natNums = new Numbers(natRules);
  if (existing) {
    for (const [n, r] of Object.entries(natRules)) {
      if (isOurs(r, iface)) {
        del(["nat", "source", "rule", n]);
        natNums.free(n);
      }
    }
  }

  // ---- DHCP
  const curDhcp = dhcpFor(cfg, net);
  if (curDhcp && (!spec.dhcp || existing)) del([...DHCP, curDhcp.name, "subnet", net]);
  if (spec.dhcp) {
    const start = String(spec.poolStart || "").trim();
    const stop = String(spec.poolStop || "").trim();
    if (!ipv4InCidr(start, net) || !ipv4InCidr(stop, net) || ipNum(start) > ipNum(stop)) throw new Error(`DHCP pool must be inside ${net}, start before end`);
    if (ipNum(start) <= ipNum(gw.ip) && ipNum(gw.ip) <= ipNum(stop)) throw new Error("The DHCP pool must not include the gateway address");
    const ids = [];
    for (const n of Object.values(cfg?.service?.["dhcp-server"]?.["shared-network-name"] || {})) for (const s of Object.values(n?.subnet || {})) ids.push(Number(s?.["subnet-id"]));
    const id = curDhcp?.id || String(Math.max(0, ...ids.filter(Number.isFinite)) + 1);
    const shared = curDhcp?.name || dhcpName(name);
    if (!curDhcp && cfg?.service?.["dhcp-server"]?.["shared-network-name"]?.[shared]) throw new Error(`A DHCP server named ${shared} already exists; pick another name`);
    const b = [...DHCP, shared, "subnet", net];
    set([...b, "subnet-id"], id);
    set([...b, "option", "default-router"], gw.ip);
    const dns = spec.dnsMode === "custom" ? String(spec.dnsServers || "").split(/[\s,]+/).filter(Boolean) : [gw.ip];
    if (!dns.length) throw new Error("Enter at least one DNS server");
    for (const d of dns) if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(d)) throw new Error(`Bad DNS server ${d}`);
    for (const d of dns) set([...b, "option", "name-server"], d);
    set([...b, "lease"], String(curDhcp?.cfg?.lease || 86400));
    set([...b, "range", "0", "start"], start);
    set([...b, "range", "0", "stop"], stop);
    // keep reservations when re-creating
    for (const [m, sm] of Object.entries(curDhcp?.cfg?.["static-mapping"] || {})) {
      for (const [k, v] of Object.entries(sm || {})) set([...b, "static-mapping", m, k], v);
    }
  }

  // ---- router as DNS server (DNS forwarding)
  const fwd = cfg?.service?.dns?.forwarding || {};
  const allow = toArray(fwd["allow-from"]);
  const listen = toArray(fwd["listen-address"]);
  if (spec.dhcp && spec.dnsMode !== "custom") {
    if (!allow.includes(net)) set([...DNSF, "allow-from"], net);
    if (!listen.includes(gw.ip)) set([...DNSF, "listen-address"], gw.ip);
  } else if (existing && spec.dnsMode === "custom") {
    if (allow.includes(net)) del([...DNSF, "allow-from", net]);
    if (listen.includes(gw.ip)) del([...DNSF, "listen-address", gw.ip]);
  }

  // ---- internet (NAT + forward rules)
  const rule = (chain, n, parts, what) => {
    const base = ["firewall", "ipv4", chain, "filter", "rule", n];
    for (const [k, v] of parts) set([...base, ...k], v);
    set([...base, "description"], desc(iface, what));
  };
  const fwdDrop = cfg?.firewall?.ipv4?.forward?.filter?.["default-action"] === "drop";
  const inDrop = cfg?.firewall?.ipv4?.input?.filter?.["default-action"] === "drop";
  if (spec.internet) {
    const covered = Object.values(natRules).some((r) => !isOurs(r, iface) && r?.translation?.address === "masquerade" && (!r?.["outbound-interface"]?.name || r["outbound-interface"].name === env.wan) && (!r?.source?.address || ipv4InCidr(gw.ip, r.source.address)));
    if (!covered) {
      const n = (() => {
        for (let x = 100; x < 10000; x += 10) if (!natNums.used.has(x)) { natNums.used.add(x); return String(x); }
        throw new Error("No free NAT rule number");
      })();
      const r = ["nat", "source", "rule", n];
      set([...r, "outbound-interface", "name"], env.wan);
      set([...r, "source", "address"], net);
      set([...r, "translation", "address"], "masquerade");
      set([...r, "description"], desc(iface, "internet"));
    }
    if (fwdDrop) rule("forward", nums.forward.take(900, 999), [[["action"], "accept"], [["inbound-interface", "name"], iface], [["outbound-interface", "name"], env.wan]], "internet");
  } else {
    rule("forward", nums.forward.take(1, 99), [[["action"], "drop"], [["inbound-interface", "name"], iface], [["outbound-interface", "name"], env.wan]], "no internet");
  }

  // ---- isolation from the other local networks (both directions) and from the router itself
  if (spec.isolate) {
    const group = cfg?.firewall?.group?.["network-group"]?.[LOCAL_GROUP];
    if (!group) for (const c of LOCAL_NETS) set(["firewall", "group", "network-group", LOCAL_GROUP, "network"], c);
    rule("forward", nums.forward.take(1, 99), [[["action"], "drop"], [["inbound-interface", "name"], iface], [["destination", "group", "network-group"], LOCAL_GROUP], [["state"], "new"]], "isolate (out)");
    rule("forward", nums.forward.take(1, 99), [[["action"], "drop"], [["outbound-interface", "name"], iface], [["source", "group", "network-group"], LOCAL_GROUP], [["state"], "new"]], "isolate (in)");
    // Router: only DHCP, DNS and ping from this network.
    rule("input", nums.input.take(1, 99), [[["action"], "accept"], [["inbound-interface", "name"], iface], [["protocol"], "udp"], [["destination", "port"], "67,68"]], "DHCP");
    rule("input", nums.input.take(1, 99), [[["action"], "accept"], [["inbound-interface", "name"], iface], [["protocol"], "tcp_udp"], [["destination", "port"], "53"]], "DNS");
    rule("input", nums.input.take(1, 99), [[["action"], "accept"], [["inbound-interface", "name"], iface], [["protocol"], "icmp"]], "ping");
    rule("input", nums.input.take(1, 99), [[["action"], "accept"], [["inbound-interface", "name"], iface], [["state"], "established"], [["state"], "related"]], "replies");
    rule("input", nums.input.take(1, 99), [[["action"], "drop"], [["inbound-interface", "name"], iface]], "isolate router");
  } else if (inDrop) {
    rule("input", nums.input.take(900, 999), [[["action"], "accept"], [["inbound-interface", "name"], iface]], "router access");
  }
  return cmds;
}

/** Commands to remove a network and everything VyGi or DHCP/DNS attached to it. */
export function deleteNetworkCommands(cfg, net, env) {
  if (env.mgmtHost && ipv4InCidr(env.mgmtHost, net.network)) throw new Error("VyGi is connected through this network; deleting it would cut the connection.");
  const cmds = [];
  const del = (path) => cmds.push({ op: "delete", path });
  for (const chain of ["forward", "input"]) for (const [n, r] of Object.entries(chainRules(cfg, chain))) if (isOurs(r, net.iface)) del(["firewall", "ipv4", chain, "filter", "rule", n]);
  for (const [n, r] of Object.entries(cfg?.nat?.source?.rule || {})) if (isOurs(r, net.iface)) del(["nat", "source", "rule", n]);
  const d = dhcpFor(cfg, net.network);
  if (d) {
    const subnets = Object.keys(cfg.service["dhcp-server"]["shared-network-name"][d.name]?.subnet || {});
    del(subnets.length > 1 ? [...DHCP, d.name, "subnet", net.network] : [...DHCP, d.name]);
  }
  const fwd = cfg?.service?.dns?.forwarding || {};
  if (toArray(fwd["allow-from"]).includes(net.network)) del([...DNSF, "allow-from", net.network]);
  if (toArray(fwd["listen-address"]).includes(net.routerIp)) del([...DNSF, "listen-address", net.routerIp]);
  if (net.vlan) del(net.path);
  else {
    del([...net.path, "address", net.cidr]);
    if (net.name !== net.iface) del([...net.path, "description"]);
  }
  return cmds;
}
