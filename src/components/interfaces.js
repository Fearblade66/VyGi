// Interfaces window: live table with rates + sparklines, add/remove/enable/disable/edit.
import { api, errorText } from "../lib/api.js";
import { h, setStatus, formatBits, sparkline, every } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { makeTable, filterBox } from "../lib/table.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges, session } from "../lib/session.js";
import { flattenInterfaces, toArray, has, diffMulti, diffSingle, validNodeName } from "../lib/vyos.js";
import { openTorch } from "./tools.js";
import { openTraffic } from "./traffic.js";

const POLL_MS = 2000;
const HISTORY = 30;

export function openInterfaces() {
  const win = openWindow({ key: "interfaces", title: "Interface List", width: 980, height: 420 });
  if (!win.isNew) return;

  let config = new Map();
  const prev = new Map(); // ifname -> {t, rx, tx}
  const history = new Map(); // ifname -> [bps...]
  let rows = [];

  const table = makeTable(
    [
      { key: "flags", label: "", width: "34px", className: "flag" },
      { key: "name", label: "Name", width: "110px" },
      { key: "type", label: "Type", width: "110px" },
      { key: "description", label: "Comment", width: "140px" },
      { key: "addresses", label: "IP Address", width: "170px" },
      { key: "mac", label: "MAC Address", width: "125px" },
      { key: "mtu", label: "MTU", width: "50px", className: "num" },
      { key: "txText", label: "Tx", width: "85px", className: "num" },
      { key: "rxText", label: "Rx", width: "85px", className: "num" },
      { key: "graph", label: "Traffic", width: "80px", render: (r) => sparkline(history.get(r.name) || []) },
    ],
    { rowKey: (r) => r.name, onOpen: (r) => editInterface(r), rowClass: (r) => (r.disabled ? "disabled" : "") },
  );

  const needSel = (fn) => () => {
    const r = table.selected();
    if (!r) return setStatus("Select an interface first.", true);
    fn(r);
  };
  const toolbar = h(
    "div.win-toolbar",
    h("button.icon-add", { title: "Add interface", on: { click: addInterface } }, "+"),
    h("button.icon-remove", { title: "Remove", on: { click: needSel(removeInterface) } }, "−"),
    h("button.icon-ok", { title: "Enable", on: { click: needSel((r) => setDisabled(r, false)) } }, "✓"),
    h("button.icon-x", { title: "Disable", on: { click: needSel((r) => setDisabled(r, true)) } }, "✗"),
    h("button", { title: "Reload config", on: { click: () => loadConfig() } }, "⟳"),
    h("button", { title: "Edit", on: { click: needSel(editInterface) } }, "Edit"),
    h("button", { title: "Live traffic graph", on: { click: needSel((r) => openTraffic(r.name)) } }, "Traffic"),
    h("button", { title: "Live traffic per connection on this interface", on: { click: needSel((r) => openTorch(r.name)) } }, "Torch"),
    h("span.grow"),
    filterBox(table),
  );
  win.body.append(toolbar, table.wrap, table.count);

  async function loadConfig() {
    try {
      config = flattenInterfaces(await api.getConfig(["interfaces"]));
    } catch (e) {
      setStatus(errorText(e), true);
    }
    await poll();
  }

  let polling = false;
  async function poll() {
    if (polling) return; // previous poll still waiting on a slow link
    polling = true;
    let stats;
    try {
      stats = await api.interfaceStats();
    } catch (e) {
      setStatus(errorText(e), true);
      return;
    } finally {
      polling = false;
    }
    const now = performance.now();
    const addrs = new Map((stats.addrs || []).map((a) => [a.ifname, a.addr_info || []]));
    const seen = new Set();
    rows = [];
    for (const link of stats.links || []) {
      const name = link.ifname;
      seen.add(name);
      const c = config.get(name);
      const s = link.stats64 || link.stats || {};
      const rx = s.rx?.bytes ?? 0;
      const tx = s.tx?.bytes ?? 0;
      const p = prev.get(name);
      let rxBps = NaN;
      let txBps = NaN;
      if (p && now > p.t) {
        const dt = (now - p.t) / 1000;
        rxBps = Math.max(0, ((rx - p.rx) * 8) / dt);
        txBps = Math.max(0, ((tx - p.tx) * 8) / dt);
        const hist = history.get(name) || [];
        hist.push(rxBps + txBps);
        if (hist.length > HISTORY) hist.shift();
        history.set(name, hist);
      }
      prev.set(name, { t: now, rx, tx });

      const running = (link.flags || []).includes("LOWER_UP") || link.operstate === "UP";
      const disabled = c ? has(c.cfg, "disable") : false;
      const kernelAddrs = (addrs.get(name) || []).filter((a) => a.scope !== "link").map((a) => `${a.local}/${a.prefixlen}`);
      rows.push({
        name,
        flags: (disabled ? "X" : running ? "R" : " ") + (c ? "" : "D"),
        type: c ? c.type : link.linkinfo?.info_kind || link.link_type || "",
        description: c?.cfg?.description || "",
        addresses: kernelAddrs.join(", ") || toArray(c?.cfg?.address).join(", "),
        mac: link.address || "",
        mtu: link.mtu ?? "",
        rxText: formatBits(rxBps),
        txText: formatBits(txBps),
        disabled,
        conf: c,
        kernelAddrs,
      });
    }
    // Configured but not present in the kernel (e.g. disabled tunnels).
    for (const [name, c] of config) {
      if (seen.has(name)) continue;
      rows.push({ name, flags: "X", type: c.type, description: c.cfg.description || "", addresses: toArray(c.cfg.address).join(", "), mac: "", mtu: c.cfg.mtu || "", rxText: "", txText: "", disabled: true, conf: c, kernelAddrs: [] });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    table.setRows(rows);
  }

  function isManagementInterface(r) {
    const host = session.info?.profile.host;
    return r.kernelAddrs.some((a) => a.split("/")[0] === host);
  }

  async function guardMgmt(r, action) {
    if (!isManagementInterface(r)) return true;
    const safe = document.getElementById("safe-mode").checked;
    return confirmBox(
      "You may lose access",
      `${r.name} carries ${session.info.profile.host}, the address you are connected through. ${action} it can cut you off.\n\n` +
        (safe ? "Safe Mode is ON: if you lose access, wait for the timer and the router reverts." : "Safe Mode is OFF. Turn it on first unless you have console access."),
      "Continue",
    );
  }

  async function run(commands, what) {
    try {
      await applyChanges(commands, what);
      await loadConfig();
    } catch (e) {
      alertBox("Apply failed", errorText(e));
      setStatus(errorText(e), true);
    }
  }

  async function setDisabled(r, disable) {
    if (!r.conf) return setStatus(`${r.name} is not managed by VyOS config.`, true);
    if (disable && !(await guardMgmt(r, "Disabling"))) return;
    run([{ op: disable ? "set" : "delete", path: [...r.conf.path, "disable"] }], `${disable ? "disable" : "enable"} ${r.name}`);
  }

  async function removeInterface(r) {
    if (!r.conf) return setStatus(`${r.name} is not managed by VyOS config.`, true);
    const physical = r.conf.path[1] === "ethernet" && r.conf.path.length === 3;
    const msg = physical
      ? `${r.name} is a physical port. Removing it deletes ALL its configuration (addresses, VLANs, etc).`
      : `Delete ${r.name} and all its configuration?`;
    if (!(await confirmBox("Remove interface", msg, "Remove"))) return;
    if (!(await guardMgmt(r, "Removing"))) return;
    run([{ op: "delete", path: r.conf.path }], `remove ${r.name}`);
  }

  async function editInterface(r) {
    if (!r.conf) return alertBox(r.name, `${r.name} exists in the kernel but not in the VyOS configuration, so it can't be edited here.`);
    const cfg = r.conf.cfg;
    const before = { description: cfg.description || "", addresses: toArray(cfg.address), mtu: cfg.mtu || "", disabled: has(cfg, "disable") };
    await formDialog(`Interface <${r.name}>`, [
      { name: "description", label: "Comment", value: before.description },
      { name: "addresses", label: "Addresses", type: "textarea", rows: 3, value: before.addresses.join("\n"), hint: "One per line: 192.0.2.1/24, 2001:db8::1/64, dhcp or dhcpv6" },
      { name: "mtu", label: "MTU", value: before.mtu, placeholder: "default" },
      { name: "disabled", label: "Disabled", type: "checkbox", value: before.disabled },
    ], async (v) => {
      const after = v.addresses.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      for (const a of after) if (!/^(dhcp|dhcpv6|[0-9a-fA-F:.]+\/\d{1,3})$/.test(a)) throw new Error(`"${a}" is not an address/prefix, dhcp or dhcpv6`);
      if (v.mtu && !/^\d+$/.test(v.mtu.trim())) throw new Error("MTU must be a number");
      const p = r.conf.path;
      const cmds = [
        ...diffSingle(p, "description", before.description, v.description),
        ...diffMulti(p, "address", before.addresses, after),
        ...diffSingle(p, "mtu", before.mtu, v.mtu),
      ];
      if (v.disabled !== before.disabled) cmds.push({ op: v.disabled ? "set" : "delete", path: [...p, "disable"] });
      if (!cmds.length) return true;
      const touchesAccess = v.disabled || before.addresses.some((a) => !after.includes(a));
      if (touchesAccess && !(await guardMgmt(r, "Changing"))) return false;
      await applyChanges(cmds, `edit ${r.name}`);
      await loadConfig();
      return true;
    }, { okLabel: "Apply" });
  }

  async function addInterface() {
    const physical = [...config.entries()].filter(([, c]) => c.path.length === 3 && ["ethernet", "bonding", "bridge"].includes(c.path[1])).map(([n]) => n);
    await formDialog("New Interface", [
      { name: "kind", label: "Type", type: "select", options: [
        { value: "vlan", label: "VLAN (vif)" },
        { value: "bridge", label: "Bridge" },
        { value: "dummy", label: "Dummy (loopback-like)" },
      ], value: "vlan" },
      { name: "parent", label: "VLAN parent", type: "select", options: physical.length ? physical : ["eth0"], hint: "Only for VLAN" },
      { name: "id", label: "Name / VLAN ID", placeholder: "10 for VLAN, br0, dum0", hint: "VLAN: a number 1-4094. Bridge: br0, br1… Dummy: dum0, dum1…" },
      { name: "address", label: "Address", placeholder: "192.0.2.1/24 (optional)" },
      { name: "description", label: "Comment" },
      { name: "members", label: "Bridge members", placeholder: "eth1 eth2 (only for bridge)" },
    ], async (v) => {
      const id = v.id.trim();
      let path;
      if (v.kind === "vlan") {
        if (!/^\d+$/.test(id) || +id < 1 || +id > 4094) throw new Error("VLAN ID must be 1-4094");
        const parent = config.get(v.parent);
        if (!parent) throw new Error("pick a parent interface");
        path = [...parent.path, "vif", id];
      } else if (v.kind === "bridge") {
        if (!/^br\d+$/.test(id)) throw new Error("bridge name must look like br0");
        path = ["interfaces", "bridge", id];
      } else {
        if (!/^dum\d+$/.test(id)) throw new Error("dummy name must look like dum0");
        path = ["interfaces", "dummy", id];
      }
      const cmds = [];
      if (v.address.trim()) cmds.push({ op: "set", path: [...path, "address"], value: v.address.trim() });
      if (v.description.trim()) cmds.push({ op: "set", path: [...path, "description"], value: v.description.trim() });
      if (v.kind === "bridge") {
        for (const m of v.members.split(/[\s,]+/).filter(Boolean)) {
          if (!validNodeName(m)) throw new Error(`bad member name ${m}`);
          cmds.push({ op: "set", path: [...path, "member", "interface", m] });
        }
      }
      if (!cmds.length) cmds.push({ op: "set", path });
      await applyChanges(cmds, `add ${path[path.length - 1]}`);
      await loadConfig();
      return true;
    }, { okLabel: "Apply" });
  }

  loadConfig();
  const timer = every(poll, POLL_MS);
  win.onClose(() => clearInterval(timer));
}
