// IP > ARP / Neighbors: the ARP+NDP table, and LLDP-discovered devices (Winbox "Neighbors").
import { api, errorText } from "../lib/api.js";
import { h, setStatus } from "../lib/dom.js";
import { openWindow, tabs } from "../lib/mdi.js";
import { makeTable, filterBox } from "../lib/table.js";
import { confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges } from "../lib/session.js";

/** Locally administered bit set = randomized/private MAC (phones do this per network). */
export function isPrivateMac(mac) {
  const first = parseInt(String(mac).slice(0, 2), 16);
  return Number.isFinite(first) && (first & 0x02) === 0x02;
}

/** Flattens lldpcli JSON ({lldp:{interface:[{eth0:{...}}]}}) into rows. */
export function lldpRows(raw) {
  let list = raw?.lldp?.interface;
  if (!list) return [];
  if (!Array.isArray(list)) list = [list];
  const rows = [];
  for (const entry of list) {
    for (const [local, v] of Object.entries(entry || {})) {
      const chassisName = v?.chassis ? Object.keys(v.chassis)[0] : "";
      const ch = v?.chassis?.[chassisName] || {};
      const caps = [].concat(ch.capability || []).filter((c) => c?.enabled).map((c) => c.type).join(", ");
      rows.push({
        local,
        device: chassisName,
        port: v?.port?.id?.value ?? "",
        portDescr: v?.port?.descr ?? "",
        mgmt: [].concat(ch["mgmt-ip"] || []).join(", "),
        platform: [].concat(ch.descr || []).join(" ").slice(0, 120),
        caps,
        via: v?.via ?? "",
      });
    }
  }
  return rows;
}

export function openNeighbors() {
  const win = openWindow({ key: "neighbors", title: "ARP / Neighbors", width: 820, height: 380 });
  if (!win.isNew) return;
  const loaders = {};
  const t = tabs(["ARP / NDP", "LLDP Neighbors"], (n) => loaders[n]?.());
  win.body.append(t.el);

  const arp = makeTable(
    [
      { key: "address", label: "Address", width: "220px" },
      { key: "mac", label: "MAC Address", width: "150px" },
      { key: "iface", label: "Interface", width: "90px" },
      { key: "state", label: "State", width: "110px" },
      { key: "note", label: "" },
    ],
    { rowKey: (r) => `${r.address}|${r.iface}`, rowClass: (r) => (r.failed ? "disabled" : "") },
  );
  const hideFailed = h("input", { type: "checkbox", checked: true });
  hideFailed.addEventListener("change", () => loaders["ARP / NDP"]());
  t.pages["ARP / NDP"].append(
    h("div.win-toolbar",
      h("button", { on: { click: () => loaders["ARP / NDP"]() } }, "⟳"),
      h("button", { title: "Pin this IP to this MAC (static ARP entry)", on: { click: makeStaticArp } }, "Make Static"),
      h("label", hideFailed, " Hide incomplete"),
      h("span.grow"), filterBox(arp)),
    arp.wrap, arp.count,
  );
  loaders["ARP / NDP"] = async () => {
    try {
      const list = await api.neighbors();
      arp.setRows(list
        .map((n) => {
          const state = [].concat(n.state || []).join(", ");
          const failed = /INCOMPLETE|FAILED/.test(state);
          return { address: n.dst, mac: n.lladdr || "", iface: n.dev, state, failed, note: n.lladdr && isPrivateMac(n.lladdr) ? "private MAC" : "" };
        })
        .filter((r) => !(hideFailed.checked && r.failed)));
    } catch (e) {
      setStatus(errorText(e), true);
    }
  };

  async function makeStaticArp() {
    const r = arp.selected();
    if (!r) return setStatus("Select an entry first.", true);
    if (!r.mac || r.address.includes(":")) return alertBox("Make Static", "Only IPv4 entries with a known MAC can be made static.");
    if (!(await confirmBox("Static ARP", `Always map ${r.address} to ${r.mac} on ${r.iface}?`, "Apply"))) return;
    try {
      await applyChanges([{ op: "set", path: ["protocols", "static", "arp", "interface", r.iface, "address", r.address, "mac"], value: r.mac }], `static ARP ${r.address}`);
    } catch (e) {
      alertBox("Apply failed", errorText(e));
    }
  }

  const lldp = makeTable(
    [
      { key: "device", label: "Device", width: "150px" },
      { key: "local", label: "Our Port", width: "80px" },
      { key: "port", label: "Their Port", width: "120px" },
      { key: "mgmt", label: "Address", width: "130px" },
      { key: "caps", label: "Type", width: "110px" },
      { key: "platform", label: "Platform" },
    ],
    { rowKey: (r) => `${r.local}|${r.device}|${r.port}` },
  );
  const lldpNote = h("span.hint");
  const enableBtn = h("button", { hidden: true, on: { click: enableLldp } }, "Enable LLDP on all ports");
  t.pages["LLDP Neighbors"].append(
    h("div.win-toolbar", h("button", { on: { click: () => loaders["LLDP Neighbors"]() } }, "⟳"), enableBtn, lldpNote, h("span.grow"), filterBox(lldp)),
    lldp.wrap, lldp.count,
  );
  loaders["LLDP Neighbors"] = async () => {
    try {
      const raw = await api.lldpNeighbors();
      const off = raw === null;
      enableBtn.hidden = !off;
      lldpNote.textContent = off ? "LLDP is off. Turn it on to discover switches, access points and other routers on your ports." : "Devices that announce themselves with LLDP (switches, APs, other routers).";
      lldp.setRows(lldpRows(raw));
    } catch (e) {
      setStatus(errorText(e), true);
    }
  };

  async function enableLldp() {
    try {
      await applyChanges([{ op: "set", path: ["service", "lldp", "interface", "all"] }], "enable LLDP");
      setStatus("LLDP enabled. Neighbors appear within about 30 seconds.");
      setTimeout(() => loaders["LLDP Neighbors"](), 5000);
    } catch (e) {
      alertBox("Apply failed", errorText(e));
    }
  }

  t.select("ARP / NDP");
}
