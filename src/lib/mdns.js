// Device discovery across networks (mDNS / Bonjour: Chromecast, AirPlay,
// printers, smart speakers): VyOS's mDNS repeater on chosen networks. An
// isolated network blocks its devices from talking to the router, so it
// also gets an exception for mDNS (UDP 5353) in front of that block.
// Pure: no API calls.
import { toArray } from "./vyos.js";

const REPEATER = ["service", "mdns", "repeater"];
const FAMILIES = ["ipv4", "ipv6"];
const desc = (iface, what) => `VyGi net ${iface}: ${what}`;

/** { on, ifaces[], manual } — manual: set up with options VyGi doesn't manage. */
export function readMdns(cfg) {
  const r = cfg?.service?.mdns?.repeater;
  const ifaces = toArray(r?.interface && typeof r.interface === "object" && !Array.isArray(r.interface) ? Object.keys(r.interface) : r?.interface);
  // other options (allowed services, browse domains, off switch) are set by hand: leave them to Advanced
  return { on: ifaces.length > 0, ifaces, ipVersion: r?.["ip-version"] || "", manual: Object.keys(r || {}).some((k) => k !== "interface" && k !== "ip-version") };
}

const inputRules = (cfg, fam) => cfg?.firewall?.[fam]?.input?.filter?.rule || {};
const findRule = (rules, d) => Object.keys(rules).find((n) => String(rules[n]?.description || "") === d);

/**
 * Commands to repeat mDNS between `ifaces` (none or one: off). Isolated
 * networks among them get the input exception; networks leaving lose it.
 */
export function mdnsCommands(cfg, ifaces) {
  const cmds = [];
  const cur = readMdns(cfg);
  if (ifaces.length === 1) throw new Error("Choose at least two networks: discovery is repeated between them");
  const want = ifaces.length >= 2 ? ifaces : [];
  if (cur.on && !want.length) cmds.push({ op: "delete", path: ["service", "mdns"] });
  else {
    for (const i of cur.ifaces) if (!want.includes(i)) cmds.push({ op: "delete", path: [...REPEATER, "interface"], value: i });
    for (const i of want) if (!cur.ifaces.includes(i)) cmds.push({ op: "set", path: [...REPEATER, "interface"], value: i });
    // VyOS repeats IPv6 too unless told otherwise, and then needs an IPv6 address on every
    // network: with one that has none (link-local turned off), repeat IPv4 only
    const v4only = want.some((i) => !hasIpv6(cfg, i));
    if (want.length && v4only && cur.ipVersion !== "ipv4") cmds.push({ op: "set", path: [...REPEATER, "ip-version"], value: "ipv4" });
    if (want.length && !v4only && cur.ipVersion === "ipv4") cmds.push({ op: "delete", path: [...REPEATER, "ip-version"] });
  }

  for (const fam of FAMILIES) {
    const rules = inputRules(cfg, fam);
    const used = new Set(Object.keys(rules).map(Number));
    for (const iface of new Set([...cur.ifaces, ...want, ...isolatedWithMdns(cfg, fam)])) {
      const allow = findRule(rules, desc(iface, "mDNS"));
      const drop = findRule(rules, desc(iface, "isolate router"));
      const base = (n) => ["firewall", fam, "input", "filter", "rule", String(n)];
      if (!want.includes(iface) || !drop) {
        if (allow) cmds.push({ op: "delete", path: base(allow) });
        continue;
      }
      if (allow && Number(allow) < Number(drop)) continue;
      if (allow) cmds.push({ op: "delete", path: base(allow) });
      // the exception takes the block's number; the block moves to the next free one after it
      let n = Number(drop) + 1;
      while (used.has(n)) n++;
      if (n > 99) throw new Error("No free firewall rule numbers left between 1 and 99");
      used.add(n);
      const r = rules[drop];
      cmds.push({ op: "delete", path: base(drop) });
      for (const [k, v] of Object.entries(r)) cmds.push(...setTree(v, [...base(n), k]));
      cmds.push(
        { op: "set", path: [...base(drop), "action"], value: "accept" },
        { op: "set", path: [...base(drop), "inbound-interface", "name"], value: iface },
        { op: "set", path: [...base(drop), "protocol"], value: "udp" },
        { op: "set", path: [...base(drop), "destination", "port"], value: "5353" },
        { op: "set", path: [...base(drop), "description"], value: desc(iface, "mDNS") },
      );
    }
  }
  return cmds;
}

/** Whether interface `name` has an IPv6 address (its own, or the automatic link-local one). */
function hasIpv6(cfg, name) {
  const [port, vlan] = name.split(".");
  for (const type of Object.values(cfg?.interfaces || {})) {
    const node = vlan ? type?.[port]?.vif?.[vlan] : type?.[name];
    if (!node) continue;
    if (toArray(node.address).some((a) => a.includes(":") || a === "dhcpv6")) return true;
    return !("no-default-link-local" in (node.ipv6?.address || {}));
  }
  return true;
}

function isolatedWithMdns(cfg, fam) {
  return Object.values(inputRules(cfg, fam)).map((r) => String(r?.description || "").match(/^VyGi net (\S+): mDNS$/)?.[1]).filter(Boolean);
}

function setTree(v, path) {
  if (typeof v === "string") return [{ op: "set", path, value: v }];
  if (Array.isArray(v)) return v.map((x) => ({ op: "set", path, value: String(x) }));
  const e = Object.entries(v || {});
  return e.length ? e.flatMap(([k, x]) => setTree(x, [...path, k])) : [{ op: "set", path }];
}

/** Isolated networks in the repeater whose mDNS exception is missing (e.g. after editing the network). */
export function mdnsGaps(cfg) {
  const { ifaces } = readMdns(cfg);
  const out = new Set();
  for (const fam of FAMILIES) {
    const rules = inputRules(cfg, fam);
    for (const i of ifaces) {
      const drop = findRule(rules, desc(i, "isolate router"));
      const allow = findRule(rules, desc(i, "mDNS"));
      if (drop && !(allow && Number(allow) < Number(drop))) out.add(i);
    }
  }
  return [...out];
}
