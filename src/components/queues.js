// Queues > Simple Queues window: per-device download/upload limits (the
// commands come from lib/queues.js).
import { api, errorText } from "../lib/api.js";
import { h, setStatus, formatBits } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { makeTable, filterBox } from "../lib/table.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges } from "../lib/session.js";
import { ipv4InCidr } from "../lib/vyos.js";
import { networksFromConfig } from "../lib/netdata.js";
import { parseRate, rateToBits, parseQueues, queueCommands, removeQueueCommands, nextClassId } from "../lib/queues.js";

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
