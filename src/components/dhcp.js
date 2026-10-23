// DHCP Server leases, with "Make Static" to pin a device to its address.
import { api, errorText } from "../lib/api.js";
import { h, setStatus } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { makeTable, filterBox } from "../lib/table.js";
import { formDialog, alertBox } from "../lib/dialog.js";
import { applyChanges } from "../lib/session.js";
import { ipv4InCidr } from "../lib/vyos.js";
import { openConfigTree } from "./config_tree.js";

function fmtTime(v) {
  if (v == null || v === "") return "";
  const n = Number(v);
  if (Number.isFinite(n) && n > 1e9) return new Date(n * 1000).toLocaleString();
  return String(v);
}

function fmtRemaining(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v == null ? "" : String(v);
  const s = Math.max(0, Math.floor(n));
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function openDhcpLeases() {
  const win = openWindow({ key: "dhcp-leases", title: "DHCP Server Leases", width: 940, height: 420 });
  if (!win.isNew) return;

  const table = makeTable(
    [
      { key: "ip", label: "Address", width: "120px" },
      { key: "mac", label: "MAC Address", width: "130px" },
      { key: "hostname", label: "Host Name", width: "150px" },
      { key: "state", label: "Status", width: "80px" },
      { key: "startText", label: "Start", width: "150px" },
      { key: "endText", label: "Expires", width: "150px" },
      { key: "remainingText", label: "Remaining", width: "80px" },
      { key: "pool", label: "Server (shared network)" },
    ],
    { rowKey: (r) => `${r.ip}|${r.mac}` },
  );
  const family = h("select", h("option", { value: 4 }, "IPv4"), h("option", { value: 6 }, "IPv6"));
  win.body.append(
    h(
      "div.win-toolbar",
      h("button", { title: "Refresh", on: { click: load } }, "⟳"),
      h("button", { title: "Reserve this address for this device", on: { click: makeStatic } }, "Make Static"),
      h("button", { title: "DHCP server configuration", on: { click: () => openConfigTree(["service", "dhcp-server"], "DHCP Server") } }, "Server Config…"),
      family,
      h("span.grow"),
      filterBox(table),
    ),
    table.wrap,
    table.count,
  );
  family.addEventListener("change", load);

  async function load() {
    try {
      const leases = await api.dhcpLeases(Number(family.value));
      table.setRows(
        (Array.isArray(leases) ? leases : []).map((l) => ({
          ...l,
          ip: l.ip || "",
          mac: l.mac || l.duid || "",
          hostname: l.hostname || "",
          state: l.state || "",
          pool: l.pool || "",
          startText: fmtTime(l.start ?? l.last_communication),
          endText: fmtTime(l.end),
          remainingText: fmtRemaining(l.remaining),
        })),
      );
    } catch (e) {
      setStatus(`DHCP leases: ${errorText(e)}`, true);
    }
  }

  async function makeStatic() {
    const l = table.selected();
    if (!l) return setStatus("Select a lease first.", true);
    if (family.value !== "4") return alertBox("Make Static", "Only IPv4 leases are supported here.");
    if (!l.pool || !l.ip || !l.mac) return alertBox("Make Static", "This lease is missing its server, address or MAC.");

    const netPath = ["service", "dhcp-server", "shared-network-name", l.pool, "subnet"];
    let subnets = {};
    try {
      subnets = (await api.getConfig(netPath)) || {};
    } catch (e) {
      return alertBox("Make Static", errorText(e));
    }
    const subnet = Object.keys(subnets).find((cidr) => ipv4InCidr(l.ip, cidr));
    if (!subnet) return alertBox("Make Static", `No subnet under shared-network ${l.pool} contains ${l.ip}.`);

    const suggested = (l.hostname || `host-${l.ip.replaceAll(".", "-")}`).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
    await formDialog("Make Static", [
      { name: "name", label: "Mapping name", value: suggested },
      { name: "ip", label: "IP Address", value: l.ip, hint: "You can pick another free address in the subnet." },
      { name: "mac", label: "MAC Address", value: l.mac },
    ], async (v) => {
      const name = v.name.trim();
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error("Name: letters, digits, - _ . only");
      if (!ipv4InCidr(v.ip.trim(), subnet)) throw new Error(`${v.ip} is not inside ${subnet}`);
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(v.mac.trim())) throw new Error("MAC must look like aa:bb:cc:dd:ee:ff");
      if (subnets[subnet]?.["static-mapping"]?.[name]) throw new Error(`A mapping named ${name} already exists`);
      const base = [...netPath, subnet, "static-mapping", name];
      await applyChanges(
        [
          { op: "set", path: [...base, "ip-address"], value: v.ip.trim() },
          { op: "set", path: [...base, "mac"], value: v.mac.trim().toLowerCase() },
        ],
        `static mapping ${name}`,
      );
      return true;
    }, { okLabel: "Apply" });
  }

  load();
  const timer = setInterval(load, 15000);
  win.onClose(() => clearInterval(timer));
}
