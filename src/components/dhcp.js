// DHCP Server: servers per subnet (VyOS 1.5 layout), leases, static mappings.
// Paths follow vyos-1x dhcp-server-common-config.xml.i (subnet-id, option ..., range N start/stop).
import { api, errorText } from "../lib/api.js";
import { h, setStatus } from "../lib/dom.js";
import { openWindow, tabs } from "../lib/mdi.js";
import { makeTable, filterBox } from "../lib/table.js";
import { formDialog, alertBox, confirmBox } from "../lib/dialog.js";
import { applyChanges } from "../lib/session.js";
import { ipv4InCidr, parseIpv4Cidr, toArray, has, diffMulti, diffSingle } from "../lib/vyos.js";
import { openConfigTree } from "./config_tree.js";

const ROOT = ["service", "dhcp-server", "shared-network-name"];
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

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

/** Flattens shared-network-name -> subnet into rows. */
function subnetRows(networks) {
  const rows = [];
  for (const [net, ncfg] of Object.entries(networks || {})) {
    for (const [cidr, cfg] of Object.entries(ncfg?.subnet || {})) {
      const ranges = Object.entries(cfg?.range || {});
      rows.push({
        network: net,
        subnet: cidr,
        cfg: cfg || {},
        rangeKey: ranges[0]?.[0] ?? "0",
        ranges: ranges.map(([, r]) => `${r?.start ?? "?"} – ${r?.stop ?? "?"}`).join(", "),
        gateway: cfg?.option?.["default-router"] || "",
        dns: toArray(cfg?.option?.["name-server"]).join(", "),
        domain: cfg?.option?.["domain-name"] || "",
        lease: cfg?.lease || "",
        statics: Object.keys(cfg?.["static-mapping"] || {}).length,
        disabled: has(ncfg, "disable") || has(cfg, "disable"),
        onlySubnet: Object.keys(ncfg?.subnet || {}).length === 1,
      });
    }
  }
  return rows;
}

function checkIp(ip, subnet, label) {
  if (!ipv4InCidr(ip, subnet)) throw new Error(`${label} ${ip || "(empty)"} is not inside ${subnet}`);
}

function ipNum(ip) {
  return ip.split(".").reduce((a, b) => a * 256 + Number(b), 0);
}

export function openDhcpLeases() {
  openDhcp("Leases");
}

let selectTab = null; // switches tabs of the open window, if any

export function openDhcp(startTab = "Servers") {
  const win = openWindow({ key: "dhcp", title: "DHCP Server", width: 980, height: 440 });
  if (!win.isNew) return selectTab?.(startTab);
  win.onClose(() => (selectTab = null));
  let networks = {};
  const loaders = {};
  const t = tabs(["Servers", "Leases", "Static Mappings"], (name) => loaders[name]?.());
  win.body.append(t.el);
  selectTab = t.select;

  async function loadConfig() {
    try {
      networks = (await api.getConfig(ROOT)) || {};
    } catch (e) {
      setStatus(errorText(e), true);
    }
  }

  // ---------------- Servers ----------------
  const servers = makeTable(
    [
      { key: "flags", label: "", width: "26px", className: "flag" },
      { key: "network", label: "Name", width: "110px" },
      { key: "subnet", label: "Subnet", width: "130px" },
      { key: "ranges", label: "Address Pool", width: "210px" },
      { key: "gateway", label: "Gateway", width: "110px" },
      { key: "dns", label: "DNS Servers", width: "150px" },
      { key: "lease", label: "Lease (s)", width: "70px", className: "num" },
      { key: "statics", label: "Static", width: "50px", className: "num" },
      { key: "domain", label: "Domain" },
    ],
    { rowKey: (r) => `${r.network}|${r.subnet}`, onOpen: (r) => editServer(r), rowClass: (r) => (r.disabled ? "disabled" : "") },
  );
  const sel = (fn) => () => {
    const r = servers.selected();
    if (!r) return setStatus("Select a server first.", true);
    fn(r);
  };
  t.pages.Servers.append(
    h(
      "div.win-toolbar",
      h("button.icon-add", { title: "New DHCP server on an interface", on: { click: newServer } }, "+ Setup…"),
      h("button.icon-remove", { title: "Remove", on: { click: sel(removeServer) } }, "−"),
      h("button", { on: { click: sel(editServer) } }, "Edit"),
      h("button", { title: "Raw DHCP server configuration", on: { click: () => openConfigTree(["service", "dhcp-server"], "DHCP Server Config") } }, "Config…"),
      h("button", { on: { click: () => loaders.Servers() } }, "⟳"),
      h("span.grow"),
      filterBox(servers),
    ),
    servers.wrap,
    servers.count,
  );
  loaders.Servers = async () => {
    await loadConfig();
    servers.setRows(subnetRows(networks).map((r) => ({ ...r, flags: r.disabled ? "X" : "" })));
  };

  function nextSubnetId() {
    const ids = subnetRows(networks).map((r) => Number(r.cfg["subnet-id"])).filter(Number.isFinite);
    return String(ids.length ? Math.max(...ids) + 1 : 1);
  }

  async function newServer() {
    let ifaces = {};
    let dns = {};
    try {
      [ifaces, dns] = await Promise.all([api.getConfig(["interfaces"]), api.getConfig(["service", "dns", "forwarding"]).catch(() => ({}))]);
      await loadConfig();
    } catch (e) {
      return alertBox("DHCP Setup", errorText(e));
    }
    // Interfaces (incl. VLANs) with a static IPv4 address.
    const candidates = [];
    const walk = (name, cfg) => {
      for (const a of toArray(cfg?.address)) {
        const c = parseIpv4Cidr(a);
        if (c && c.bits <= 30) candidates.push({ label: `${name}  (${a})`, value: `${name}|${a}` });
      }
      for (const [vid, vcfg] of Object.entries(cfg?.vif || {})) walk(`${name}.${vid}`, vcfg);
    };
    for (const [type, members] of Object.entries(ifaces || {})) {
      if (["loopback", "wireguard"].includes(type)) continue;
      for (const [name, cfg] of Object.entries(members || {})) walk(name, cfg);
    }
    if (!candidates.length) return alertBox("DHCP Setup", "No interface has a static IPv4 address. Give your LAN interface an address first (Interfaces window).");

    const suggest = (value) => {
      const [name, addr] = value.split("|");
      const c = parseIpv4Cidr(addr);
      const base = ipNum(c.first);
      const size = ipNum(c.last) - base + 1;
      const toIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
      const [start, stop] = size >= 254 ? [base + 99, base + 199] : [base + Math.floor(size / 2), ipNum(c.last)];
      return { name: `LAN-${name.replace(/[^A-Za-z0-9]/g, "")}`.toUpperCase(), subnet: c.network, gw: c.ip, start: toIp(start >>> 0), stop: toIp(stop >>> 0) };
    };
    const first = suggest(candidates[0].value);

    await formDialog("DHCP Server Setup", [
      { name: "iface", label: "Interface", type: "select", options: candidates, value: candidates[0].value },
      { name: "name", label: "Name", value: first.name },
      { name: "start", label: "Pool start", value: first.start },
      { name: "stop", label: "Pool end", value: first.stop },
      { name: "gw", label: "Gateway", value: first.gw },
      { name: "dns", label: "DNS servers", value: first.gw, hint: "Space-separated. The router's own address works if DNS forwarding is on (checkbox below)." },
      { name: "domain", label: "Domain name", placeholder: "optional, e.g. home.lan" },
      { name: "lease", label: "Lease time (s)", value: "86400" },
      { name: "dnsFwd", label: "Enable DNS forwarding for this network (router answers DNS)", type: "checkbox", value: true },
    ], async (v) => {
      const subnet = parseIpv4Cidr(v.iface.split("|")[1]).network;
      const [start, stop, gw, name] = [v.start.trim(), v.stop.trim(), v.gw.trim(), v.name.trim()];
      const dnsList = v.dns.split(/[\s,]+/).filter(Boolean);
      if (!NAME_RE.test(name)) throw new Error("Name: letters, digits, - _ . only");
      if (networks[name]) throw new Error(`A DHCP server named ${name} already exists`);
      if (subnetRows(networks).some((r) => r.subnet === subnet)) throw new Error(`${subnet} already has a DHCP server`);
      checkIp(start, subnet, "Pool start");
      checkIp(stop, subnet, "Pool end");
      if (ipNum(start) > ipNum(stop)) throw new Error("Pool start must be before pool end");
      checkIp(gw, subnet, "Gateway");
      for (const d of dnsList) if (!/^[\d.]+$|^[0-9a-f:]+$/i.test(d)) throw new Error(`Bad DNS server ${d}`);
      if (!/^\d+$/.test(v.lease.trim())) throw new Error("Lease time must be a number of seconds");

      const base = [...ROOT, name, "subnet", subnet];
      const cmds = [
        { op: "set", path: [...base, "subnet-id"], value: nextSubnetId() },
        { op: "set", path: [...base, "option", "default-router"], value: gw },
        ...dnsList.map((d) => ({ op: "set", path: [...base, "option", "name-server"], value: d })),
        { op: "set", path: [...base, "lease"], value: v.lease.trim() },
        { op: "set", path: [...base, "range", "0", "start"], value: start },
        { op: "set", path: [...base, "range", "0", "stop"], value: stop },
      ];
      if (v.domain.trim()) cmds.push({ op: "set", path: [...base, "option", "domain-name"], value: v.domain.trim() });
      if (v.dnsFwd) {
        const d = ["service", "dns", "forwarding"];
        cmds.push({ op: "set", path: [...d, "allow-from"], value: subnet }, { op: "set", path: [...d, "listen-address"], value: gw });
        if (!Object.keys(dns || {}).length) cmds.push({ op: "set", path: [...d, "system"] });
      }
      await applyChanges(cmds, `DHCP server ${name}`);
      await loaders.Servers();
      return true;
    }, {
      okLabel: "Create",
      onChange(field, v, set) {
        if (field !== "iface") return;
        const s = suggest(v.iface);
        set("name", s.name);
        set("start", s.start);
        set("stop", s.stop);
        set("gw", s.gw);
        set("dns", s.gw);
      },
    });
  }

  async function editServer(r) {
    const range = r.cfg.range?.[r.rangeKey] || {};
    const before = {
      start: range.start || "",
      stop: range.stop || "",
      gw: r.cfg.option?.["default-router"] || "",
      dns: toArray(r.cfg.option?.["name-server"]),
      domain: r.cfg.option?.["domain-name"] || "",
      lease: r.cfg.lease || "",
      disabled: has(r.cfg, "disable"),
    };
    await formDialog(`DHCP ${r.network} <${r.subnet}>`, [
      { name: "start", label: "Pool start", value: before.start },
      { name: "stop", label: "Pool end", value: before.stop },
      { name: "gw", label: "Gateway", value: before.gw },
      { name: "dns", label: "DNS servers", value: before.dns.join(" ") },
      { name: "domain", label: "Domain name", value: before.domain },
      { name: "lease", label: "Lease time (s)", value: before.lease },
      { name: "disabled", label: "Disabled", type: "checkbox", value: before.disabled },
    ], async (v) => {
      checkIp(v.start.trim(), r.subnet, "Pool start");
      checkIp(v.stop.trim(), r.subnet, "Pool end");
      if (ipNum(v.start.trim()) > ipNum(v.stop.trim())) throw new Error("Pool start must be before pool end");
      if (v.gw.trim()) checkIp(v.gw.trim(), r.subnet, "Gateway");
      if (v.lease.trim() && !/^\d+$/.test(v.lease.trim())) throw new Error("Lease time must be a number of seconds");
      const base = [...ROOT, r.network, "subnet", r.subnet];
      const rb = [...base, "range", r.rangeKey];
      const opt = [...base, "option"];
      const cmds = [
        ...diffSingle(rb, "start", before.start, v.start),
        ...diffSingle(rb, "stop", before.stop, v.stop),
        ...diffSingle(opt, "default-router", before.gw, v.gw),
        ...diffMulti(opt, "name-server", before.dns, v.dns.split(/[\s,]+/).filter(Boolean)),
        ...diffSingle(opt, "domain-name", before.domain, v.domain),
        ...diffSingle(base, "lease", before.lease, v.lease),
      ];
      if (v.disabled !== before.disabled) cmds.push({ op: v.disabled ? "set" : "delete", path: [...base, "disable"] });
      if (!cmds.length) return true;
      await applyChanges(cmds, `DHCP ${r.network}`);
      await loaders.Servers();
      return true;
    }, { okLabel: "Apply" });
  }

  async function removeServer(r) {
    const what = r.onlySubnet ? `the whole DHCP server "${r.network}"` : `subnet ${r.subnet} from "${r.network}"`;
    if (!(await confirmBox("Remove DHCP server", `Remove ${what}? Devices keep their address until the lease expires, then get none.`, "Remove"))) return;
    const path = r.onlySubnet ? [...ROOT, r.network] : [...ROOT, r.network, "subnet", r.subnet];
    try {
      await applyChanges([{ op: "delete", path }], `remove DHCP ${r.network}`);
    } catch (e) {
      alertBox("Apply failed", errorText(e));
    }
    loaders.Servers();
  }

  // ---------------- Leases ----------------
  const leases = makeTable(
    [
      { key: "ip", label: "Address", width: "120px" },
      { key: "mac", label: "MAC Address", width: "130px" },
      { key: "hostname", label: "Host Name", width: "150px" },
      { key: "state", label: "Status", width: "80px" },
      { key: "startText", label: "Start", width: "150px" },
      { key: "endText", label: "Expires", width: "150px" },
      { key: "remainingText", label: "Remaining", width: "80px" },
      { key: "pool", label: "Server" },
    ],
    { rowKey: (r) => `${r.ip}|${r.mac}` },
  );
  const family = h("select", h("option", { value: 4 }, "IPv4"), h("option", { value: 6 }, "IPv6"));
  family.addEventListener("change", () => loaders.Leases());
  t.pages.Leases.append(
    h(
      "div.win-toolbar",
      h("button", { title: "Refresh", on: { click: () => loaders.Leases() } }, "⟳"),
      h("button", { title: "Reserve this address for this device", on: { click: makeStatic } }, "Make Static"),
      family,
      h("span.grow"),
      filterBox(leases),
    ),
    leases.wrap,
    leases.count,
  );
  loaders.Leases = async () => {
    try {
      const list = await api.dhcpLeases(Number(family.value));
      leases.setRows(
        (Array.isArray(list) ? list : []).map((l) => ({
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
  };

  async function makeStatic() {
    const l = leases.selected();
    if (!l) return setStatus("Select a lease first.", true);
    if (family.value !== "4") return alertBox("Make Static", "Only IPv4 leases are supported here.");
    await loadConfig();
    const row = subnetRows(networks).find((r) => (!l.pool || r.network === l.pool) && ipv4InCidr(l.ip, r.subnet));
    if (!row) return alertBox("Make Static", `No DHCP subnet contains ${l.ip}.`);
    const suggested = (l.hostname || `host-${l.ip.replaceAll(".", "-")}`).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
    await addStatic({ network: row.network, subnet: row.subnet, name: suggested, ip: l.ip, mac: l.mac });
  }

  // ---------------- Static Mappings ----------------
  const statics = makeTable(
    [
      { key: "name", label: "Name", width: "150px" },
      { key: "ip", label: "Address", width: "120px" },
      { key: "mac", label: "MAC Address", width: "140px" },
      { key: "network", label: "Server", width: "110px" },
      { key: "subnet", label: "Subnet", width: "130px" },
      { key: "description", label: "Comment" },
    ],
    { rowKey: (r) => `${r.network}|${r.subnet}|${r.name}` },
  );
  t.pages["Static Mappings"].append(
    h(
      "div.win-toolbar",
      h("button.icon-add", { on: { click: () => addStatic({}) } }, "+"),
      h("button.icon-remove", { on: { click: removeStatic } }, "−"),
      h("button", { on: { click: () => loaders["Static Mappings"]() } }, "⟳"),
      h("span.grow"),
      filterBox(statics),
    ),
    statics.wrap,
    statics.count,
  );
  loaders["Static Mappings"] = async () => {
    await loadConfig();
    statics.setRows(
      subnetRows(networks).flatMap((r) =>
        Object.entries(r.cfg["static-mapping"] || {}).map(([name, m]) => ({
          name,
          ip: m?.["ip-address"] || "",
          mac: m?.mac || m?.["mac-address"] || "",
          description: m?.description || "",
          network: r.network,
          subnet: r.subnet,
        })),
      ),
    );
  };

  async function addStatic(pre) {
    await loadConfig();
    const rows = subnetRows(networks);
    if (!rows.length) return alertBox("Static Mapping", "Create a DHCP server first.");
    const options = rows.map((r) => ({ value: `${r.network}|${r.subnet}`, label: `${r.network} (${r.subnet})` }));
    await formDialog("Static Mapping", [
      { name: "where", label: "Server", type: "select", options, value: pre.network ? `${pre.network}|${pre.subnet}` : options[0].value },
      { name: "name", label: "Name", value: pre.name || "" },
      { name: "ip", label: "IP Address", value: pre.ip || "" },
      { name: "mac", label: "MAC Address", value: pre.mac || "", placeholder: "aa:bb:cc:dd:ee:ff" },
    ], async (v) => {
      const [network, subnet] = v.where.split("|");
      const name = v.name.trim();
      if (!NAME_RE.test(name)) throw new Error("Name: letters, digits, - _ . only");
      checkIp(v.ip.trim(), subnet, "IP Address");
      if (!MAC_RE.test(v.mac.trim())) throw new Error("MAC must look like aa:bb:cc:dd:ee:ff");
      const cfg = rows.find((r) => r.network === network && r.subnet === subnet)?.cfg || {};
      if (cfg["static-mapping"]?.[name]) throw new Error(`A mapping named ${name} already exists`);
      const base = [...ROOT, network, "subnet", subnet, "static-mapping", name];
      await applyChanges(
        [
          { op: "set", path: [...base, "ip-address"], value: v.ip.trim() },
          { op: "set", path: [...base, "mac"], value: v.mac.trim().toLowerCase() },
        ],
        `static mapping ${name}`,
      );
      loaders["Static Mappings"]();
      return true;
    }, { okLabel: "Apply" });
  }

  async function removeStatic() {
    const r = statics.selected();
    if (!r) return setStatus("Select a mapping first.", true);
    if (!(await confirmBox("Remove", `Remove static mapping ${r.name} (${r.ip})?`, "Remove"))) return;
    try {
      await applyChanges([{ op: "delete", path: [...ROOT, r.network, "subnet", r.subnet, "static-mapping", r.name] }], `remove mapping ${r.name}`);
    } catch (e) {
      alertBox("Apply failed", errorText(e));
    }
    loaders["Static Mappings"]();
  }

  t.select(startTab);
  const timer = setInterval(() => {
    if (t.pages.Leases.classList.contains("active")) loaders.Leases();
  }, 15000);
  win.onClose(() => clearInterval(timer));
}
