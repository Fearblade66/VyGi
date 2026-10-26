// Network policies (UniFi's policy table): allow or block traffic from a
// network, device or device group to a network or device, optionally only
// some ports. They are firewall forward rules described "VyGi policy <id>:
// <name>", kept FIRST among rules 1-99, before isolation, Traffic Rules and
// blocked devices, so an "allow" can make an exception to an isolated network.
// Pure: no API calls.
import { ipv4InCidr } from "./vyos.js";
const PREFIX = "VyGi policy ";
const DESC = /^VyGi policy (\d+): (.*)$/;
const RANGE = [1, 99];
const FAMILIES = ["ipv4", "ipv6"];

const chainRules = (cfg, fam) => cfg?.firewall?.[fam]?.forward?.filter?.rule || {};

/** Policies on the router, in order: [{ id, name, action, from, to, protocol, ports, disabled }]. */
export function readPolicies(cfg) {
  const byId = new Map();
  for (const fam of FAMILIES) {
    const rules = chainRules(cfg, fam);
    for (const n of Object.keys(rules).map(Number).sort((a, b) => a - b)) {
      const r = rules[n];
      const m = String(r?.description || "").match(DESC);
      if (!m || byId.has(m[1])) continue;
      const src = r.source || {};
      const dst = r.destination || {};
      byId.set(m[1], {
        id: m[1],
        name: m[2],
        action: r.action === "accept" ? "allow" : "block",
        from: r["inbound-interface"]?.name ? { kind: "net", value: r["inbound-interface"].name }
          : src.group?.["mac-group"] ? { kind: "group", value: src.group["mac-group"] }
          : src["mac-address"] ? { kind: "device", value: String(src["mac-address"]).toLowerCase() }
          : { kind: "any", value: "" },
        to: r["outbound-interface"]?.name ? { kind: "net", value: r["outbound-interface"].name }
          : dst.address ? { kind: "device", value: dst.address }
          : { kind: "any", value: "" },
        protocol: r.protocol || "any",
        ports: dst.port ? String(dst.port) : "",
        disabled: "disable" in r,
        order: n,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.order - b.order);
}

/** The firewall rule for policy `p` in family `fam`, or null if it doesn't apply there. */
export function policyRule(p, fam) {
  if (fam === "ipv6" && p.to.kind === "device") return null; // devices are reached by their IPv4 address
  const r = { action: p.action === "allow" ? "accept" : "drop", description: `${PREFIX}${p.id}: ${p.name}` };
  if (p.from.kind === "net") r["inbound-interface"] = { name: p.from.value };
  if (p.from.kind === "device") r.source = { "mac-address": p.from.value };
  if (p.from.kind === "group") r.source = { group: { "mac-group": p.from.value } };
  if (p.to.kind === "net") r["outbound-interface"] = { name: p.to.value };
  if (p.to.kind === "device") r.destination = { address: p.to.value };
  if (p.protocol && p.protocol !== "any") r.protocol = p.protocol;
  if (p.ports) r.destination = { ...(r.destination || {}), port: p.ports };
  // a block stops new connections, like isolation; replies to allowed ones still pass
  if (p.action === "block") r.state = "new";
  if (p.disabled) r.disable = {};
  return r;
}

/** Checks a policy from the form; returns it cleaned up or throws. */
export function checkPolicy(p) {
  const name = String(p.name || "").trim();
  if (!name) throw new Error("Give the policy a name");
  if (!/^[^'"\n\\]{1,60}$/.test(name)) throw new Error("Name: up to 60 characters, no quotes");
  if (p.from.kind === "any" && p.to.kind === "any") throw new Error("Choose where the traffic comes from or goes to");
  if (p.from.kind === p.to.kind && p.from.kind === "net" && p.from.value === p.to.value) throw new Error("From and To are the same network");
  const ports = String(p.ports || "").replace(/\s+/g, "");
  if (ports) {
    if (!["tcp", "udp", "tcp_udp"].includes(p.protocol)) throw new Error("Ports need TCP, UDP or both");
    for (const part of ports.split(",")) {
      const m = part.match(/^(\d+)(?:-(\d+))?$/);
      if (!m || +m[1] < 1 || +m[1] > 65535 || (m[2] && (+m[2] < +m[1] || +m[2] > 65535))) throw new Error(`Bad port ${part}: use 445, 8000-8100 or 80,443`);
    }
  }
  if (p.to.kind === "device" && !/^\d{1,3}(\.\d{1,3}){3}$/.test(p.to.value)) throw new Error("That device has no fixed IPv4 address; give it one first (Clients → Fix IP)");
  return { ...p, name, ports, protocol: p.protocol || "any" };
}

const sameRule = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
function normalize(v) {
  if (Array.isArray(v)) return v.length === 1 ? normalize(v[0]) : v.map(normalize);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, normalize(v[k])]));
  return v == null ? v : String(v);
}

function toCmds(node, path) {
  if (typeof node === "string") return [{ op: "set", path, value: node }];
  if (Array.isArray(node)) return node.map((x) => ({ op: "set", path, value: String(x) }));
  const entries = Object.entries(node || {});
  if (!entries.length) return [{ op: "set", path }];
  return entries.flatMap(([k, x]) => toCmds(x, [...path, k]));
}

/**
 * Commands that make the router's policies `list` (in this order): policies
 * take the first numbers of 1-99 not used by hand-made rules, VyGi's other
 * rules there follow in their current order. Only changed rules are touched.
 */
export function policyCommands(cfg, list) {
  const cmds = [];
  for (const fam of FAMILIES) {
    const rules = chainRules(cfg, fam);
    const inRange = Object.keys(rules).map(Number).filter((n) => n >= RANGE[0] && n <= RANGE[1]).sort((a, b) => a - b);
    const vygi = (n) => /^VyGi\b/.test(String(rules[n]?.description || ""));
    const hand = new Set(inRange.filter((n) => !vygi(n)));
    const others = inRange.filter((n) => vygi(n) && !String(rules[n].description).startsWith(PREFIX));
    const free = [];
    for (let n = RANGE[0]; n <= RANGE[1]; n++) if (!hand.has(n)) free.push(n);
    const wanted = [...list.map((p) => policyRule(p, fam)).filter(Boolean), ...others.map((n) => rules[n])];
    if (wanted.length > free.length) throw new Error("No free firewall rule numbers left between 1 and 99");
    const next = new Map(wanted.map((r, i) => [free[i], r]));
    const base = (n) => ["firewall", fam, "forward", "filter", "rule", String(n)];
    const changed = [...new Set([...inRange.filter((n) => !hand.has(n)), ...next.keys()])]
      .filter((n) => !(rules[n] && next.has(n) && sameRule(rules[n], next.get(n))));
    for (const n of changed) if (rules[n]) cmds.push({ op: "delete", path: base(n) });
    for (const n of changed) if (next.has(n)) cmds.push(...toCmds(next.get(n), base(n)));
  }
  return cmds;
}

/** Next free policy id. */
export function nextPolicyId(list) {
  return String(Math.max(0, ...list.map((p) => Number(p.id) || 0)) + 1);
}

/**
 * Whether new connections from network a may reach network b (the grid):
 * { allowed, exceptions: [policy] } — isolation decides, policies between
 * exactly these two networks are the exceptions.
 */
export function reach(a, b, policies) {
  const allowed = !(a.isolated || b.isolated);
  const into = (to) => (to.kind === "net" && to.value === b.iface) || (to.kind === "device" && !!b.network && ipv4InCidr(to.value, b.network));
  const exceptions = policies.filter((p) => !p.disabled && p.from.kind === "net" && p.from.value === a.iface && into(p.to));
  return { allowed, exceptions };
}

/** Policies that would run after an isolation or Traffic Rule (an "allow" there does nothing). */
export function misplacedPolicies(cfg) {
  const out = [];
  for (const fam of FAMILIES) {
    const rules = chainRules(cfg, fam);
    const nums = Object.keys(rules).map(Number).sort((a, b) => a - b);
    let firstOther = Infinity;
    for (const n of nums) {
      const d = String(rules[n]?.description || "");
      if (/^VyGi\b/.test(d) && !d.startsWith(PREFIX) && n <= RANGE[1]) firstOther = Math.min(firstOther, n);
      if (d.startsWith(PREFIX) && n > firstOther && rules[n].action === "accept") out.push(d.slice(PREFIX.length).replace(/^\d+: /, ""));
    }
  }
  return [...new Set(out)];
}

/** "TCP 445", "any port" */
export function describePorts(p) {
  if (p.protocol === "icmp") return "ping";
  const proto = { tcp: "TCP", udp: "UDP", tcp_udp: "TCP/UDP", icmp: "ping", any: "" }[p.protocol] ?? p.protocol;
  return p.ports ? `${proto} ${p.ports}` : proto ? `${proto}, any port` : "everything";
}

