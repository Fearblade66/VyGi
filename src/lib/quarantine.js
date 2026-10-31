// New-device quarantine (Security > Protection): on chosen networks, a device
// whose MAC address isn't approved can reach the router (DHCP, DNS) but
// nothing else (no internet, no other networks) until it's approved on the
// Devices page. Approved devices are the firewall mac-group VYGI-KNOWN; each
// quarantined network has a drop rule in the IPv4 and IPv6 forward chains
// for MACs outside that group, described "VyGi quarantine (<iface>)".
// Devices on the same switch or Wi-Fi can still talk to each other directly:
// that traffic never passes the router. Pure: no API calls.
import { toArray } from "./vyos.js";

export const KNOWN = "VYGI-KNOWN";
const GROUP = ["firewall", "group", "mac-group", KNOWN];
const DESC = "VyGi quarantine";
const RE = /^VyGi quarantine \((.+)\)$/;
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const FAMS = ["ipv4", "ipv6"];

const fwd = (cfg, fam) => cfg?.firewall?.[fam]?.forward?.filter?.rule || {};

/** { ifaces[], known[], rules: [{ fam, n, iface }] } */
export function readQuarantine(cfg) {
  const rules = [];
  for (const fam of FAMS) {
    for (const [n, r] of Object.entries(fwd(cfg, fam))) {
      const m = String(r?.description || "").match(RE);
      if (m) rules.push({ fam, n, iface: m[1] });
    }
  }
  return {
    ifaces: [...new Set(rules.map((r) => r.iface))].sort(),
    known: toArray(cfg?.firewall?.group?.["mac-group"]?.[KNOWN]?.["mac-address"]).map((m) => String(m).toLowerCase()),
    rules,
  };
}

/** Is this device held back? (on a quarantined network, not approved) */
export function isQuarantined(q, mac, iface) {
  if (!mac || !iface || !q.ifaces.length) return false;
  return q.ifaces.includes(iface) && !q.known.includes(String(mac).toLowerCase());
}

const cleanMacs = (macs) => [...new Set(toArray(macs).map((m) => String(m).trim().toLowerCase()).filter((m) => MAC_RE.test(m)))].sort();

/**
 * Commands to quarantine new devices on exactly `ifaces` (empty: off).
 * `approve`: devices to approve at the same time (when turning it on: every
 * device the router knows now, so nothing that already works is cut off).
 */
export function quarantineCommands(cfg, ifaces, approve = []) {
  for (const i of ifaces) if (!/^[a-z]+[0-9]+(\.\d+)?$/.test(i)) throw new Error(`Bad interface name ${i}`);
  const cur = readQuarantine(cfg);
  const want = [...new Set(ifaces)].sort();
  const cmds = [];
  // the approved list is kept when quarantine is turned off, so turning it on again doesn't lock anyone out
  const add = cleanMacs(approve).filter((m) => !cur.known.includes(m));
  if (want.length && !cur.known.length && !add.length) {
    throw new Error("No devices to approve: with an empty list, every device on those networks would lose its connection. Open the Devices page once so VyGi sees your devices, then try again.");
  }
  if (!cfg?.firewall?.group?.["mac-group"]?.[KNOWN] && (want.length || add.length)) {
    cmds.push({ op: "set", path: [...GROUP, "description"], value: "VyGi: approved devices (new-device quarantine)" });
  }
  for (const m of add) cmds.push({ op: "set", path: [...GROUP, "mac-address"], value: m });
  for (const r of cur.rules) {
    if (!want.includes(r.iface)) cmds.push({ op: "delete", path: ["firewall", r.fam, "forward", "filter", "rule", r.n] });
  }
  for (const fam of FAMS) {
    const used = new Set(Object.keys(fwd(cfg, fam)).map(Number));
    for (const iface of want) {
      if (cur.rules.some((r) => r.fam === fam && r.iface === iface)) continue;
      let n = 1;
      while (used.has(n) && n <= 99) n++;
      if (n > 99) throw new Error(`No free ${fam} forward rule numbers between 1 and 99`);
      used.add(n);
      const b = ["firewall", fam, "forward", "filter", "rule", String(n)];
      cmds.push(
        { op: "set", path: [...b, "action"], value: "drop" },
        { op: "set", path: [...b, "inbound-interface", "name"], value: iface },
        { op: "set", path: [...b, "source", "group", "mac-group"], value: `!${KNOWN}` },
        { op: "set", path: [...b, "description"], value: `${DESC} (${iface})` },
      );
    }
  }
  return cmds;
}

/** Let a quarantined device out. */
export function approveCommands(cfg, mac) {
  const m = cleanMacs([mac])[0];
  if (!m) throw new Error("This device has no MAC address to approve");
  if (readQuarantine(cfg).known.includes(m)) return [];
  return [{ op: "set", path: [...GROUP, "mac-address"], value: m }];
}

/** Put an approved device back into quarantine. The last approved device can't be removed (the group can't be empty). */
export function revokeCommands(cfg, mac) {
  const m = String(mac).toLowerCase();
  const q = readQuarantine(cfg);
  if (!q.known.includes(m)) return [];
  if (q.known.length === 1) throw new Error("This is the last approved device; at least one has to stay approved");
  return [{ op: "delete", path: [...GROUP, "mac-address", m] }];
}
