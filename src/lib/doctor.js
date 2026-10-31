// Config doctor: finds problems and conflicts in a router's configuration
// and, where it's safe, the commands that fix them. Also checks a change
// before it's applied: what new problems it would cause, and the extra
// changes that would avoid them.
//
// Ownership: VyGi only fixes things automatically when the fix adds new
// VyGi-labelled settings or changes ones VyGi made ("VyGi ..." descriptions).
// A fix that would change hand-made (Advanced) settings is marked `manual`
// and is never offered automatically. Pure: no API calls.
import { toArray, flattenInterfaces, parseIpv4Cidr, ipv4InCidr } from "./vyos.js";
import { securityFindings } from "./secure.js";
import { readPolicies, policyCommands, misplacedPolicies } from "./policies.js";
import { readMdns, mdnsCommands, mdnsGaps } from "./mdns.js";

const PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
const isPrivate = (ip) => PRIVATE.some((c) => ipv4InCidr(ip, c));
const ipNum = (ip) => ip.split(".").reduce((a, b) => a * 256 + Number(b), 0);
const isVyGi = (r) => /^VyGi\b/.test(String(r?.description || ""));
// leaves that hold several values (set adds a value instead of replacing)
const MULTI = new Set(["address", "network", "mac-address", "name-server", "allow-from", "listen-address", "member", "interface"]);

/** The config after `commands` (set/delete), approximately as VyOS would make it. */
export function simulate(cfg, commands) {
  const out = structuredClone(cfg || {});
  for (const c of commands || []) {
    const path = c.path || [];
    if (!path.length) continue;
    // `delete ... mac-address X`: removes one value of a multi-value leaf
    if (c.op === "delete" && path.length >= 2) {
      const holder = path.slice(0, -2).reduce((n, k) => (n == null ? null : n[k] ?? null), out);
      const key = path[path.length - 2];
      const cur = holder?.[key];
      if (cur != null && typeof cur !== "object" || Array.isArray(cur)) {
        const left = toArray(cur).filter((v) => v !== path[path.length - 1]);
        if (!left.length) delete holder[key];
        else holder[key] = left.length === 1 ? left[0] : left;
        continue;
      }
    }
    const parent = path.slice(0, -1).reduce((n, k) => {
      if (n == null) return null;
      if (c.op === "set" && (n[k] == null || typeof n[k] !== "object" || Array.isArray(n[k]))) n[k] = {};
      return n[k] ?? null;
    }, out);
    if (!parent) continue;
    const leaf = path[path.length - 1];
    if (c.op === "set") {
      if (c.value === undefined) {
        if (parent[leaf] == null || typeof parent[leaf] !== "object") parent[leaf] = {};
      } else if (MULTI.has(leaf) && parent[leaf] != null && typeof parent[leaf] !== "object" && parent[leaf] !== c.value) {
        parent[leaf] = [parent[leaf], c.value];
      } else if (Array.isArray(parent[leaf])) {
        if (!parent[leaf].includes(c.value)) parent[leaf].push(c.value);
      } else {
        parent[leaf] = c.value;
      }
    } else if (c.op === "delete") {
      delete parent[leaf];
    }
  }
  return out;
}

/** Every IPv4 network on an interface: [{ iface, cidr, network, ip, type }]. */
function nets(cfg) {
  const out = [];
  for (const [iface, c] of flattenInterfaces(cfg?.interfaces)) {
    for (const a of toArray(c.cfg.address)) {
      const p = parseIpv4Cidr(a);
      if (p) out.push({ iface, cidr: a, network: p.network, ip: p.ip, first: p.first, last: p.last, type: c.type });
    }
  }
  return out;
}

function dhcpSubnets(cfg) {
  const out = [];
  for (const [shared, n] of Object.entries(cfg?.service?.["dhcp-server"]?.["shared-network-name"] || {})) {
    for (const [subnet, s] of Object.entries(n?.subnet || {})) {
      out.push({ shared, subnet, s, ranges: Object.values(s?.range || {}), maps: Object.entries(s?.["static-mapping"] || {}) });
    }
  }
  return out;
}

function chain(cfg, fam, name) {
  return cfg?.firewall?.[fam]?.[name]?.filter || null;
}

function freeRule(rules, from, to) {
  const used = new Set(Object.keys(rules || {}).map(Number));
  for (let n = from; n <= to; n++) if (!used.has(n)) return String(n);
  return null;
}

/**
 * All problems: [{ id, level: "bad"|"warn"|"info", title, text, fix: [commands] | null, manual }].
 * `id` is stable for the same problem, so a check can tell new problems from old ones.
 * env: { wan, wanCidr, mgmtHost, defaultPassword, user, vygiAddr }
 */
export function diagnose(cfg, env = {}) {
  const out = [];
  const add = (f) => out.push({ level: "warn", fix: null, manual: false, ...f });
  const all = nets(cfg);
  const lans = all.filter((n) => n.iface !== env.wan && isPrivate(n.ip) && !/wireguard|openvpn|loopback/.test(n.type));

  // ---- addresses: two interfaces in overlapping networks
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      if (a.iface === b.iface) continue;
      if (ipNum(a.first) <= ipNum(b.last) && ipNum(b.first) <= ipNum(a.last)) {
        add({ id: `overlap:${a.iface}:${b.iface}`, level: "bad", title: "Two networks overlap", text: `${a.iface} (${a.network}) and ${b.iface} (${b.network}) use overlapping addresses, so the router can't tell where to send traffic for them. Give one of them a different range.` });
      }
    }
  }

  // ---- DHCP
  const reserved = new Map(); // ip -> mapping name
  for (const d of dhcpSubnets(cfg)) {
    const sub = parseIpv4Cidr(d.subnet);
    if (!sub) continue;
    const net = all.find((n) => n.network === sub.network);
    if (!net) {
      add({ id: `dhcp-noif:${d.subnet}`, title: "DHCP for a network that isn't on any port", text: `There's a DHCP server for ${d.subnet} (${d.shared}), but no interface has an address in it, so nobody gets addresses from it.` });
    }
    for (const r of d.ranges) {
      if (r?.start && r?.stop && (!ipv4InCidr(r.start, d.subnet) || !ipv4InCidr(r.stop, d.subnet))) {
        add({ id: `dhcp-range:${d.subnet}`, level: "bad", title: "DHCP pool outside its network", text: `The DHCP pool ${r.start}–${r.stop} isn't inside ${d.subnet}.` });
      }
      if (net && r?.start && r?.stop && ipNum(r.start) <= ipNum(net.ip) && ipNum(net.ip) <= ipNum(r.stop)) {
        add({ id: `dhcp-gw:${d.subnet}`, level: "bad", title: "The router's own address is in the DHCP pool", text: `${net.ip} (the router on ${net.iface}) is inside the DHCP pool ${r.start}–${r.stop}, so a device could be given the router's address.` });
      }
    }
    for (const [name, m] of d.maps) {
      const ip = m?.["ip-address"];
      if (!ip) continue;
      if (!ipv4InCidr(ip, d.subnet)) {
        add({ id: `dhcp-map-out:${name}`, title: "Fixed address outside its network", text: `The fixed address for "${name}" (${ip}) isn't inside ${d.subnet}, so it's never handed out.` });
      }
      if (reserved.has(ip)) {
        add({ id: `dhcp-map-dup:${ip}`, level: "bad", title: "Two devices have the same fixed address", text: `"${reserved.get(ip)}" and "${name}" both have ${ip}. Only one of them can use it.` });
      }
      reserved.set(ip, name);
      if (d.ranges.some((r) => r?.start && r?.stop && ipNum(r.start) <= ipNum(ip) && ipNum(ip) <= ipNum(r.stop))) {
        add({ id: `dhcp-map-pool:${name}`, level: "info", title: "Fixed address inside the DHCP pool", text: `"${name}" has ${ip}, which is also in the pool for other devices. VyOS normally avoids handing it out twice, but keeping fixed addresses outside the pool is safer.` });
      }
    }
  }

  // ---- internet (NAT) and DNS for each local network
  const natRules = Object.values(cfg?.nat?.source?.rule || {}).filter((r) => r && !("disable" in r));
  const fwd4 = chain(cfg, "ipv4", "forward");
  for (const n of lans) {
    const blocked = Object.values(fwd4?.rule || {}).some((r) => String(r?.description || "") === `VyGi net ${n.iface}: no internet`);
    const covered = natRules.some((r) => r?.translation?.address && (!r?.source?.address || ipv4InCidr(n.ip, r.source.address)) && (!r?.["outbound-interface"]?.name || r["outbound-interface"].name === env.wan));
    if (env.wan && !blocked && !covered) {
      const used = new Set(Object.keys(cfg?.nat?.source?.rule || {}).map(Number));
      let num = 100;
      while (used.has(num)) num += 10;
      const r = ["nat", "source", "rule", String(num)];
      add({
        id: `nat:${n.iface}`, level: "bad", title: `${n.iface} has no internet`,
        text: `Devices on ${n.iface} (${n.network}) can't reach the internet: no NAT rule shares the router's internet address with them. (If that's on purpose, turn its internet off on the Networks page instead.)`,
        fix: [
          { op: "set", path: [...r, "outbound-interface", "name"], value: env.wan },
          { op: "set", path: [...r, "source", "address"], value: n.network },
          { op: "set", path: [...r, "translation", "address"], value: "masquerade" },
          { op: "set", path: [...r, "description"], value: `VyGi net ${n.iface}: internet` },
        ],
      });
    }
    const d = dhcpSubnets(cfg).find((x) => x.subnet === n.network);
    const dnsServers = toArray(d?.s?.option?.["name-server"]);
    if (d && dnsServers.includes(n.ip)) {
      const fwd = cfg?.service?.dns?.forwarding;
      const allow = toArray(fwd?.["allow-from"]);
      const listen = toArray(fwd?.["listen-address"]);
      const allowed = allow.some((a) => ipv4InCidr(n.ip, a));
      if (!allowed || !listen.includes(n.ip)) {
        const fix = [];
        if (!allowed) fix.push({ op: "set", path: ["service", "dns", "forwarding", "allow-from"], value: n.network });
        if (!listen.includes(n.ip)) fix.push({ op: "set", path: ["service", "dns", "forwarding", "listen-address"], value: n.ip });
        if (!fwd) fix.push({ op: "set", path: ["service", "dns", "forwarding", "system"] });
        add({ id: `dns:${n.iface}`, level: "bad", title: `Devices on ${n.iface} can't look up names`, text: `DHCP tells devices on ${n.network} to use the router (${n.ip}) for DNS, but the router's DNS service isn't answering there. Websites won't load by name.`, fix });
      }
    }
  }

  // ---- firewall chains that drop by default but don't let replies back in
  for (const fam of ["ipv4", "ipv6"]) {
    for (const name of ["forward", "input"]) {
      const c = chain(cfg, fam, name);
      if (c?.["default-action"] !== "drop" && c?.["default-action"] !== "reject") continue;
      const replies = Object.values(c.rule || {}).some((r) => r?.action === "accept" && !("disable" in r) && (toArray(r?.state).includes("established") || r?.state?.established !== undefined));
      if (!replies) {
        const lowest = Math.min(...Object.keys(c.rule || {}).map(Number), 1000);
        const num = lowest > 1 ? String(lowest - 1 > 5 ? 5 : lowest - 1) : freeRule(c.rule, 1, 9999);
        const b = ["firewall", fam, name, "filter", "rule", num];
        add({
          id: `replies:${fam}:${name}`, level: "bad", title: `Replies are blocked (${fam} ${name})`,
          text: name === "forward"
            ? `The ${fam} forward chain drops everything not allowed, but has no rule allowing replies to connections your devices start. Most of the internet won't work.`
            : `The router's ${fam} input chain drops everything not allowed, but doesn't allow replies to its own connections (DNS, updates, NTP).`,
          fix: [
            { op: "set", path: [...b, "action"], value: "accept" },
            { op: "set", path: [...b, "state"], value: "established" },
            { op: "set", path: [...b, "state"], value: "related" },
            { op: "set", path: [...b, "description"], value: "VyGi: allow replies" },
          ],
        });
      }
    }
  }

  // ---- port forwards
  const dnat = Object.entries(cfg?.nat?.destination?.rule || {}).filter(([, r]) => r && !("disable" in r));
  const seen = new Map();
  for (const [n, r] of dnat) {
    const ip = r?.translation?.address;
    const port = String(r?.destination?.port || "");
    const name = r?.description || `rule ${n}`;
    const key = `${r?.["inbound-interface"]?.name || "*"}/${r?.protocol || "all"}/${port}`;
    if (port && seen.has(key) && !r?.source?.address) {
      add({ id: `dnat-dup:${key}`, level: "bad", title: "The same port is forwarded twice", text: `"${seen.get(key)}" and "${name}" both forward ${r?.protocol || ""} port ${port}; only the first one works.` });
    }
    seen.set(key, name);
    if (catchAll(r)) {
      add({ id: `dnat-all:${n}`, level: "bad", title: "A port forward takes every connection", text: `"${name}" has no port, interface or address, so every connection to the router, from any network, goes to ${ip || "its target"} instead: the router's own web API, SSH and DNS stop answering. Give it a port and the internet interface (Port Forwarding), or remove it.` });
    }
    if (!ip || !/^\d/.test(ip)) continue;
    const net = lans.find((x) => ipv4InCidr(ip, x.network));
    if (net && Object.values(fwd4?.rule || {}).some((x) => String(x?.description || "") === `VyGi net ${net.iface}: no internet`)) {
      add({ id: `dnat-nointernet:${n}`, level: "bad", title: "A port forward can't work", text: `"${name}" forwards to ${ip} on ${net.iface}, but that network has its internet turned off, so the device's replies are blocked. Turn internet on for ${net.iface}, or remove the forward.` });
    }
    const d = dhcpSubnets(cfg).find((x) => ipv4InCidr(ip, x.subnet));
    const inPool = d?.ranges.some((x) => x?.start && x?.stop && ipNum(x.start) <= ipNum(ip) && ipNum(ip) <= ipNum(x.stop));
    if (inPool && !reserved.has(ip)) {
      add({ id: `dnat-dyn:${n}`, level: "warn", title: "A port forward points at an address that can change", text: `"${name}" forwards to ${ip}, which DHCP hands out dynamically. If the device gets another address the forward stops working: give it a fixed IP (Clients → Fix IP).` });
    }
  }

  // ---- VPN
  const input4 = chain(cfg, "ipv4", "input");
  for (const [iface, w] of Object.entries(cfg?.interfaces?.wireguard || {})) {
    const port = String(w?.port || "");
    if (port && (input4?.["default-action"] === "drop" || input4?.["default-action"] === "reject")) {
      const open = Object.values(input4.rule || {}).some((r) => r?.action === "accept" && !("disable" in r) && toArray(r?.destination?.port).some((p) => String(p).split(",").includes(port)) && (!r.protocol || /udp/.test(r.protocol)));
      if (!open) {
        const num = freeRule(input4.rule, 10, 899);
        const b = ["firewall", "ipv4", "input", "filter", "rule", num];
        add({
          id: `wg-port:${iface}`, level: "bad", title: `The VPN (${iface}) can't be reached`,
          text: `The router drops incoming connections, and nothing allows UDP port ${port} for the WireGuard VPN, so devices can't connect.`,
          fix: [
            { op: "set", path: [...b, "action"], value: "accept" },
            { op: "set", path: [...b, "protocol"], value: "udp" },
            { op: "set", path: [...b, "destination", "port"], value: port },
            { op: "set", path: [...b, "description"], value: `VyGi: WireGuard ${iface}` },
          ],
        });
      }
    }
    const ips = new Map();
    for (const [peer, p] of Object.entries(w?.peer || {})) {
      for (const a of toArray(p?.["allowed-ips"])) {
        if (ips.has(a)) add({ id: `wg-dup:${iface}:${a}`, level: "bad", title: "Two VPN devices share an address", text: `"${ips.get(a)}" and "${peer}" on ${iface} both use ${a}; only one of them can connect at a time.` });
        ips.set(a, peer);
      }
    }
  }

  // ---- leftovers VyGi made that nothing uses any more
  const text = JSON.stringify({ firewall: { ipv4: cfg?.firewall?.ipv4, ipv6: cfg?.firewall?.ipv6 }, nat: cfg?.nat, policy: cfg?.policy });
  for (const [kind, groups] of Object.entries(cfg?.firewall?.group || {})) {
    for (const [g, gc] of Object.entries(groups || {})) {
      // device groups (devgroups.js) stand on their own, used or not
      if (String(gc?.description || "").startsWith("VyGi group: ")) continue;
      if (/^VYGI-/.test(g) && !text.includes(`"${g}"`)) {
        add({ id: `leftover-group:${kind}:${g}`, level: "info", title: "Leftover from a deleted rule", text: `The ${kind} "${g}" was made by VyGi and nothing uses it any more.`, fix: [{ op: "delete", path: ["firewall", "group", kind, g] }] });
      }
    }
  }
  const ifaceNames = new Set([...flattenInterfaces(cfg?.interfaces)].map(([n]) => n));
  for (const fam of ["ipv4", "ipv6"]) {
    for (const name of ["forward", "input"]) {
      for (const [n, r] of Object.entries(chain(cfg, fam, name)?.rule || {})) {
        const m = String(r?.description || "").match(/^VyGi net (\S+):/);
        if (m && !ifaceNames.has(m[1])) {
          add({ id: `leftover-rule:${fam}:${name}:${n}`, level: "info", title: "Leftover rule for a removed network", text: `Firewall rule ${n} (${fam} ${name}) was made by VyGi for ${m[1]}, which no longer exists.`, fix: [{ op: "delete", path: ["firewall", fam, name, "filter", "rule", n] }] });
        }
      }
    }
  }

  // ---- network policies must run before isolation and Traffic Rules
  const late = misplacedPolicies(cfg);
  if (late.length) {
    add({ id: "policy-order", level: "bad", title: "A network policy comes too late", text: `The policy ${late.map((n) => `"${n}"`).join(", ")} runs after an isolation or Traffic Rule, so its exception has no effect. The fix moves VyGi's network policies back in front.`, fix: policyCommands(cfg, readPolicies(cfg)) });
  }

  // ---- device discovery (mDNS) into an isolated network needs its exception
  const gaps = mdnsGaps(cfg);
  if (gaps.length) {
    add({ id: "mdns-gap", title: "Device discovery can't reach an isolated network", text: `mDNS is repeated to ${gaps.join(", ")}, but that network is isolated and has no exception for it (it's removed when the network is edited), so its devices (Chromecast, AirPlay, printers) can't be found from the other networks.`, fix: mdnsCommands(cfg, readMdns(cfg).ifaces) });
  }

  // ---- features that don't mix
  const offload = Object.keys(cfg?.firewall?.flowtable || {}).length > 0;
  if (offload && cfg?.qos?.interface) {
    add({ id: "offload-qos", title: "Speed limits and offloading don't mix", text: "Flow offloading is on: established connections skip the normal path, so speed limits and traffic priorities (QoS) mostly don't apply to them." });
  }
  if (offload && Object.values(fwd4?.rule || {}).some((r) => /^VyGi rule \d+:/.test(String(r?.description || "")) && r?.time)) {
    add({ id: "offload-schedule", title: "Schedules and offloading don't mix", text: "Flow offloading is on, so scheduled Traffic Rules only stop new connections: a stream or game already running when the schedule starts keeps going." });
  }

  // ---- security (the Dashboard's checks)
  for (const f of securityFindings(cfg, env)) {
    out.push({ id: `security:${f.id}`, level: f.level, title: f.title, text: f.text, fix: f.fix || null, manual: false, needs: f.needs, user: f.user, fixLabel: f.fixLabel, security: true });
  }

  // a fix that changes something VyGi didn't make is advice, not automatic
  for (const f of out) if (f.fix && !f.security) f.manual = f.fix.some((c) => touchesManual(cfg, c));
  return out;
}

/** True if the command changes an existing setting VyGi didn't make. */
export function touchesManual(cfg, c) {
  const p = c.path || [];
  // firewall / NAT rules: owned when their description says VyGi
  const ruleAt = p.indexOf("rule");
  if (ruleAt > 0 && p[ruleAt + 1] != null && (p[0] === "firewall" || p[0] === "nat")) {
    let node = cfg;
    for (const k of p.slice(0, ruleAt + 2)) node = node?.[k];
    return node != null && !isVyGi(node);
  }
  if (p[0] === "firewall" && p[1] === "group") return !/^VYGI-/.test(p[3] || "");
  // adding a value to a list (allow-from, listen-address) changes nothing that exists
  if (c.op === "set" && MULTI.has(p[p.length - 1])) return false;
  let node = cfg;
  for (const k of p) node = node?.[k];
  return c.op === "delete" ? node != null : node != null && c.value !== undefined && node !== c.value;
}

/**
 * Checks a change before it's applied. Returns
 * { extras: [{ finding, commands }], warnings: [finding] } for problems the
 * change would cause: extras are safe fixes to apply with it, warnings need
 * the user to decide.
 */
/**
 * Would this change take away the address VyGi reaches the router on?
 * env.mgmtHost: that address; env.mgmtIface: the interface it's on (from the
 * router's live addresses). A finding, or null.
 */
export function lockout(before, after, env = {}) {
  const login = loginLockout(before, after, env);
  if (login) return login;
  const fwd = forwardLockout(before, after, env);
  if (fwd) return fwd;
  const { mgmtHost: host, mgmtIface: iface } = env;
  if (!host || !iface) return null;
  const node = (cfg) => flattenInterfaces(cfg?.interfaces).get(iface)?.cfg;
  const state = (cfg) => {
    const n = node(cfg);
    if (!n || "disable" in n) return { fixed: false, dhcp: false };
    const a = toArray(n.address);
    return { fixed: a.some((x) => String(x).split("/")[0] === host), dhcp: a.includes("dhcp") };
  };
  const b = state(before);
  const a = state(after);
  // fixed before: it must stay; from DHCP before: DHCP (or the same address, fixed) must stay
  const ok = b.fixed ? a.fixed : !b.dhcp || a.fixed || a.dhcp;
  if (ok) return null;
  return {
    id: `lockout:${iface}`, level: "bad", title: `VyGi would lose the router`,
    text: `This takes ${host} off ${iface}, and that's the address VyGi (and anything else using it) reaches the router on. After applying, nothing can reach the router there: with Safe Mode on it comes back by itself when the timer runs out, with Safe Mode off only the router's console can fix it. To move the router to another address: add the new one first, reconnect VyGi to it, then remove the old one.`,
    fix: null, manual: false,
  };
}

/** True if a port forward with no port, interface and address limits takes every incoming connection. */
const catchAll = (r) => r && !("disable" in r) && !r?.destination?.port && !r?.destination?.address && !r?.["inbound-interface"]?.name && !r?.["inbound-interface"]?.group;

/** A new port forward that would send VyGi's own connection (to the API, on 443) somewhere else. */
function forwardLockout(before, after, env) {
  const host = env.mgmtHost;
  if (!host) return null;
  const was = before?.nat?.destination?.rule || {};
  for (const [n, r] of Object.entries(after?.nat?.destination?.rule || {})) {
    if (JSON.stringify(was[n]) === JSON.stringify(r) || !r || "disable" in r) continue;
    const inIf = r?.["inbound-interface"]?.name;
    const ports = String(r?.destination?.port || "");
    const proto = r?.protocol || "all";
    const dst = r?.destination?.address;
    const hitsPort = !ports || ports.split(",").some((p) => p === "443" || (p.includes("-") && +p.split("-")[0] <= 443 && 443 <= +p.split("-")[1]));
    const hitsIf = !inIf || inIf === env.mgmtIface;
    const hitsAddr = !dst || dst === host || (dst.includes("/") && ipv4InCidr(host, dst));
    if (hitsPort && hitsIf && hitsAddr && /^(all|tcp|tcp_udp)$/.test(proto)) {
      return {
        id: `lockout:dnat:${n}`, level: "bad", title: "VyGi would lose the router",
        text: `Port forward rule ${n} ${catchAll(r) ? "has no port, interface or address, so it sends every connection to the router" : "takes port 443"}${inIf ? ` on ${inIf}` : ""} to ${r?.translation?.address || "another address"}, including VyGi's own connection to ${host}. Give it a port${inIf ? "" : " and the internet interface"}.`,
        fix: null, manual: false,
      };
    }
  }
  return null;
}

/** The change removes the login VyGi uses (env.user), or its SSH key (env.keyLogin). */
function loginLockout(before, after, env) {
  const u = env.user;
  if (!u) return null;
  const was = before?.system?.login?.user?.[u];
  const now = after?.system?.login?.user?.[u];
  const key = (c) => c?.authentication?.["public-keys"]?.vygi;
  const gone = was && !now ? `removes the ${u} login` : env.keyLogin && key(was) && !key(now) ? `removes the SSH key VyGi logs in with (${u})` : null;
  if (!gone) return null;
  return {
    id: `lockout:login:${u}`, level: "bad", title: "VyGi would lose the router",
    text: `This ${gone}, so VyGi can't log in to the router any more. Use Set up this router to change VyGi's login instead.`,
    fix: null, manual: false,
  };
}

export function checkChange(cfg, commands, env = {}) {
  const before = new Set(diagnose(cfg, env).map((f) => f.id));
  const after = simulate(cfg, commands);
  const fresh = diagnose(after, env).filter((f) => !before.has(f.id) && f.level !== "info" && !f.security);
  const extras = [];
  const warnings = [];
  for (const f of fresh) {
    if (f.fix && !f.manual) extras.push({ finding: f, commands: f.fix });
    else warnings.push(f);
  }
  const lock = lockout(cfg, after, env);
  if (lock) warnings.unshift(lock);
  return { extras, warnings };
}
