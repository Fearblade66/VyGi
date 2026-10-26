// Internet connection (Settings > Internet): automatic (DHCP), fixed
// address or PPPoE, an optional VLAN tag some providers need, and IPv6 from
// the provider (DHCPv6 prefix delegation, handed to local networks with
// router advertisements). Changing the internet interface also moves every
// rule that names it (NAT, firewall, Smart Queues, failover, Dynamic DNS).
// Pure: no API calls.
import { toArray, tagKeys, parseIpv4Cidr, ipv4InCidr, toCommands } from "./vyos.js";

export const PD_LENGTHS = ["48", "56", "60", "64"];

/** Config path of an interface name: eth0, eth0.35 (VLAN) or pppoe0. */
export function ifacePath(name) {
  if (name.startsWith("pppoe")) return ["interfaces", "pppoe", name];
  const [port, vlan] = name.split(".");
  return vlan ? ["interfaces", "ethernet", port, "vif", vlan] : ["interfaces", "ethernet", port];
}

function nodeAt(cfg, path) {
  return path.reduce((n, k) => (n && typeof n === "object" ? n[k] : undefined), cfg);
}

/**
 * The current internet connection. liveWan: the interface of the default
 * route (wanInfo), used when the config alone is ambiguous.
 * { wan, port, vlan, mode: "dhcp"|"static"|"pppoe", user, hasPassword,
 *   staticAddr, gateway, dns, ipv6, pdLength, pdLans[], manual }
 */
export function readInternet(cfg, liveWan = "") {
  const eth = cfg?.interfaces?.ethernet || {};
  const pppoe = cfg?.interfaces?.pppoe || {};
  const dhcpPort = Object.keys(eth).find((p) => toArray(eth[p]?.address).includes("dhcp"));
  const wan = liveWan || Object.keys(pppoe)[0] || dhcpPort || "";
  const out = { wan, port: "", vlan: "", mode: "dhcp", user: "", hasPassword: false, staticAddr: "", gateway: "", dns: "", ipv6: false, pdLength: "56", pdLans: [], manual: false };
  if (!wan) return { ...out, manual: true };
  let carrier = wan;
  if (wan.startsWith("pppoe")) {
    const p = pppoe[wan] || {};
    carrier = p["source-interface"] || "";
    out.mode = "pppoe";
    out.user = p.authentication?.username || "";
    out.hasPassword = !!p.authentication?.password;
  }
  const [port, vlan = ""] = carrier.split(".");
  out.port = port;
  out.vlan = vlan;
  const node = nodeAt(cfg, ifacePath(carrier)) || {};
  const addrs = toArray(node.address);
  if (out.mode !== "pppoe") {
    out.staticAddr = addrs.find((a) => parseIpv4Cidr(a)) || "";
    out.mode = addrs.includes("dhcp") ? "dhcp" : out.staticAddr ? "static" : "dhcp";
    if (!addrs.length || carrier.split(".").length > 2) out.manual = true;
  }
  out.gateway = tagKeys(cfg?.protocols?.static?.route?.["0.0.0.0/0"]?.["next-hop"])[0] || "";
  out.dns = toArray(cfg?.system?.["name-server"]).join(" ");
  const pd = nodeAt(cfg, [...ifacePath(wan), "dhcpv6-options", "pd"]);
  if (pd) {
    out.ipv6 = true;
    out.pdLength = String(pd["0"]?.length || "64");
    out.pdLans = Object.keys(pd["0"]?.interface || {});
    if (Object.keys(pd).length > 1) out.manual = true;
  }
  if (Object.keys(pppoe).length > 1 || !port) out.manual = true;
  return out;
}

// Places outside `interfaces` that name the internet interface.
const REF_ROOTS = ["nat", "firewall", "qos", "load-balancing", "policy", "service"];
const REF_KEYS = new Set(["name", "interface", "inbound-interface", "outbound-interface"]);
// Nodes keyed by interface name (moved as a whole).
const KEYED = [["qos", "interface"], ["load-balancing", "wan", "interface-health"]];

/** Commands that make every rule naming `from` (or "!from") name `to` instead. */
export function retargetWan(cfg, from, to) {
  const cmds = [];
  if (!from || !to || from === to) return cmds;
  const walk = (node, path) => {
    for (const [k, v] of Object.entries(node || {})) {
      const p = [...path, k];
      if (KEYED.some((kp) => kp.length === path.length && kp.every((x, i) => x === path[i])) && k === from) {
        cmds.push(...toCommands(v, [...path, to]), { op: "delete", path: p });
        continue;
      }
      if (typeof v === "string") {
        if (REF_KEYS.has(k) && (v === from || v === `!${from}`)) cmds.push({ op: "set", path: p, value: v.replace(from, to) });
      } else if (Array.isArray(v)) {
        for (const x of v) {
          if (REF_KEYS.has(k) && (x === from || x === `!${from}`)) cmds.push({ op: "delete", path: p, value: x }, { op: "set", path: p, value: x.replace(from, to) });
        }
      } else if (v && typeof v === "object") walk(v, p);
    }
  };
  for (const root of REF_ROOTS) if (cfg?.[root]) walk({ [root]: cfg[root] }, []);
  return cmds;
}

/**
 * Commands for a new internet connection. cur: readInternet(). v: { port,
 * vlan, mode, user, password, staticAddr, gateway, dns, ipv6, pdLength,
 * pdLans[] }. lans: local interface names (for prefix delegation).
 * Returns { cmds, wan } (wan: the new internet interface). Throws on bad input.
 */
export function internetCommands(cfg, cur, v, lans = []) {
  const cmds = [];
  const set = (path, value) => cmds.push(value === undefined ? { op: "set", path } : { op: "set", path, value: String(value) });
  const del = (path, value) => cmds.push(value === undefined ? { op: "delete", path } : { op: "delete", path, value });
  const eth = cfg?.interfaces?.ethernet || {};
  const pppoe = cfg?.interfaces?.pppoe || {};

  const port = String(v.port || "").trim();
  if (!eth[port]) throw new Error("Choose the port connected to your modem or ONT");
  const vlan = String(v.vlan ?? "").trim();
  if (vlan && !(/^\d+$/.test(vlan) && +vlan >= 1 && +vlan <= 4094)) throw new Error("VLAN tag: a number from 1 to 4094 (or leave it empty)");
  if (v.ipv6 && !PD_LENGTHS.includes(String(v.pdLength))) throw new Error("Choose the prefix size your provider gives");
  const carrier = vlan ? `${port}.${vlan}` : port;
  const wan = v.mode === "pppoe" ? (cur.mode === "pppoe" && cur.wan ? cur.wan : Object.keys(pppoe)[0] || "pppoe0") : carrier;
  const oldCarrier = cur.mode === "pppoe" ? [cur.port, cur.vlan].filter(Boolean).join(".") : cur.wan;

  // ---- what the old connection leaves behind
  if (cur.mode === "pppoe" && v.mode !== "pppoe" && cur.wan) del(ifacePath(cur.wan));
  if (oldCarrier && oldCarrier !== carrier) {
    const old = nodeAt(cfg, ifacePath(oldCarrier)) || {};
    const extra = Object.keys(old).filter((k) => !["address", "dhcpv6-options", "description"].includes(k));
    if (oldCarrier.includes(".") && !extra.length) del(ifacePath(oldCarrier));
    else {
      if (old.address) del([...ifacePath(oldCarrier), "address"]);
      if (old["dhcpv6-options"]) del([...ifacePath(oldCarrier), "dhcpv6-options"]);
    }
  }
  if (cur.mode === "static" && v.mode !== "static" && cur.gateway) del(["protocols", "static", "route", "0.0.0.0/0"]);

  // ---- the new connection
  const cpath = ifacePath(carrier);
  const want = v.mode === "dhcp" ? ["dhcp", ...(v.ipv6 ? ["dhcpv6"] : [])] : v.mode === "static" ? [String(v.staticAddr || "").trim()] : [];
  if (v.mode === "static") {
    const w = parseIpv4Cidr(want[0]);
    if (!w) throw new Error("Address must look like 203.0.113.10/24");
    const gw = String(v.gateway || "").trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(gw) || !ipv4InCidr(gw, w.network)) throw new Error("Gateway must be an address inside that network");
    if (cur.gateway !== gw) {
      if (cur.gateway) del(["protocols", "static", "route", "0.0.0.0/0"]);
      set(["protocols", "static", "route", "0.0.0.0/0", "next-hop", gw]);
    }
    const dns = String(v.dns || "").split(/[\s,]+/).filter(Boolean);
    if (!dns.length) throw new Error("Enter at least one DNS server (e.g. 1.1.1.1)");
    for (const d of dns) if (!/^[\d.]+$|^[0-9a-f:]+$/i.test(d)) throw new Error(`Bad DNS server ${d}`);
    const curDns = toArray(cfg?.system?.["name-server"]);
    for (const d of curDns) if (!dns.includes(d)) del(["system", "name-server"], d);
    for (const d of dns) if (!curDns.includes(d)) set(["system", "name-server"], d);
  }
  const have = toArray(nodeAt(cfg, [...cpath, "address"]));
  const same = have.length === want.length && want.every((a) => have.includes(a));
  if (!same) {
    if (have.length) del([...cpath, "address"]);
    for (const a of want) set([...cpath, "address"], a);
  }
  if (vlan && !want.length && !nodeAt(cfg, cpath)) set(cpath);

  if (v.mode === "pppoe") {
    const user = String(v.user || "").trim();
    if (!user) throw new Error("PPPoE needs the username from your provider");
    const p = ["interfaces", "pppoe", wan];
    const node = pppoe[wan] || {};
    if (node["source-interface"] !== carrier) set([...p, "source-interface"], carrier);
    if (node.authentication?.username !== user) set([...p, "authentication", "username"], user);
    if (v.password) set([...p, "authentication", "password"], v.password);
    else if (!node.authentication?.password) throw new Error("PPPoE needs the password from your provider");
    if (!node.mtu) set([...p, "mtu"], "1492");
    if (!node.ip?.["adjust-mss"]) set([...p, "ip", "adjust-mss"], "clamp-mss-to-pmtu");
  }

  // ---- IPv6 from the provider: a prefix, split into one /64 per local network
  const pdPath = [...ifacePath(wan), "dhcpv6-options", "pd", "0"];
  const radv = cfg?.service?.["router-advert"]?.interface || {};
  const wantLans = v.ipv6 ? (v.pdLans || []).filter((l) => lans.includes(l)) : [];
  if (v.ipv6) {
    if (!wantLans.length) throw new Error("Choose at least one network to get IPv6");
    const curPd = wan === cur.wan && cur.ipv6 ? cur : null;
    const samePd = curPd && curPd.pdLength === String(v.pdLength) && curPd.pdLans.length === wantLans.length && wantLans.every((l) => curPd.pdLans.includes(l));
    if (!samePd) {
      if (nodeAt(cfg, pdPath)) del(pdPath);
      set([...pdPath, "length"], v.pdLength);
      wantLans.forEach((l, i) => {
        set([...pdPath, "interface", l, "sla-id"], String(i + 1));
        set([...pdPath, "interface", l, "address"], "1");
      });
    }
    if (v.mode === "pppoe" && !nodeAt(cfg, ["interfaces", "pppoe", wan, "ipv6", "address", "autoconf"])) set(["interfaces", "pppoe", wan, "ipv6", "address", "autoconf"]);
  } else if (cur.ipv6 && wan === cur.wan && nodeAt(cfg, [...ifacePath(wan), "dhcpv6-options", "pd"])) {
    del([...ifacePath(wan), "dhcpv6-options", "pd"]);
  }
  // router advertisements: on for networks getting a prefix, off for ones we stop
  for (const l of wantLans) if (!radv[l]) set(["service", "router-advert", "interface", l, "prefix", "::/64"]);
  for (const l of cur.ipv6 ? cur.pdLans : []) {
    if (!wantLans.includes(l) && radv[l] && Object.keys(radv[l]).join() === "prefix" && Object.keys(radv[l].prefix || {}).join() === "::/64") del(["service", "router-advert", "interface", l]);
  }

  // ---- rules that name the internet interface follow it
  cmds.push(...retargetWan(cfg, cur.wan, wan));
  return { cmds, wan };
}

/** "PPPoE on eth0, VLAN 35, IPv6 /56" */
export function describeInternet(c) {
  const how = { dhcp: "Automatic (DHCP)", static: "Fixed address", pppoe: "PPPoE" }[c.mode] || "Set up by hand";
  return [`${how} on ${c.port || "?"}`, c.vlan ? `VLAN ${c.vlan}` : "", c.ipv6 ? `IPv6 /${c.pdLength}` : ""].filter(Boolean).join(", ");
}
