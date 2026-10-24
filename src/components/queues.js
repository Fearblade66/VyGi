// Queues > Simple Queues: per-device download/upload limits, like Winbox Simple Queues.
//
// VyOS has no "simple queue", so each LAN interface gets two policies VyGi owns:
//   download = shaper VYGI-DOWN-<if> on the LAN egress  (match destination = device)
//   upload   = limiter VYGI-UP-<if> on the LAN ingress  (match source = device)
// A device uses the same class number in both, which is how rows are paired.
import { api, errorText } from "../lib/api.js";
import { h, setStatus, formatBits } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { makeTable, filterBox } from "../lib/table.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges } from "../lib/session.js";
import { ipv4InCidr } from "../lib/vyos.js";
import { networksFromConfig } from "../lib/netdata.js";

const DOWN = (ifname) => `VYGI-DOWN-${ifname}`;
const UP = (ifname) => `VYGI-UP-${ifname}`;
const MATCH = "device";
/** Link speed used as the shaper's total; default/other traffic may use all of it. */
const LINK_SPEED = "1gbit";
const FIRST_CLASS = 10;

/** "10" / "10M" / "500k" / "1.5m" -> kbit (number), or null. Plain numbers are Mbit/s. */
export function parseRate(text) {
  const m = String(text ?? "").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([kmg]?)(?:bit|bps|b)?(?:\/s)?$/);
  if (!m) return null;
  const mult = { k: 1, "": 1000, m: 1000, g: 1_000_000 }[m[2]];
  const kbit = Math.round(Number(m[1]) * mult);
  return kbit > 0 ? kbit : null;
}

/** VyOS bandwidth value ("2mbit", "512kbit", "10gbit") -> bits/s. */
export function rateToBits(v) {
  const m = String(v ?? "").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)(bit|bps)?$/);
  if (!m) return NaN;
  const mult = { "": 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[m[2]];
  return Number(m[1]) * mult * (m[3] === "bps" ? 8 : 1);
}

const host = (addr) => String(addr || "").replace(/\/32$/, "");

/** Reads VyGi's queues out of the `qos` config subtree. */
export function parseQueues(qos) {
  const rows = new Map();
  const policy = qos?.policy || {};
  const pick = (kind, prefix, dir, field) => {
    for (const [name, p] of Object.entries(policy[kind] || {})) {
      if (!name.startsWith(prefix)) continue;
      const ifname = name.slice(prefix.length);
      for (const [id, c] of Object.entries(p?.class || {})) {
        const ip = host(c?.match?.[MATCH]?.ip?.[dir]?.address);
        const key = `${ifname}|${id}`;
        const row = rows.get(key) || { key, ifname, id: Number(id), name: "", ip: "", down: "", up: "" };
        row.name = row.name || c?.description || "";
        row.ip = row.ip || ip;
        row[field] = c?.bandwidth || "";
        rows.set(key, row);
      }
    }
  };
  pick("shaper", "VYGI-DOWN-", "destination", "down");
  pick("limiter", "VYGI-UP-", "source", "up");
  return [...rows.values()].sort((a, b) => a.ifname.localeCompare(b.ifname) || a.id - b.id);
}

const shaperBase = (ifname) => ["qos", "policy", "shaper", DOWN(ifname)];
const limiterBase = (ifname) => ["qos", "policy", "limiter", UP(ifname)];

/**
 * Commands to add or replace one queue. `q` = { ifname, id, name, ip, downKbit, upKbit }
 * (either limit may be null = unlimited in that direction).
 */
export function queueCommands(qos, q, old = null) {
  const cmds = [];
  const set = (path) => cmds.push({ op: "set", path });
  const policy = qos?.policy || {};
  const binding = qos?.interface?.[q.ifname] || {};
  const rows = parseQueues(qos);

  if (old) cmds.push(...removeQueueCommands(qos, old, { keepPolicies: old.ifname === q.ifname }));
  const remaining = rows.filter((r) => !old || r.key !== old.key);

  if (q.downKbit) {
    if (binding.egress && binding.egress !== DOWN(q.ifname)) throw new Error(`${q.ifname} already uses QoS policy "${binding.egress}" for outgoing traffic. Remove it first (System > Full Configuration > qos).`);
    const base = shaperBase(q.ifname);
    const exists = policy.shaper?.[DOWN(q.ifname)] && remaining.some((r) => r.ifname === q.ifname && r.down);
    if (!exists) {
      set([...base, "description", "Managed by VyGi (Simple Queues)"]);
      set([...base, "bandwidth", LINK_SPEED]);
      set([...base, "default", "bandwidth", "10%"]);
      set([...base, "default", "ceiling", "100%"]);
      set(["qos", "interface", q.ifname, "egress", DOWN(q.ifname)]);
    }
    const c = [...base, "class", String(q.id)];
    set([...c, "bandwidth", `${q.downKbit}kbit`]);
    set([...c, "ceiling", `${q.downKbit}kbit`]);
    if (q.name) set([...c, "description", q.name]);
    set([...c, "match", MATCH, "ip", "destination", "address", `${q.ip}/32`]);
  }
  if (q.upKbit) {
    if (binding.ingress && binding.ingress !== UP(q.ifname)) throw new Error(`${q.ifname} already uses QoS policy "${binding.ingress}" for incoming traffic. Remove it first.`);
    const base = limiterBase(q.ifname);
    const exists = policy.limiter?.[UP(q.ifname)] && remaining.some((r) => r.ifname === q.ifname && r.up);
    if (!exists) {
      set([...base, "description", "Managed by VyGi (Simple Queues)"]);
      set([...base, "default", "bandwidth", "10gbit"]); // effectively unlimited for everyone else
      set(["qos", "interface", q.ifname, "ingress", UP(q.ifname)]);
    }
    const c = [...base, "class", String(q.id)];
    set([...c, "bandwidth", `${q.upKbit}kbit`]);
    if (q.name) set([...c, "description", q.name]);
    set([...c, "match", MATCH, "ip", "source", "address", `${q.ip}/32`]);
  }
  // A direction that is no longer used on this interface (edit removed its last limit).
  if (old && old.ifname === q.ifname) {
    const others = remaining.filter((r) => r.ifname === q.ifname);
    if (old.down && !q.downKbit && !others.some((r) => r.down)) cmds.push(...dropPolicy("egress", q.ifname));
    if (old.up && !q.upKbit && !others.some((r) => r.up)) cmds.push(...dropPolicy("ingress", q.ifname));
  }
  return tidy(qos, cmds);
}

/** After deletes, removes binding/policy containers left empty (VyOS keeps empty nodes). */
function tidy(qos, cmds) {
  const deleted = (path) => cmds.some((c) => c.op === "delete" && path.join("\0").startsWith(c.path.join("\0")));
  const sets = (prefix) => cmds.some((c) => c.op === "set" && c.path.join("\0").startsWith(prefix.join("\0")));
  const extra = [];
  for (const [ifname, b] of Object.entries(qos?.interface || {})) {
    const dirs = Object.keys(b || {});
    const path = ["qos", "interface", ifname];
    if (dirs.length && dirs.every((d) => deleted([...path, d])) && !sets(path)) extra.push({ op: "delete", path });
  }
  const policies = Object.entries(qos?.policy || {}).flatMap(([kind, ps]) => Object.keys(ps || {}).map((n) => ["qos", "policy", kind, n]));
  const ifaces = Object.keys(qos?.interface || {}).map((i) => ["qos", "interface", i]);
  const top = Object.keys(qos || {}).filter((k) => k !== "policy" && k !== "interface");
  const all = [...policies, ...ifaces];
  if (all.length && !top.length && all.every((p) => deleted(p) || extra.some((e) => e.path.join("\0") === p.join("\0"))) && !sets(["qos"])) {
    return [{ op: "delete", path: ["qos"] }];
  }
  return [...cmds, ...extra];
}

function dropPolicy(dir, ifname) {
  return dir === "egress"
    ? [{ op: "delete", path: ["qos", "interface", ifname, "egress"] }, { op: "delete", path: shaperBase(ifname) }]
    : [{ op: "delete", path: ["qos", "interface", ifname, "ingress"] }, { op: "delete", path: limiterBase(ifname) }];
}

/**
 * Commands to delete one queue. When it was the last one on the interface in a
 * direction, the whole policy and its binding go too (an empty shaper is invalid).
 * keepPolicies: used by edit, which re-adds a class right after.
 */
export function removeQueueCommands(qos, row, { keepPolicies = false } = {}) {
  const others = parseQueues(qos).filter((r) => r.ifname === row.ifname && r.key !== row.key);
  const cmds = [];
  if (row.down) {
    if (others.some((r) => r.down) || keepPolicies) cmds.push({ op: "delete", path: [...shaperBase(row.ifname), "class", String(row.id)] });
    else cmds.push(...dropPolicy("egress", row.ifname));
  }
  if (row.up) {
    if (others.some((r) => r.up) || keepPolicies) cmds.push({ op: "delete", path: [...limiterBase(row.ifname), "class", String(row.id)] });
    else cmds.push(...dropPolicy("ingress", row.ifname));
  }
  return keepPolicies ? cmds : tidy(qos, cmds);
}

/** Lowest free class number on an interface (shared by both policies). */
export function nextClassId(qos, ifname) {
  const used = new Set();
  for (const kind of ["shaper", "limiter"]) {
    const name = kind === "shaper" ? DOWN(ifname) : UP(ifname);
    for (const id of Object.keys(qos?.policy?.[kind]?.[name]?.class || {})) used.add(Number(id));
  }
  let id = FIRST_CLASS;
  while (used.has(id)) id++;
  if (id > 4090) throw new Error("Too many queues on this interface");
  return id;
}

const fmtLimit = (v) => (v ? formatBits(rateToBits(v)) : "unlimited");

async function loadState() {
  const [qos, ifaces] = await Promise.all([
    api.getConfig(["qos"]).catch(() => ({})),
    api.getConfig(["interfaces"]).catch(() => ({})),
  ]);
  return { qos: qos || {}, nets: networksFromConfig(ifaces).filter((n) => !n.vpn) };
}

/**
 * Add/edit dialog. `preset` = { ip, name } from the Clients view, or an existing row.
 * Resolves true when something was applied.
 */
export async function editQueue(preset = {}, existing = null) {
  let st;
  try {
    st = await loadState();
  } catch (e) {
    return alertBox("Simple Queues", errorText(e));
  }
  const fromIp = existing || parseQueues(st.qos).find((r) => preset.ip && r.ip === preset.ip) || null;
  const toMbit = (v) => (v ? String(+(rateToBits(v) / 1e6).toFixed(3)) : "");
  let applied = false;
  await formDialog(fromIp ? `Queue: ${fromIp.name || fromIp.ip}` : "New Simple Queue", [
    { name: "name", label: "Name", value: fromIp?.name || preset.name || "", placeholder: "e.g. Kids' tablet" },
    { name: "ip", label: "Target address", value: fromIp?.ip || preset.ip || "", placeholder: "192.168.1.50", hint: "One IPv4 device on a LAN. Give it a fixed IP (Clients > Fix IP) or the limit stops matching when its address changes." },
    { name: "down", label: "Max download", value: toMbit(fromIp?.down), placeholder: "Mbit/s, e.g. 20 (empty = unlimited)" },
    { name: "up", label: "Max upload", value: toMbit(fromIp?.up), placeholder: "Mbit/s, e.g. 5 (empty = unlimited)", hint: "Numbers are Mbit/s; 500k = 500 kbit/s. IPv6 traffic from the device is not limited." },
  ], async (v) => {
    const ip = v.ip.trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || ip.split(".").some((o) => Number(o) > 255)) throw new Error("Target must be an IPv4 address");
    const net = st.nets.find((n) => ipv4InCidr(ip, n.cidr));
    if (!net) throw new Error(`${ip} is not on any of the router's LAN networks`);
    if (net.routerIp === ip) throw new Error("That is the router's own address");
    const downKbit = v.down.trim() ? parseRate(v.down) : null;
    const upKbit = v.up.trim() ? parseRate(v.up) : null;
    if (v.down.trim() && !downKbit) throw new Error("Max download: enter a number of Mbit/s, e.g. 20 or 500k");
    if (v.up.trim() && !upKbit) throw new Error("Max upload: enter a number of Mbit/s, e.g. 5 or 500k");
    if (!downKbit && !upKbit) throw new Error("Set a download or upload limit (or delete the queue)");
    const clash = parseQueues(st.qos).find((r) => r.ip === ip && r.key !== fromIp?.key);
    if (clash) throw new Error(`${ip} already has a queue (${clash.name || clash.key})`);
    const name = v.name.trim().replace(/['"\n]/g, "").slice(0, 60);
    const id = fromIp && fromIp.ifname === net.iface ? fromIp.id : nextClassId(st.qos, net.iface);
    const cmds = queueCommands(st.qos, { ifname: net.iface, id, name, ip, downKbit, upKbit }, fromIp);
    await applyChanges(cmds, `queue for ${name || ip}`);
    applied = true;
    return true;
  }, { okLabel: "Apply" });
  return applied;
}

export function openQueues() {
  const win = openWindow({ key: "queues", title: "Simple Queues", width: 760, height: 360 });
  if (!win.isNew) return;
  let qos = {};
  const table = makeTable(
    [
      { key: "name", label: "Name", width: "170px" },
      { key: "ip", label: "Target", width: "120px" },
      { key: "ifname", label: "Interface", width: "80px" },
      { key: "downText", label: "Max Download", width: "110px", className: "num" },
      { key: "upText", label: "Max Upload", width: "110px", className: "num" },
      { key: "id", label: "#", className: "num" },
    ],
    { rowKey: (r) => r.key, onOpen: (r) => edit(r) },
  );
  const note = h("span.hint", "Speed limit per device. Download is shaped on the LAN port, upload is policed as it arrives.");
  win.body.append(
    h("div.win-toolbar",
      h("button.icon-add", { title: "New queue", on: { click: () => edit(null) } }, "+"),
      h("button.icon-remove", { title: "Delete queue", on: { click: remove } }, "−"),
      h("button", { on: { click: () => { const r = table.selected(); r ? edit(r) : setStatus("Select a queue first.", true); } } }, "Edit"),
      h("button", { on: { click: load } }, "⟳"),
      note, h("span.grow"), filterBox(table)),
    table.wrap, table.count,
  );

  async function load() {
    try {
      qos = (await api.getConfig(["qos"])) || {};
    } catch (e) {
      return setStatus(errorText(e), true);
    }
    table.setRows(parseQueues(qos).map((r) => ({ ...r, name: r.name || "(unnamed)", downText: fmtLimit(r.down), upText: fmtLimit(r.up) })));
    const foreign = Object.entries(qos?.interface || {}).filter(([, b]) => [b?.egress, b?.ingress].some((p) => p && !/^VYGI-(DOWN|UP)-/.test(p)));
    if (foreign.length) note.textContent = `Other QoS policies are active on ${foreign.map(([i]) => i).join(", ")}; VyGi won't touch those interfaces.`;
  }

  async function edit(r) {
    const row = r ? parseQueues(qos).find((x) => x.key === r.key) : null;
    if (await editQueue({}, row)) load();
  }

  async function remove() {
    const r = table.selected();
    if (!r) return setStatus("Select a queue first.", true);
    if (!(await confirmBox("Delete queue", `Remove the speed limit for ${r.name} (${r.ip})?`, "Delete"))) return;
    const row = parseQueues(qos).find((x) => x.key === r.key);
    try {
      await applyChanges(removeQueueCommands(qos, row), `remove queue ${r.ip}`);
      load();
    } catch (e) {
      alertBox("Failed", errorText(e));
    }
  }

  load();
}
