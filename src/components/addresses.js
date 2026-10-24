// IP > Addresses: every address on every interface, like the Winbox Address List.
import { api, errorText } from "../lib/api.js";
import { h, setStatus } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { makeTable, filterBox } from "../lib/table.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges, session } from "../lib/session.js";
import { flattenInterfaces, toArray, parseIpv4Cidr } from "../lib/vyos.js";

export function openAddresses() {
  const win = openWindow({ key: "addresses", title: "Address List", width: 720, height: 360 });
  if (!win.isNew) return;
  let conf = new Map();

  const table = makeTable(
    [
      { key: "flags", label: "", width: "30px", className: "flag" },
      { key: "address", label: "Address", width: "200px" },
      { key: "network", label: "Network", width: "160px" },
      { key: "iface", label: "Interface", width: "100px" },
      { key: "source", label: "Source" },
    ],
    { rowKey: (r) => `${r.iface}|${r.address}`, rowClass: (r) => (r.dynamic ? "disabled" : "") },
  );
  win.body.append(
    h(
      "div.win-toolbar",
      h("button.icon-add", { on: { click: addAddress } }, "+"),
      h("button.icon-remove", { on: { click: removeAddress } }, "−"),
      h("button", { on: { click: load } }, "⟳"),
      h("span.hint", "D = dynamic (from DHCP, link-local, or not in the config)"),
      h("span.grow"),
      filterBox(table),
    ),
    table.wrap,
    table.count,
  );

  async function load() {
    try {
      const [cfg, stats] = await Promise.all([api.getConfig(["interfaces"]), api.interfaceStats()]);
      conf = flattenInterfaces(cfg);
      const rows = [];
      const configured = new Set();
      for (const [name, c] of conf) {
        for (const a of toArray(c.cfg.address)) {
          configured.add(`${name}|${a}`);
          if (a === "dhcp" || a === "dhcpv6") continue;
          rows.push({ flags: "", address: a, network: parseIpv4Cidr(a)?.network || "", iface: name, source: "static", dynamic: false, conf: c });
        }
      }
      for (const a of stats.addrs || []) {
        for (const i of a.addr_info || []) {
          const addr = `${i.local}/${i.prefixlen}`;
          if (configured.has(`${a.ifname}|${addr}`)) continue;
          const isDhcp = toArray(conf.get(a.ifname)?.cfg.address).includes(i.family === "inet6" ? "dhcpv6" : "dhcp");
          rows.push({
            flags: "D",
            address: addr,
            network: parseIpv4Cidr(addr)?.network || "",
            iface: a.ifname,
            source: i.scope === "link" ? "link-local" : isDhcp ? "DHCP" : i.scope === "host" ? "loopback" : "kernel",
            dynamic: true,
          });
        }
      }
      rows.sort((x, y) => x.iface.localeCompare(y.iface, undefined, { numeric: true }) || x.address.localeCompare(y.address));
      table.setRows(rows);
    } catch (e) {
      setStatus(errorText(e), true);
    }
  }

  async function addAddress() {
    const names = [...conf.keys()].filter((n) => conf.get(n).type !== "loopback" || n === "lo");
    if (!names.length) return alertBox("Add address", "No interfaces found.");
    await formDialog("New Address", [
      { name: "address", label: "Address", placeholder: "192.168.10.1/24 or 2001:db8::1/64" },
      { name: "iface", label: "Interface", type: "select", options: names, value: names[0] },
    ], async (v) => {
      const a = v.address.trim();
      if (!/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(a)) throw new Error("Address must include the prefix length, e.g. 192.168.10.1/24");
      const c = conf.get(v.iface);
      if (toArray(c.cfg.address).includes(a)) throw new Error(`${a} is already on ${v.iface}`);
      await applyChanges([{ op: "set", path: [...c.path, "address"], value: a }], `address ${a}`);
      load();
      return true;
    }, { okLabel: "Apply" });
  }

  async function removeAddress() {
    const r = table.selected();
    if (!r) return setStatus("Select an address first.", true);
    if (r.dynamic) return alertBox("Remove address", `${r.address} is ${r.source}, not set in the config, so it can't be removed here.`);
    const mgmt = r.address.split("/")[0] === session.info?.profile.host;
    if (!(await confirmBox("Remove address", `Remove ${r.address} from ${r.iface}?${mgmt ? "\n\nWARNING: this is the address you are connected through. Make sure Safe Mode is ON." : ""}`, "Remove"))) return;
    try {
      await applyChanges([{ op: "delete", path: [...r.conf.path, "address", r.address] }], `remove ${r.address}`);
    } catch (e) {
      alertBox("Apply failed", errorText(e));
    }
    load();
  }

  load();
}
