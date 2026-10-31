// Security > Protection: new-device quarantine, threat-intelligence
// blocklists, honeypot ports and encrypted DNS for the router.
import { errorText } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges } from "../lib/session.js";
import { readNetworks } from "../lib/netplan.js";
import { collectClients } from "../lib/netdata.js";
import { readGroups } from "../lib/devgroups.js";
import { readQuarantine, quarantineCommands, approveCommands, isQuarantined } from "../lib/quarantine.js";

export const row = (title, hint, ctl) => h("div.set-row", h("div.set-text", h("div.set-title", title), hint ? h("div.hint", hint) : null), ctl ? h("div.set-ctl", ctl) : null);
const cancelled = (e) => /^Cancelled/.test(e?.message || "");

/** Runs `cmds` (or a function returning them) through Safe Mode, then reloads the page. */
export async function apply(title, cmds, what, reload) {
  try {
    const list = typeof cmds === "function" ? await cmds() : cmds;
    if (list.length) await applyChanges(list, what);
  } catch (e) {
    if (!cancelled(e)) alertBox(title, errorText(e));
  }
  reload();
}

/** Every MAC address the router knows: devices seen now, fixed IPs, device groups. */
async function knownMacs(cfg) {
  const macs = new Set();
  const { clients } = await collectClients().catch(() => ({ clients: [] }));
  for (const c of clients) if (c.mac && c.kind !== "vpn") macs.add(c.mac.toLowerCase());
  for (const n of Object.values(cfg?.service?.["dhcp-server"]?.["shared-network-name"] || {})) {
    for (const s of Object.values(n?.subnet || {})) for (const m of Object.values(s?.["static-mapping"] || {})) if (m?.mac) macs.add(String(m.mac).toLowerCase());
  }
  for (const g of readGroups(cfg)) for (const m of g.macs) macs.add(m);
  return [...macs];
}

export function quarantineSection(st, reload) {
  const q = readQuarantine(st.cfg);
  const nets = readNetworks(st.cfg, st.wan);
  const label = (iface) => {
    const n = nets.find((x) => x.iface === iface);
    return n ? `${n.name} (${iface})` : iface;
  };
  const box = h("div");
  const title = "New-device quarantine";
  const about = "A device the router hasn't seen before gets an address and can reach the router, but nothing else (no internet, no other networks) until you approve it on the Devices page or here. Devices on the same switch or Wi-Fi can still reach each other directly; that traffic never passes the router. Phones with private (random) MAC addresses show up as new when they change it.";

  async function pick(current) {
    let picked = null;
    await formDialog(title, [
      { name: "nets", label: "Quarantine new devices on", type: "multicheck", value: current.map(label), options: nets.map((n) => label(n.iface)), hint: "A guest or IoT network is a good start." },
    ], (v) => {
      picked = nets.filter((n) => v.nets.includes(label(n.iface))).map((n) => n.iface);
      if (!picked.length) throw new Error("Choose at least one network");
      return true;
    }, { okLabel: "Next" });
    return picked;
  }

  async function turnOn() {
    const ifaces = await pick([]);
    if (!ifaces) return;
    const macs = await knownMacs(st.cfg);
    if (!(await confirmBox(title, `${macs.length} device${macs.length === 1 ? "" : "s"} the router knows now (online, with a fixed IP, or in a device group) will be approved, so they keep working. Any other device that joins ${ifaces.map(label).join(", ")} will be held until you approve it.`, "Turn on"))) return;
    apply(title, () => quarantineCommands(st.cfg, ifaces, macs), "new-device quarantine on", reload);
  }

  if (!nets.length) return row(title, "Needs a local network first (Networks page).");
  if (!q.ifaces.length) {
    box.append(row(title, about, h("button.primary", { on: { click: turnOn } }, "Turn on…")));
    return box;
  }
  const held = h("div", h("div.hint", "Looking for held devices…"));
  box.append(
    row(`${title}: on`, `On ${q.ifaces.map(label).join(", ")}. ${q.known.length} approved device${q.known.length === 1 ? "" : "s"}.`, h("span.set-inline",
      h("button", { on: { click: async () => {
        const ifaces = await pick(q.ifaces);
        if (ifaces) apply(title, () => quarantineCommands(st.cfg, ifaces, []), "quarantine networks", reload);
      } } }, "Networks…"),
      h("button", { on: { click: async () => {
        if (await confirmBox(title, "New devices will connect freely again. The list of approved devices is kept for next time.", "Turn off")) apply(title, quarantineCommands(st.cfg, []), "new-device quarantine off", reload);
      } } }, "Turn off"))),
    held);
  collectClients().then(({ clients }) => {
    const waiting = clients.filter((c) => c.kind !== "vpn" && isQuarantined(q, c.mac, c.iface));
    clear(held).append(waiting.length
      ? h("div.policy-list", waiting.map((c) => h("div.policy-row",
        h("span.grow", `${c.label} · ${c.ip || "no address yet"} · ${c.mac}${c.online ? "" : " (offline)"}`),
        h("button.primary", { on: { click: () => apply(title, approveCommands(st.cfg, c.mac), `approve ${c.label}`, reload) } }, "Approve"))))
      : h("div.hint", "No devices are waiting for approval."));
  }).catch((e) => clear(held).append(h("div.err-box", errorText(e))));
  return box;
}
