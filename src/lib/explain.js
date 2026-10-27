// "Why is this blocked?": walks the router's IPv4 forward chain (and the
// custom chains it jumps to) the way the firewall does, for a new connection
// from one device to the internet or to another network, and says which rule
// decides, which rules only apply to some of the traffic (some sites, a
// schedule, some ports), and which page made each rule. Pure: no API calls.
import { toArray, parseIpv4Cidr } from "./vyos.js";
import { ownerOf } from "./owner.js";

const YES = "yes";
const NO = "no";
const MAYBE = "maybe";

function ipInt(s) {
  const m = String(s || "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

/** "10.0.0.0/8", "10.0.0.1-10.0.0.9", "10.0.0.1" -> [lo, hi], or null (IPv6, names). */
function span(v) {
  const s = String(v).trim();
  if (s.includes("/")) {
    const p = parseIpv4Cidr(s);
    if (!p) return null;
    const [net, bits] = p.network.split("/");
    const lo = ipInt(net);
    return [lo, (lo + 2 ** (32 - Number(bits)) - 1) >>> 0];
  }
  if (s.includes("-")) {
    const [a, b] = s.split("-").map(ipInt);
    return a == null || b == null ? null : [a, b];
  }
  const n = ipInt(s);
  return n == null ? null : [n, n];
}

const PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16"].map(span);
const inside = (a, b) => a[0] >= b[0] && a[1] <= b[1];
const overlaps = (a, b) => a[0] <= b[1] && b[0] <= a[1];

const negate = (r) => (r === YES ? NO : r === NO ? YES : MAYBE);
function any(results) {
  if (results.includes(YES)) return YES;
  return results.includes(MAYBE) ? MAYBE : NO;
}

/** Does one address value match the target? target: { ip } (source) or { range } / { internet: true } (destination). */
function addrMatch(value, target) {
  let v = String(value).trim();
  const neg = v.startsWith("!");
  if (neg) v = v.slice(1);
  const s = span(v);
  let r;
  if (!s) r = v.includes(":") ? NO : MAYBE; // IPv6 never matches IPv4 traffic
  else if (target.ip != null) {
    const n = ipInt(target.ip);
    r = n != null && n >= s[0] && n <= s[1] ? YES : NO;
  } else if (target.range) {
    r = inside(target.range, s) ? YES : overlaps(target.range, s) ? MAYBE : NO;
  } else {
    // somewhere on the internet: private ranges never match, 0.0.0.0/0 always does
    r = s[0] === 0 && s[1] === 0xffffffff ? YES : PRIVATE.some((p) => inside(s, p)) ? NO : MAYBE;
  }
  return neg ? negate(r) : r;
}

function ifaceMatch(value, iface, cfg) {
  if (!iface) return MAYBE;
  const node = value && typeof value === "object" ? value : { name: value };
  const res = [];
  for (const raw of toArray(node.name)) {
    let v = String(raw);
    const neg = v.startsWith("!");
    if (neg) v = v.slice(1);
    const re = new RegExp(`^${v.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    const r = re.test(iface) ? YES : NO;
    res.push(neg ? negate(r) : r);
  }
  for (const raw of toArray(node.group)) {
    let g = String(raw);
    const neg = g.startsWith("!");
    if (neg) g = g.slice(1);
    const members = toArray(cfg?.firewall?.group?.["interface-group"]?.[g]?.interface);
    const r = members.includes(iface) ? YES : NO;
    res.push(neg ? negate(r) : r);
  }
  return res.length ? (res.includes(NO) ? NO : res.includes(MAYBE) ? MAYBE : YES) : MAYBE;
}

/** Source or destination side of a rule; `side` is what we know about the packet's end. */
function endMatch(node, side, cfg, reasons, where) {
  const res = [];
  for (const [k, v] of Object.entries(node || {})) {
    if (k === "address") res.push(any(toArray(v).map((x) => addrMatch(x, side))));
    else if (k === "mac-address") {
      if (!side.mac) res.push(MAYBE);
      else res.push(any(toArray(v).map((m) => {
        const s = String(m);
        const r = s.replace(/^!/, "").toLowerCase() === side.mac.toLowerCase() ? YES : NO;
        return s.startsWith("!") ? negate(r) : r;
      })));
    } else if (k === "group") {
      for (const [kind, raw] of Object.entries(v || {})) {
        let name = String(raw);
        const neg = name.startsWith("!");
        if (neg) name = name.slice(1);
        const g = cfg?.firewall?.group?.[kind]?.[name] || {};
        let r;
        if (kind === "address-group") r = any(toArray(g.address).map((x) => addrMatch(x, side)));
        else if (kind === "network-group") r = any(toArray(g.network).map((x) => addrMatch(x, side)));
        else if (kind === "mac-group") r = side.mac ? (toArray(g["mac-address"]).some((m) => String(m).toLowerCase() === side.mac.toLowerCase()) ? YES : NO) : MAYBE;
        else if (kind === "domain-group" && side.range && PRIVATE.some((p) => inside(side.range, p))) r = NO; // sites are on the internet
        else if (kind === "domain-group") {
          r = MAYBE;
          const sites = toArray(g.address);
          reasons.push(`only ${where} ${sites.slice(0, 3).join(", ")}${sites.length > 3 ? ` and ${sites.length - 3} more` : ""}`);
        } else if (kind === "port-group") {
          r = MAYBE;
          reasons.push(`only some ${where === "to" ? "" : "source "}ports`);
        } else r = MAYBE;
        res.push(neg ? negate(r) : r);
      }
    } else if (k === "port") {
      res.push(MAYBE);
      reasons.push(`only ${where === "to" ? "" : "source "}port ${toArray(v).join(", ")}`);
    } else if (k === "geoip" && side.range && PRIVATE.some((p) => inside(side.range, p))) {
      res.push(NO); // countries are on the internet
    } else if (k === "geoip") {
      res.push(MAYBE);
      const cc = toArray(v?.["country-code"]);
      reasons.push(`only ${where} some countries${cc.length ? ` (${cc.slice(0, 4).join(", ").toUpperCase()}${cc.length > 4 ? ", …" : ""})` : ""}`);
    } else if (k === "fqdn") {
      res.push(MAYBE);
      reasons.push(`only ${where} ${toArray(v).join(", ")}`);
    } else res.push(MAYBE);
  }
  return res.includes(NO) ? NO : res.includes(MAYBE) ? MAYBE : YES;
}

const IGNORED = new Set(["action", "description", "disable", "log", "log-options", "jump-target", "queue", "queue-options"]);

/** Does `rule` match a new connection `pkt`? -> { match: yes|no|maybe, reasons: [] }. */
export function ruleMatch(rule, pkt, cfg) {
  const reasons = [];
  const res = [];
  for (const [k, v] of Object.entries(rule || {})) {
    if (IGNORED.has(k)) continue;
    if (k === "source") res.push(endMatch(v, { ip: pkt.srcIp, mac: pkt.srcMac }, cfg, reasons, "from"));
    else if (k === "destination") res.push(endMatch(v, pkt.dstRange ? { range: pkt.dstRange } : { internet: true }, cfg, reasons, "to"));
    else if (k === "inbound-interface") res.push(ifaceMatch(v, pkt.inIf, cfg));
    else if (k === "outbound-interface") res.push(ifaceMatch(v, pkt.outIf, cfg));
    else if (k === "state") {
      const states = Array.isArray(v) || typeof v !== "object" ? toArray(v) : Object.keys(v);
      res.push(states.includes("new") ? YES : NO);
    } else if (k === "protocol") {
      const p = String(v);
      if (p === "all") continue;
      res.push(MAYBE);
      reasons.push(p.startsWith("!") ? `not for ${p.slice(1).toUpperCase()}` : `only ${p.replace("tcp_udp", "TCP/UDP").toUpperCase()}`);
    } else if (k === "time") {
      res.push(MAYBE);
      reasons.push(`on a schedule${v?.starttime ? ` (${v.starttime}–${v.stoptime || "23:59"}${v.weekdays ? `, ${v.weekdays}` : ""})` : ""}`);
    } else if (k === "connection-status") {
      res.push(NO); // forwarded / NAT'd connections, not new ones from the device
    } else {
      res.push(MAYBE);
      reasons.push(`only some traffic (${k})`);
    }
  }
  const match = res.includes(NO) ? NO : res.includes(MAYBE) ? MAYBE : YES;
  return { match, reasons: match === MAYBE ? [...new Set(reasons)] : [] };
}

const byNumber = (rules) => Object.entries(rules || {}).map(([n, r]) => ({ number: Number(n), rule: r || {} })).filter((x) => !("disable" in x.rule)).sort((a, b) => a.number - b.number);

/**
 * Walks a chain for `pkt`. Returns { action: accept|drop|reject|return|null (end of chain), steps }.
 * steps: every rule that matches (yes) or may match (maybe), in order.
 */
function walk(cfg, chainName, rules, pkt, depth, steps) {
  for (const { number, rule } of byNumber(rules)) {
    const { match, reasons } = ruleMatch(rule, pkt, cfg);
    if (match === NO) continue;
    const action = String(rule.action || "accept");
    const step = { chain: chainName, number, action, match, reasons, description: rule.description || "", owner: ownerOf(rule.description) };
    steps.push(step);
    if (action === "jump" && rule["jump-target"] && depth < 8) {
      const target = cfg?.firewall?.ipv4?.name?.[rule["jump-target"]];
      const inner = walk(cfg, rule["jump-target"], target?.rule, pkt, depth + 1, steps);
      const end = inner.action ?? String(target?.["default-action"] || "drop");
      if (end === "return" || end === "continue") continue;
      if (match === YES) return { action: end, by: inner.by || step };
      continue;
    }
    if (action === "continue") continue;
    if (match === YES) return { action, by: step };
  }
  return { action: null, by: null };
}

/**
 * What happens to a new connection `pkt` going through the router:
 * { verdict: "allowed"|"blocked", by: step|null (null: the chain's default),
 *   partly: [steps that block some of it], partlyAllowed: [exceptions, when
 *   blocked], steps }.
 */
export function explainPath(cfg, pkt) {
  const chain = cfg?.firewall?.ipv4?.forward?.filter || {};
  const steps = [];
  const res = walk(cfg, "forward", chain.rule, pkt, 0, steps);
  const action = res.action && res.action !== "return" ? res.action : String(chain["default-action"] || "accept");
  const verdict = action === "accept" ? "allowed" : "blocked";
  const decided = res.by;
  // rules before the deciding one that block only some of this traffic
  const before = decided ? steps.slice(0, steps.indexOf(decided)) : steps;
  const partly = before.filter((s) => s.match === MAYBE && (s.action === "drop" || s.action === "reject"));
  const partlyAllowed = verdict === "blocked" ? before.filter((s) => s.match === MAYBE && s.action === "accept") : [];
  return { verdict, by: res.action && res.action !== "return" ? decided : null, partly, partlyAllowed, steps };
}

/**
 * For a device { ip, mac, iface }: the internet, each other network, and the
 * port forwards that reach it. nets: readNetworks(); wan: the internet interface.
 */
export function explainDevice(cfg, dev, nets, wan) {
  const base = { srcIp: dev.ip, srcMac: dev.mac, inIf: dev.iface };
  const out = {
    internet: explainPath(cfg, { ...base, outIf: wan, dstRange: null }),
    networks: nets.filter((n) => n.iface !== dev.iface).map((n) => ({ net: n, ...explainPath(cfg, { ...base, outIf: n.iface, dstRange: span(n.network) }) })),
    forwards: [],
  };
  for (const [num, r] of Object.entries(cfg?.nat?.destination?.rule || {})) {
    if (!r || "disable" in r || r.translation?.address !== dev.ip) continue;
    out.forwards.push({
      number: Number(num),
      protocol: r.protocol || "all",
      port: r.destination?.port || "",
      toPort: r.translation?.port || r.destination?.port || "",
      from: toArray(r.source?.address).join(", "),
      owner: ownerOf(r.description),
      description: r.description || "",
    });
  }
  return out;
}
