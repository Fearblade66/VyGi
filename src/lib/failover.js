// Backup internet line: VyOS WAN load balancing in failover mode. Traffic
// uses the main line while it answers pings and moves to the backup line when
// it doesn't. Traffic to private addresses (between your own networks) stays
// local, and traffic arriving from either line isn't touched. Pure.
import { toArray } from "./vyos.js";
import { wanBlocked } from "./secure.js";

const LB = ["load-balancing", "wan"];
export const FAILOVER_DESC = "VyGi: backup internet";
export const BACKUP_IF_DESC = "Backup internet";
const BLOCK_DESC = "VyGi: block new connections on the backup internet";
const BLOCK_RULE = "9901";
const DHCP6_RULE = "9891";
const LOCAL = [["1", "10.0.0.0/8"], ["2", "172.16.0.0/12"], ["3", "192.168.0.0/16"]];
const CHECK = { main: "1.1.1.1", backup: "9.9.9.9" }; // different targets, so one provider hiccup doesn't fail both

/** "on" (VyGi's), "off", or "manual" (load balancing set up by hand). */
export function failoverStatus(cfg) {
  const lb = cfg?.["load-balancing"]?.wan;
  if (!lb) return "off";
  return lb.rule?.["10"]?.description === FAILOVER_DESC ? "on" : "manual";
}

/** { main, backup } interfaces of VyGi's failover, or null. */
export function failoverLines(cfg) {
  if (failoverStatus(cfg) !== "on") return null;
  const ifs = Object.entries(cfg["load-balancing"].wan.rule["10"].interface || {}).sort((a, b) => Number(b[1]?.weight || 0) - Number(a[1]?.weight || 0));
  return { main: ifs[0]?.[0] || "", backup: ifs[1]?.[0] || "" };
}

const ethCfg = (cfg, iface) => {
  for (const t of Object.values(cfg?.interfaces || {})) if (t?.[iface]) return t[iface];
  return null;
};

/** Ports that could take a backup line: ethernet ports with no address, or one fetched by DHCP, other than the main line. */
export function backupCandidates(cfg, wan) {
  return Object.entries(cfg?.interfaces?.ethernet || {})
    .filter(([name, c]) => name !== wan && !c?.vif && (!toArray(c?.address).length || toArray(c.address).includes("dhcp")) && !Object.values(cfg?.interfaces?.bridge || {}).some((b) => b?.member?.interface?.[name]))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * spec: { wan, wanGateway, backup, mode: "dhcp"|"static", cidr, gateway }
 * wanGateway: the main line's gateway (used when it isn't DHCP).
 */
export function failoverOn(cfg, spec) {
  const { wan, backup } = spec;
  if (!wan) throw new Error("Can't tell which port is the internet");
  if (failoverStatus(cfg) === "manual") throw new Error("Load balancing was set up by hand: change it in Advanced");
  if (!backup || backup === wan) throw new Error("Choose the port the backup line (second modem, phone hotspot) is plugged into");
  const cmds = [];
  const set = (path, value) => cmds.push(value === undefined ? { op: "set", path } : { op: "set", path, value });
  const mainNh = toArray(ethCfg(cfg, wan)?.address).includes("dhcp") ? "dhcp" : spec.wanGateway;
  if (!mainNh) throw new Error(`Can't tell the main line's gateway on ${wan}`);

  // the backup port's address
  const bCfg = cfg?.interfaces?.ethernet?.[backup];
  const has = toArray(bCfg?.address);
  let backupNh = "dhcp";
  if (spec.mode === "static") {
    if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(spec.cidr || "")) throw new Error("Address: e.g. 192.168.8.2/24");
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(spec.gateway || "")) throw new Error("Gateway: the backup modem's address, e.g. 192.168.8.1");
    for (const a of has) cmds.push({ op: "delete", path: ["interfaces", "ethernet", backup, "address", a] });
    set(["interfaces", "ethernet", backup, "address"], spec.cidr);
    backupNh = spec.gateway;
  } else if (!has.includes("dhcp")) {
    if (has.length) throw new Error(`${backup} already has an address`);
    set(["interfaces", "ethernet", backup, "address"], "dhcp");
  }
  if (!bCfg?.description) set(["interfaces", "ethernet", backup, "description"], BACKUP_IF_DESC);

  // keep the internet out of the router on the backup line too
  const fw = cfg?.firewall || {};
  for (const fam of ["ipv4", "ipv6"]) {
    if (wanBlocked(fw[fam]?.input?.filter, backup)) continue;
    const b = ["firewall", fam, "input", "filter", "rule", BLOCK_RULE];
    if (fam === "ipv6") {
      const d = ["firewall", "ipv6", "input", "filter", "rule", DHCP6_RULE];
      set([...d, "action"], "accept");
      set([...d, "inbound-interface", "name"], backup);
      set([...d, "protocol"], "udp");
      set([...d, "destination", "port"], "546");
      set([...d, "description"], "VyGi: DHCPv6 on the backup internet");
    }
    set([...b, "action"], "drop");
    set([...b, "inbound-interface", "name"], backup);
    set([...b, "state"], "new");
    set([...b, "description"], BLOCK_DESC);
  }

  // load balancing in failover mode
  if (cfg?.["load-balancing"]?.wan) cmds.push({ op: "delete", path: LB });
  for (const [n, net] of LOCAL) {
    set([...LB, "rule", n, "exclude"]);
    set([...LB, "rule", n, "inbound-interface"], "any");
    set([...LB, "rule", n, "destination", "address"], net);
    set([...LB, "rule", n, "description"], `${FAILOVER_DESC} (keep local traffic local)`);
  }
  for (const [iface, nh, target] of [[wan, mainNh, CHECK.main], [backup, backupNh, CHECK.backup]]) {
    set([...LB, "interface-health", iface, "nexthop"], nh);
    set([...LB, "interface-health", iface, "failure-count"], "3");
    set([...LB, "interface-health", iface, "success-count"], "3");
    set([...LB, "interface-health", iface, "test", "10", "type"], "ping");
    set([...LB, "interface-health", iface, "test", "10", "target"], target);
  }
  set([...LB, "rule", "10", "failover"]);
  set([...LB, "rule", "10", "inbound-interface"], "any");
  set([...LB, "rule", "10", "description"], FAILOVER_DESC);
  set([...LB, "rule", "10", "interface", wan, "weight"], "10");
  set([...LB, "rule", "10", "interface", backup, "weight"], "1");
  set([...LB, "enable-local-traffic"]);
  set([...LB, "flush-connections"]);
  return cmds;
}

/** Removes VyGi's failover and its firewall rules; the backup port keeps its address unless VyGi named it. */
export function failoverOff(cfg) {
  if (failoverStatus(cfg) !== "on") return [];
  const cmds = [{ op: "delete", path: LB }];
  const lines = failoverLines(cfg);
  for (const fam of ["ipv4", "ipv6"]) {
    for (const [n, r] of Object.entries(cfg?.firewall?.[fam]?.input?.filter?.rule || {})) {
      if (r?.description === BLOCK_DESC || r?.description === "VyGi: DHCPv6 on the backup internet") cmds.push({ op: "delete", path: ["firewall", fam, "input", "filter", "rule", n] });
    }
  }
  const b = lines?.backup && cfg?.interfaces?.ethernet?.[lines.backup];
  if (b?.description === BACKUP_IF_DESC) {
    cmds.push({ op: "delete", path: ["interfaces", "ethernet", lines.backup, "address"] });
    cmds.push({ op: "delete", path: ["interfaces", "ethernet", lines.backup, "description"] });
  }
  return cmds;
}

/** `show wan-load-balance` -> [{ iface, up, failures }]. */
export function parseLbStatus(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^\s*([A-Za-z ]+):\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "Interface") out.push((cur = { iface: v.trim(), up: false, failures: 0 }));
    else if (cur && k === "Status") cur.up = /active|up/i.test(v);
    else if (cur && k === "Interface Failures") cur.failures = Number(v) || 0;
  }
  return out;
}
