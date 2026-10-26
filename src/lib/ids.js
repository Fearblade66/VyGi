// Intrusion detection (Settings > Security): Suricata in a container on the
// router, watching chosen ports, plus an address group for attackers that
// are blocked (by hand from an alert, or automatically by the 24/7 server).
// Pure: no API calls.
import { toArray } from "./vyos.js";

export const IMAGE = "docker.io/jasonish/suricata:8.0.6";
export const NAME = "vygi-ids";
export const BLOCK_GROUP = "VYGI-IDS-BLOCK";
const C = ["container", "name", NAME];
const G = ["firewall", "group", "address-group", BLOCK_GROUP];
const BLOCK_DESC = "VyGi: intrusion detection blocks";
const MEMORY_MB = "1024"; // VyOS gives containers 512 MB unless told otherwise; Suricata with the full free ruleset needs more

/** { on, ifaces[], manual, blockRules, blocked[] } */
export function readIds(cfg) {
  const c = cfg?.container?.name?.[NAME];
  const args = String(c?.arguments || "");
  const ifaces = [...args.matchAll(/-i\s+(\S+)/g)].map((m) => m[1]);
  const rules = ["forward", "input"].every((ch) => Object.values(cfg?.firewall?.ipv4?.[ch]?.filter?.rule || {}).some((r) => r?.description === BLOCK_DESC));
  return {
    on: !!c,
    ifaces,
    manual: !!c && c.image !== IMAGE && !String(c.image || "").startsWith("docker.io/jasonish/suricata"),
    blockRules: rules,
    blocked: toArray(cfg?.firewall?.group?.["address-group"]?.[BLOCK_GROUP]?.address),
  };
}

/** Commands to run Suricata on `ifaces` (none: remove it). */
export function idsCommands(cfg, ifaces) {
  const cur = readIds(cfg);
  if (!ifaces.length) return cur.on ? [{ op: "delete", path: C }] : [];
  for (const i of ifaces) if (!/^[a-z]+[0-9]+(\.\d+)?$/.test(i)) throw new Error(`Bad interface name ${i}`);
  const args = `${ifaces.map((i) => `-i ${i}`).join(" ")} --set stats.enabled=no`;
  const want = [
    { op: "set", path: [...C, "description"], value: "VyGi intrusion detection (Suricata)" },
    { op: "set", path: [...C, "image"], value: IMAGE },
    { op: "set", path: [...C, "allow-host-networks"] },
    { op: "set", path: [...C, "capability"], value: "net-admin" },
    { op: "set", path: [...C, "capability"], value: "net-raw" },
    { op: "set", path: [...C, "capability"], value: "sys-nice" },
    { op: "set", path: [...C, "memory"], value: MEMORY_MB },
    { op: "set", path: [...C, "volume", "logs", "source"], value: "/config/vygi-ids/log" },
    { op: "set", path: [...C, "volume", "logs", "destination"], value: "/var/log/suricata" },
    { op: "set", path: [...C, "volume", "lib", "source"], value: "/config/vygi-ids/lib" },
    { op: "set", path: [...C, "volume", "lib", "destination"], value: "/var/lib/suricata" },
    // VyOS passes arguments only together with a command
    { op: "set", path: [...C, "command"], value: "suricata" },
    { op: "set", path: [...C, "arguments"], value: args },
  ];
  if (!cur.on) return want;
  // already there: only the interfaces change
  return String(cfg.container.name[NAME].arguments || "") === args ? [] : [{ op: "set", path: [...C, "arguments"], value: args }];
}

const freeRule = (rules) => {
  for (let n = 1; n <= 99; n++) if (!rules?.[n]) return String(n);
  throw new Error("No free firewall rule numbers left between 1 and 99");
};

/** The group and the rules that drop traffic from it (to the router and through it). */
export function blockSetupCommands(cfg) {
  const cmds = [];
  if (!cfg?.firewall?.group?.["address-group"]?.[BLOCK_GROUP]) cmds.push({ op: "set", path: [...G, "description"], value: "VyGi: addresses blocked after an attack" });
  for (const ch of ["forward", "input"]) {
    const rules = cfg?.firewall?.ipv4?.[ch]?.filter?.rule || {};
    if (Object.values(rules).some((r) => r?.description === BLOCK_DESC)) continue;
    const b = ["firewall", "ipv4", ch, "filter", "rule", freeRule(rules)];
    cmds.push(
      { op: "set", path: [...b, "action"], value: "drop" },
      { op: "set", path: [...b, "source", "group", "address-group"], value: BLOCK_GROUP },
      { op: "set", path: [...b, "log"] },
      { op: "set", path: [...b, "description"], value: BLOCK_DESC },
    );
  }
  return cmds;
}

/** Block an internet address (by hand, from an alert). Only public IPv4 addresses. */
export function blockCommands(cfg, ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error("Only IPv4 addresses can be blocked here");
  const [a, b] = ip.split(".").map(Number);
  if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) {
    throw new Error("That's a local address: block a device on the Clients page instead");
  }
  if (readIds(cfg).blocked.includes(ip)) return [];
  return [...blockSetupCommands(cfg), { op: "set", path: [...G, "address"], value: ip }];
}

export const unblockCommands = (ip) => [{ op: "delete", path: [...G, "address"], value: ip }];

/** "ET SCAN …" -> a plain category for the list. */
export function severityText(priority) {
  return { 1: "serious", 2: "suspicious", 3: "unusual", 4: "info" }[priority] || "info";
}
