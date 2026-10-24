// IP > Services: which router services are on, their ports, and quick enable/disable.
import { api, errorText } from "../lib/api.js";
import { h, setStatus } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { makeTable } from "../lib/table.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges } from "../lib/session.js";
import { toArray, tagKeys } from "../lib/vyos.js";
import { openConfigTree } from "./config_tree.js";
import { openDns } from "./dns.js";
import { openDhcp } from "./dhcp.js";

/** Each service: where it lives, how to describe it, and how to turn it on. */
const SERVICES = [
  {
    id: "ssh", name: "SSH", path: ["service", "ssh"], required: true,
    port: (c) => c.port || "22",
    details: (c) => [c["listen-address"] && `listen ${toArray(c["listen-address"]).join(", ")}`, c["disable-password-authentication"] !== undefined && "keys only"].filter(Boolean).join(", "),
    editPort: true,
  },
  {
    id: "https", name: "HTTPS API", path: ["service", "https"], required: true,
    port: (c) => c.port || "443",
    details: (c) => [c.api?.rest !== undefined && "REST", c.api?.graphql !== undefined && "GraphQL", c["allow-client"] && `allow ${toArray(c["allow-client"].address).join(", ")}`].filter(Boolean).join(", "),
  },
  { id: "dns", name: "DNS forwarding", path: ["service", "dns", "forwarding"], port: () => "53", details: (c) => toArray(c["allow-from"]).join(", "), open: () => openDns() },
  { id: "dhcp", name: "DHCP server", path: ["service", "dhcp-server"], port: () => "67", details: (c) => Object.keys(c["shared-network-name"] || {}).join(", "), open: () => openDhcp() },
  {
    id: "ntp", name: "NTP (time sync)", path: ["service", "ntp"], port: () => "123",
    details: (c) => tagKeys(c.server).join(", "),
    enable: async () => [{ op: "set", path: ["service", "ntp", "server", "time.cloudflare.com"] }],
  },
  {
    id: "lldp", name: "LLDP (discovery)", path: ["service", "lldp"], port: () => "",
    details: (c) => tagKeys(c.interface).join(", "),
    enable: async () => [{ op: "set", path: ["service", "lldp", "interface", "all"] }],
  },
  {
    id: "snmp", name: "SNMP", path: ["service", "snmp"], port: () => "161",
    details: (c) => tagKeys(c.community).map((x) => `community ${x}`).join(", "),
    enable: async () => {
      const v = await formDialog("Enable SNMP (read-only)", [
        { name: "community", label: "Community", value: "", placeholder: "a secret word, not 'public'" },
        { name: "network", label: "Allowed network", value: "", placeholder: "e.g. 192.168.1.0/24" },
      ], (x) => {
        if (!/^[A-Za-z0-9._-]{4,32}$/.test(x.community.trim())) throw new Error("Community: 4-32 letters/digits");
        if (!/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(x.network.trim())) throw new Error("Allowed network must look like 192.168.1.0/24");
      });
      if (!v) return null;
      const base = ["service", "snmp", "community", v.community.trim()];
      return [{ op: "set", path: [...base, "authorization"], value: "ro" }, { op: "set", path: [...base, "network"], value: v.network.trim() }];
    },
  },
  {
    id: "mdns", name: "mDNS repeater", path: ["service", "mdns", "repeater"], port: () => "5353",
    details: (c) => toArray(c.interface).join(", "),
    enable: async () => {
      const v = await formDialog("Enable mDNS repeater", [
        { name: "ifaces", label: "Interfaces", placeholder: "e.g. br0 eth1.20", hint: "At least two: printers/Chromecasts on one become visible on the others." },
      ], (x) => {
        const l = x.ifaces.split(/[\s,]+/).filter(Boolean);
        if (l.length < 2 || l.some((i) => !/^[A-Za-z0-9._-]+$/.test(i))) throw new Error("Give at least two interface names");
      });
      if (!v) return null;
      return v.ifaces.split(/[\s,]+/).filter(Boolean).map((i) => ({ op: "set", path: ["service", "mdns", "repeater", "interface"], value: i }));
    },
  },
  { id: "proxy", name: "Web proxy", path: ["service", "webproxy"], port: (c) => c["listen-address"] ? tagKeys(c["listen-address"]).join(", ") : "3128", details: () => "" },
  { id: "tftp", name: "TFTP server", path: ["service", "tftp-server"], port: () => "69", details: (c) => c.directory || "" },
];

function nodeAt(cfg, path) {
  let n = cfg;
  for (const k of path.slice(1)) n = n?.[k];
  return n;
}

export function openServices() {
  const win = openWindow({ key: "services", title: "IP Service List", width: 760, height: 360 });
  if (!win.isNew) return;
  let cfg = {};
  const table = makeTable(
    [
      { key: "flags", label: "", width: "26px", className: "flag" },
      { key: "name", label: "Name", width: "150px" },
      { key: "port", label: "Port", width: "70px", className: "num" },
      { key: "status", label: "Status", width: "80px" },
      { key: "details", label: "Details" },
    ],
    { rowKey: (r) => r.id, rowClass: (r) => (r.on ? "" : "disabled"), onOpen: (r) => configure(r) },
  );
  const sel = (fn) => () => {
    const r = table.selected();
    if (!r) return setStatus("Select a service first.", true);
    fn(r);
  };
  win.body.append(
    h("div.win-toolbar",
      h("button.icon-ok", { title: "Enable", on: { click: sel(enable) } }, "✓"),
      h("button.icon-x", { title: "Disable", on: { click: sel(disable) } }, "✗"),
      h("button", { on: { click: sel(configure) } }, "Configure…"),
      h("button", { on: { click: load } }, "⟳"),
      h("span.grow"),
      h("span.hint", "Double-click a service to configure it.")),
    table.wrap, table.count,
  );

  async function load() {
    try {
      cfg = (await api.getConfig(["service"])) || {};
    } catch (e) {
      return setStatus(errorText(e), true);
    }
    table.setRows(SERVICES.map((s) => {
      const c = nodeAt(cfg, s.path);
      const on = c !== undefined;
      return { ...s, on, flags: on ? "" : "X", status: on ? "enabled" : "disabled", port: on ? s.port(c || {}) : "", details: on ? s.details(c || {}) : "" };
    }));
  }

  async function enable(r) {
    if (r.on) return setStatus(`${r.name} is already enabled.`);
    if (r.open) return r.open();
    if (!r.enable) return configure(r);
    const cmds = await r.enable();
    if (!cmds) return;
    try {
      await applyChanges(cmds, `enable ${r.name}`);
    } catch (e) {
      alertBox("Apply failed", errorText(e));
    }
    load();
  }

  async function disable(r) {
    if (!r.on) return setStatus(`${r.name} is already disabled.`);
    if (r.required) return alertBox(`Disable ${r.name}`, `VyGi needs ${r.name} to manage this router, so it can't be turned off from here. Use the terminal if you really want to.`);
    if (!(await confirmBox(`Disable ${r.name}`, `Turn off ${r.name}? This deletes its configuration.`, "Disable"))) return;
    try {
      await applyChanges([{ op: "delete", path: r.path }], `disable ${r.name}`);
    } catch (e) {
      alertBox("Apply failed", errorText(e));
    }
    load();
  }

  async function configure(r) {
    if (r.open) return r.open();
    if (r.editPort && r.on) {
      const c = nodeAt(cfg, r.path) || {};
      return formDialog(`${r.name} settings`, [
        { name: "port", label: "Port", value: c.port || "22", hint: "After changing it, update the SSH port of this router in the Connect window." },
      ], async (v) => {
        const p = Number(v.port);
        if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error("Port must be 1-65535");
        if (String(p) === String(c.port || "22")) return true;
        await applyChanges([{ op: "set", path: [...r.path, "port"], value: String(p) }], `${r.name} port ${p}`);
        load();
        return true;
      }, { okLabel: "Apply" });
    }
    openConfigTree(r.path, r.name);
  }

  load();
}
