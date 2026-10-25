// Device groups (UniFi-style): named sets of devices, used by Traffic Rules,
// the VPN client's routing and speed limits. Each group is a firewall
// mac-group VYGI-G<id> on the router, described "VyGi group: <name>", so a
// rule that names the group follows its members automatically.
// A group speed limit gives every member with a fixed IP its own limit
// (Simple Queues match IP addresses; VyOS's MAC matching for queues isn't
// reliable), described "G<id> <group>: <device>".
// Pure: no API calls.
import { toArray, ipv4InCidr } from "./vyos.js";
import { parseQueues, queueCommands, removeQueueCommands, nextClassId } from "./queues.js";
import { simulate } from "./doctor.js";

const GROUP = ["firewall", "group", "mac-group"];
const DESC = /^VyGi group: (.*?)(?: \[limit (\d*)\/(\d*) kbit\])?$/;
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
export const gname = (id) => `VYGI-G${id}`;

/** [{ id, gname, name, macs, limit: { downKbit, upKbit } | null }] */
export function readGroups(cfg) {
  const out = [];
  for (const [g, c] of Object.entries(cfg?.firewall?.group?.["mac-group"] || {})) {
    const id = g.match(/^VYGI-G(\d+)$/)?.[1];
    const m = String(c?.description || "").match(DESC);
    if (!id || !m) continue;
    const down = Number(m[2]) || 0;
    const up = Number(m[3]) || 0;
    out.push({
      id, gname: g, name: m[1],
      macs: toArray(c?.["mac-address"]).map((x) => x.toLowerCase()),
      limit: down || up ? { downKbit: down || null, upKbit: up || null } : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Groups a device is in. */
export const groupsOf = (groups, mac) => groups.filter((g) => g.macs.includes(String(mac).toLowerCase()));

/** Where a group is used: [{ kind: "rule"|"vpn", name }]. */
export function groupUsers(cfg, g) {
  const users = [];
  for (const r of Object.values(cfg?.firewall?.ipv4?.forward?.filter?.rule || {})) {
    if (r?.source?.group?.["mac-group"] === g.gname) users.push({ kind: "rule", name: String(r.description || "").replace(/^VyGi rule \d+: /, "") });
  }
  for (const p of Object.values(cfg?.policy?.route || {})) {
    for (const r of Object.values(p?.rule || {})) if (r?.source?.group?.["mac-group"] === g.gname) users.push({ kind: "vpn", name: String(r.description || "VPN route") });
  }
  return users;
}

const descFor = (name, limit) => `VyGi group: ${name}${limit && (limit.downKbit || limit.upKbit) ? ` [limit ${limit.downKbit || ""}/${limit.upKbit || ""} kbit]` : ""}`;

/**
 * Commands to create (existing = null) or change a group. spec: { name, macs, limit: { downKbit, upKbit } | null }.
 * Members are changed one by one, so rules using the group keep working.
 */
export function groupCommands(cfg, spec, existing = null) {
  const name = String(spec.name || "").trim().replace(/['"[\]]/g, "");
  if (!name || name.length > 32) throw new Error("Give the group a name (up to 32 characters)");
  const groups = readGroups(cfg);
  if (groups.some((g) => g.name.toLowerCase() === name.toLowerCase() && g.id !== existing?.id)) throw new Error(`There's already a group called ${name}`);
  const macs = [...new Set((spec.macs || []).map((m) => String(m).toLowerCase()))];
  for (const m of macs) if (!MAC_RE.test(m)) throw new Error(`Bad MAC address ${m}`);
  // VyOS refuses an empty mac-group that a rule uses
  if (!macs.length && existing && groupUsers(cfg, existing).length) throw new Error("A group that rules use needs at least one device");
  if (!macs.length) throw new Error("Add at least one device");
  let id = existing?.id;
  if (!id) {
    const used = new Set(Object.keys(cfg?.firewall?.group?.["mac-group"] || {}));
    id = "1";
    while (used.has(gname(id))) id = String(Number(id) + 1);
  }
  const g = gname(id);
  const cmds = [];
  const have = existing?.macs || [];
  for (const m of macs) if (!have.includes(m)) cmds.push({ op: "set", path: [...GROUP, g, "mac-address"], value: m });
  for (const m of have) if (!macs.includes(m)) cmds.push({ op: "delete", path: [...GROUP, g, "mac-address", m] });
  const desc = descFor(name, spec.limit);
  if (!existing || cfg.firewall.group["mac-group"][g]?.description !== desc) cmds.push({ op: "set", path: [...GROUP, g, "description"], value: desc });
  return { id, cmds };
}

export function deleteGroupCommands(cfg, g) {
  const users = groupUsers(cfg, g);
  if (users.length) throw new Error(`${g.name} is used by ${users.map((u) => (u.kind === "rule" ? `the rule "${u.name}"` : "the VPN client")).join(", ")}. Change those first.`);
  return [{ op: "delete", path: [...GROUP, g.gname] }];
}

/** mac -> { ip, name } from DHCP fixed addresses. */
export function fixedIps(cfg) {
  const out = new Map();
  for (const net of Object.values(cfg?.service?.["dhcp-server"]?.["shared-network-name"] || {})) {
    for (const s of Object.values(net?.subnet || {})) {
      for (const [name, m] of Object.entries(s?.["static-mapping"] || {})) {
        const mac = String(m?.mac || m?.["mac-address"] || "").toLowerCase();
        const ip = m?.["ip-address"];
        if (mac && ip) out.set(mac, { ip, name });
      }
    }
  }
  return out;
}

/**
 * Commands that make the group's speed limits match its members: one queue
 * per member with a fixed IP. nets: [{ iface, cidr }] (LAN networks).
 * Returns { cmds, skipped: [mac] } (members without a fixed IP).
 */
export function groupQueueCommands(cfg, group, nets, names = new Map()) {
  let qos = structuredClone(cfg?.qos || {});
  const tag = `G${group.id} `;
  const fixed = fixedIps(cfg);
  const cmds = [];
  const skipped = [];
  const apply = (list) => {
    cmds.push(...list);
    qos = simulate({ qos }, list).qos || {};
  };
  const want = new Map(); // ip -> label
  if (group.limit) {
    for (const mac of group.macs) {
      const f = fixed.get(mac);
      if (!f) {
        skipped.push(mac);
        continue;
      }
      want.set(f.ip, `${tag}${group.name}: ${names.get(mac) || f.name}`.slice(0, 64));
    }
  }
  // drop this group's queues that no longer fit
  for (const row of parseQueues(qos)) {
    if (!row.name.startsWith(tag)) continue;
    const label = want.get(row.ip);
    const sameLimit = group.limit && row.down === (group.limit.downKbit ? `${group.limit.downKbit}kbit` : "") && row.up === (group.limit.upKbit ? `${group.limit.upKbit}kbit` : "");
    if (label && sameLimit && row.name === label) {
      want.delete(row.ip);
      continue;
    }
    apply(removeQueueCommands(qos, parseQueues(qos).find((r) => r.key === row.key)));
  }
  for (const [ip, label] of want) {
    const net = nets.find((n) => ipv4InCidr(ip, n.cidr));
    if (!net) continue;
    apply(queueCommands(qos, { ifname: net.iface, id: nextClassId(qos, net.iface), name: label, ip, downKbit: group.limit.downKbit, upKbit: group.limit.upKbit }));
  }
  return { cmds, skipped };
}
