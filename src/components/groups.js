// Device groups dialogs (Clients page): list, create, edit, delete, and a
// shared device list for the pages that pick devices.
import { api, errorText } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { modal, formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges, onSessionChange } from "../lib/session.js";
import { collectClients, networksFromConfig } from "../lib/netdata.js";
import { readGroups, groupCommands, deleteGroupCommands, groupQueueCommands, groupUsers } from "../lib/devgroups.js";
import { parseRate } from "../lib/queues.js";
import { simulate } from "../lib/doctor.js";

const MAC_IN = /([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s*$/i;

// The device list is slow to build (several router calls); reuse it for a minute.
let clientCache = { at: 0, clients: null };
export async function deviceList() {
  if (clientCache.clients && Date.now() - clientCache.at < 60_000) return clientCache.clients;
  const { clients } = await collectClients().catch(() => ({ clients: [] }));
  clientCache = { at: Date.now(), clients };
  return clients;
}
onSessionChange((s) => {
  if (!s.info) clientCache = { at: 0, clients: null };
});

/** Checkbox labels "Name — mac" for local devices, plus `keep` MACs not seen now. */
export function deviceOptions(clients, keep = []) {
  const opts = clients.filter((c) => c.mac && c.kind !== "vpn").map((c) => `${c.label} — ${c.mac}`);
  for (const m of keep) if (!clients.some((c) => c.mac === m)) opts.push(`(not seen now) — ${m}`);
  return opts;
}
export const macOf = (opt) => opt.match(MAC_IN)?.[1]?.toLowerCase();

const kbitText = (k) => (k ? `${k >= 1000 ? `${+(k / 1000).toFixed(1)} Mbit/s` : `${k} kbit/s`}` : "");
export const limitText = (l) => (l ? [l.downKbit ? `↓ ${kbitText(l.downKbit)}` : "", l.upKbit ? `↑ ${kbitText(l.upKbit)}` : ""].filter(Boolean).join(" ") + " each" : "");

/** Applies a group change plus the speed limits that follow from it. Returns the members without a fixed IP. */
async function save(cfg, spec, existing, clients) {
  const { id, cmds } = groupCommands(cfg, spec, existing);
  const after = simulate(cfg, cmds);
  const g = readGroups(after).find((x) => x.id === id);
  const names = new Map(clients.filter((c) => c.mac).map((c) => [c.mac, c.label]));
  const nets = networksFromConfig(cfg.interfaces || {}).filter((n) => !n.vpn).map((n) => ({ iface: n.iface, cidr: n.cidr }));
  const q = groupQueueCommands(after, g, nets, names);
  const all = [...cmds, ...q.cmds];
  if (all.length) await applyChanges(all, existing ? `group ${g.name}` : `new group ${g.name}`);
  return spec.limit ? q.skipped : [];
}

/** Create (g = null) or edit a group. preset: { macs }. Resolves true when applied. */
export async function editGroup(g = null, preset = {}) {
  let cfg;
  let clients;
  try {
    [cfg, clients] = await Promise.all([api.getConfig([]).then((c) => c || {}), deviceList()]);
  } catch (e) {
    alertBox("Device groups", errorText(e));
    return false;
  }
  if (g) g = readGroups(cfg).find((x) => x.id === g.id) || g;
  const members = g?.macs || preset.macs || [];
  const opts = deviceOptions(clients, members);
  let skipped = null;
  let deleted = false;
  await formDialog(g ? `Group: ${g.name}` : "New device group", [
    { name: "name", label: "Name", value: g?.name || "", placeholder: "e.g. Kids, Smart TVs, Work laptops" },
    { name: "devices", label: "Devices", type: "multicheck", value: opts.filter((o) => members.includes(macOf(o))), options: opts, hint: "Matched by MAC address. Phones with private (random) MAC addresses may change it per network." },
    { name: "down", label: "Download limit per device", value: g?.limit?.downKbit ? String(g.limit.downKbit / 1000) : "", placeholder: "Mbit/s, empty = no limit" },
    { name: "up", label: "Upload limit per device", value: g?.limit?.upKbit ? String(g.limit.upKbit / 1000) : "", placeholder: "Mbit/s, empty = no limit", hint: "Speed limits need each device to have a fixed IP (Clients → Fix IP)." },
  ], async (v) => {
    const down = v.down.trim() ? parseRate(v.down) : null;
    const up = v.up.trim() ? parseRate(v.up) : null;
    if (v.down.trim() && !down) throw new Error("Download limit: a number in Mbit/s, e.g. 10");
    if (v.up.trim() && !up) throw new Error("Upload limit: a number in Mbit/s, e.g. 5");
    skipped = await save(cfg, { name: v.name, macs: v.devices.map(macOf).filter(Boolean), limit: down || up ? { downKbit: down, upKbit: up } : null }, g, clients);
    return true;
  }, {
    okLabel: g ? "Apply" : "Create",
    extra: g ? { label: "Delete group", onClick: async () => (deleted = await removeGroup(g, cfg)) } : null,
  });
  if (skipped?.length) {
    const label = (m) => clients.find((c) => c.mac === m)?.label || m;
    alertBox("Speed limits", `These devices have no fixed IP, so the speed limit doesn't apply to them yet: ${skipped.map(label).join(", ")}.\n\nGive them a fixed IP on the Clients page (Fix IP), then open the group and press Apply.`);
  }
  return skipped !== null || deleted;
}

/** Resolves true when the group was deleted. */
async function removeGroup(g, cfg) {
  const users = groupUsers(cfg, g);
  if (users.length) return !(await alertBox("Delete group", `${g.name} is used by ${users.map((u) => (u.kind === "rule" ? `the rule "${u.name}"` : "a VPN client")).join(", ")}. Change those first.`));
  if (!(await confirmBox("Delete group", `Delete the group "${g.name}"? Its devices stay as they are${g.limit ? "; their group speed limits are removed" : ""}.`, "Delete"))) return false;
  try {
    const nets = networksFromConfig(cfg.interfaces || {}).filter((n) => !n.vpn).map((n) => ({ iface: n.iface, cidr: n.cidr }));
    const q = groupQueueCommands(cfg, { ...g, limit: null }, nets);
    await applyChanges([...q.cmds, ...deleteGroupCommands(simulate(cfg, q.cmds), g)], `delete group ${g.name}`);
    return true;
  } catch (e) {
    alertBox("Delete group", errorText(e));
    return false;
  }
}

/** The list of groups. onChange runs after any change. */
export async function openGroups(onChange = () => {}) {
  const list = h("div.token-list");
  let cfg = {};
  async function load() {
    try {
      cfg = (await api.getConfig([])) || {};
    } catch (e) {
      clear(list).append(h("div.err-box", errorText(e)));
      return;
    }
    const clients = await deviceList();
    const name = (m) => clients.find((c) => c.mac === m)?.label || m;
    const groups = readGroups(cfg);
    clear(list).append(groups.length
      ? h("table.grid", h("thead", h("tr", h("th", "Group"), h("th", "Devices"), h("th", "Speed limit"), h("th", "Used by"), h("th", ""))),
          h("tbody", groups.map((g) => h("tr",
            h("td", g.name),
            h("td", { title: g.macs.map(name).join("\n") }, `${g.macs.length}: ${g.macs.slice(0, 3).map(name).join(", ")}${g.macs.length > 3 ? ", …" : ""}`),
            h("td", limitText(g.limit) || "–"),
            h("td", groupUsers(cfg, g).map((u) => u.name).join(", ") || "–"),
            h("td", h("button", { on: { click: async () => {
              if (await editGroup(g)) {
                onChange();
                load();
              }
            } } }, "Edit"))))))
      : h("div.hint", { style: { padding: "8px 0" } }, "No groups yet. A group (e.g. Kids) can be used in Traffic Rules, the VPN client and speed limits, and follows its devices: add a device to the group and every rule applies to it."));
  }
  load();
  await modal("Device groups", h("div", { style: { width: "640px" } }, list,
    h("div", { style: { marginTop: "10px" } }, h("button.primary", { on: { click: async () => {
      if (await editGroup()) {
        onChange();
        load();
      }
    } } }, "New group"))),
  [{ label: "Close", value: "ok", primary: true }]);
}

/** Which groups one device is in (Clients page). Resolves true when changed. */
export async function editDeviceGroups(mac, label) {
  let cfg;
  let clients;
  try {
    [cfg, clients] = await Promise.all([api.getConfig([]).then((c) => c || {}), deviceList()]);
  } catch (e) {
    alertBox("Groups", errorText(e));
    return false;
  }
  const groups = readGroups(cfg);
  if (!groups.length) return editGroup(null, { macs: [mac] });
  let changed = false;
  await formDialog(`Groups for ${label}`, [
    { name: "groups", label: "Groups", type: "multicheck", value: groups.filter((g) => g.macs.includes(mac)).map((g) => g.name), options: groups.map((g) => g.name) },
  ], async (v) => {
    const cmds = [];
    let cur = cfg;
    for (const g of groups) {
      const want = v.groups.includes(g.name);
      if (want === g.macs.includes(mac)) continue;
      const macs = want ? [...g.macs, mac] : g.macs.filter((m) => m !== mac);
      const { cmds: gc } = groupCommands(cur, { name: g.name, macs, limit: g.limit }, g);
      const after = simulate(cur, gc);
      const nets = networksFromConfig(cfg.interfaces || {}).filter((n) => !n.vpn).map((n) => ({ iface: n.iface, cidr: n.cidr }));
      const names = new Map(clients.filter((c) => c.mac).map((c) => [c.mac, c.label]));
      const q = groupQueueCommands(after, readGroups(after).find((x) => x.id === g.id), nets, names);
      cmds.push(...gc, ...q.cmds);
      cur = simulate(after, q.cmds);
    }
    if (cmds.length) await applyChanges(cmds, `groups of ${label}`);
    changed = cmds.length > 0;
    return true;
  }, { okLabel: "Apply" });
  return changed;
}
