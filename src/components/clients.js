// Clients: a UniFi-style list of devices on the network, with a detail panel
// and actions (rename, fixed IP, block, ping).
import { api, errorText } from "../lib/api.js";
import { h, clear, setStatus, formatBytes, formatAge } from "../lib/dom.js";
import { makeTable } from "../lib/table.js";
import { registerView, showView } from "../lib/views.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges, isConnected } from "../lib/session.js";
import { collectClients, BLOCK_GROUP } from "../lib/netdata.js";
import { toArray, ipv4InCidr } from "../lib/vyos.js";
import { openPing } from "./tools.js";
import { editQueue } from "./queues.js";
import { dnsSummary, dnsHitsByIp, openDnsServer } from "./technitium.js";

const FILTERS = [
  ["all", "All", () => true],
  ["online", "Online", (c) => c.online],
  ["offline", "Offline", (c) => !c.online],
  ["wired", "LAN", (c) => c.kind !== "vpn"],
  ["vpn", "VPN", (c) => c.kind === "vpn"],
  ["fixed", "Fixed IP", (c) => c.fixedIp],
  ["blocked", "Blocked", (c) => c.blocked],
];

/** Commands to block a MAC: add it to the VyGi mac-group, create the drop rule once. */
export function blockCommands(mac, cfg) {
  const group = ["firewall", "group", "mac-group", BLOCK_GROUP];
  const cmds = [{ op: "set", path: [...group, "mac-address"], value: mac }];
  const rules = cfg?.ipv4?.forward?.filter?.rule || {};
  const exists = Object.values(rules).some((r) => r?.source?.group?.["mac-group"] === BLOCK_GROUP);
  if (!exists) {
    let n = 1;
    while (rules[String(n)] && n < 9) n++;
    if (rules[String(n)]) throw new Error("Firewall forward rules 1-9 are all taken; free one so the block rule can run first.");
    const r = ["firewall", "ipv4", "forward", "filter", "rule", String(n)];
    cmds.push(
      { op: "set", path: [...r, "action"], value: "drop" },
      { op: "set", path: [...r, "source", "group", "mac-group"], value: BLOCK_GROUP },
      { op: "set", path: [...r, "description"], value: "VyGi: blocked clients" },
    );
  }
  return cmds;
}

/** Commands to unblock; removes the rule and group when the last MAC goes. */
export function unblockCommands(mac, cfg) {
  const members = toArray(cfg?.group?.["mac-group"]?.[BLOCK_GROUP]?.["mac-address"]).map((m) => m.toLowerCase());
  if (members.length > 1) return [{ op: "delete", path: ["firewall", "group", "mac-group", BLOCK_GROUP, "mac-address", mac] }];
  const cmds = [];
  for (const [n, r] of Object.entries(cfg?.ipv4?.forward?.filter?.rule || {})) {
    if (r?.source?.group?.["mac-group"] === BLOCK_GROUP) cmds.push({ op: "delete", path: ["firewall", "ipv4", "forward", "filter", "rule", n] });
  }
  cmds.push({ op: "delete", path: ["firewall", "group", "mac-group", BLOCK_GROUP] });
  return cmds;
}

export function initClients() {
  const root = document.getElementById("clients");
  let clients = [];
  let dnsHits = null; // ip -> DNS queries in the last hour, when Technitium is linked
  let filter = "all";
  let search = "";
  let selectedKey = null;
  let timer = null;

  const chipsEl = h("div.clients-bar");
  const searchEl = h("input", { type: "text", placeholder: "Search name, IP or MAC", style: { width: "240px" }, on: { input: (e) => { search = e.target.value.trim().toLowerCase(); render(); } } });
  const summary = h("span.hint");
  const side = h("aside.side", { hidden: true });
  const table = makeTable(
    [
      { key: "statusDot", label: "", width: "26px", render: (c) => h(`span.dot${c.online ? ".on" : ""}`, { title: c.online ? "online" : "offline" }) },
      { key: "label", label: "Name", render: (c) => h("div", h("div.client-name", c.label), h("div.client-sub", c.mac || (c.kind === "vpn" ? "WireGuard peer" : ""))) },
      { key: "ip", label: "IP Address", width: "130px" },
      { key: "network", label: "Network", width: "100px", render: (c) => c.network || c.iface || "" },
      { key: "kind", label: "Connection", width: "100px", render: (c) => (c.kind === "vpn" ? "VPN" : "Wired / LAN") },
      { key: "tags", label: "", width: "190px", render: (c) => h("span", c.blocked ? h("span.tag.bad", "blocked") : null, c.fixedIp ? h("span.tag", "fixed IP") : null, c.privateMac ? h("span.tag", "private MAC") : null, c.source.includes("dhcp") ? h("span.tag", "DHCP") : null) },
      { key: "connections", label: "Activity", width: "90px", className: "num", render: (c) => (c.connections ? `${c.connections} conn.` : "") },
    ],
    {
      rowKey: (c) => c.key,
      onSelect: (c) => { selectedKey = c.key; renderSide(); },
      rowClass: (c) => (c.online ? "" : "disabled"),
    },
  );
  table.wrap.style.flex = "1";

  root.append(h("div.clients",
    h("div.clients-main",
      h("div.clients-bar", h("h2", { style: { margin: "0 8px 0 0", fontSize: "18px" } }, "Clients"), searchEl, h("button", { on: { click: load } }, "⟳ Refresh"), summary),
      chipsEl, table.wrap),
    side));

  function render() {
    clear(chipsEl);
    for (const [id, label, fn] of FILTERS) {
      const n = clients.filter(fn).length;
      chipsEl.append(h(`button.chip${filter === id ? ".on" : ""}`, { on: { click: () => { filter = id; render(); } } }, `${label} ${n}`));
    }
    const fn = FILTERS.find((f) => f[0] === filter)[2];
    const rows = clients.filter(fn).filter((c) => !search || [c.label, c.ip, c.mac, c.network].some((v) => String(v || "").toLowerCase().includes(search)));
    table.setRows(rows);
    renderSide();
  }

  function renderSide() {
    const c = clients.find((x) => x.key === selectedKey);
    side.hidden = !c;
    if (!c) return;
    const row = (k, v) => (v ? [h("dt", k), h("dd", { title: String(v) }, String(v))] : []);
    clear(side).append(
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "start", gap: "8px" } },
        h("h2", c.label),
        h("button", { title: "Close", on: { click: () => { selectedKey = null; side.hidden = true; } } }, "✕")),
      h("div", h(`span.pill.${c.online ? "ok" : "muted"}`, c.online ? "online" : "offline"), " ", c.blocked ? h("span.pill.bad", "blocked") : null),
      h("dl.kv-list",
        ...row("IP address", c.ip),
        ...row("IPv6", c.ip6?.join(", ")),
        ...row("MAC", c.mac),
        ...row("Network", c.network),
        ...row("Interface", c.iface),
        ...row("Connection", c.kind === "vpn" ? "VPN (WireGuard)" : "Wired / LAN"),
        ...row("Endpoint", c.endpoint),
        ...row("Last handshake", c.lastSeen ? formatAge(c.lastSeen) : ""),
        ...row("Traffic", c.rx != null ? `↓ ${formatBytes(c.rx)} ↑ ${formatBytes(c.tx)}` : ""),
        ...row("Active connections", c.connections ? String(c.connections) : ""),
        ...row("DNS queries (1 h)", dnsHits && c.ip ? (dnsHits.get(c.ip) ?? 0).toLocaleString() : ""),
        ...row("Neighbor state", c.state),
        ...row("Known from", c.source.join(", ")),
        ...row("MAC type", c.privateMac ? "private (randomized)" : c.mac ? "hardware" : "")),
      c.privateMac ? h("div.hint", "This device uses a private MAC address. Phones may change it per network or over time, which breaks fixed IPs and blocking.") : null,
      h("div.actions",
        c.ip ? h("button", { on: { click: () => rename(c) } }, "Rename") : null,
        c.mac && c.ip && c.kind !== "vpn" && !c.fixedIp ? h("button", { on: { click: () => fixIp(c) } }, "Fix IP") : null,
        c.mac && c.kind !== "vpn" ? h("button", { style: { color: c.blocked ? "var(--ok)" : "var(--bad)" }, on: { click: () => toggleBlock(c) } }, c.blocked ? "Unblock" : "Block") : null,
        c.ip && c.kind !== "vpn" && !c.ip.includes(":") ? h("button", { title: "Limit this device's download/upload speed (Simple Queue)", on: { click: () => editQueue({ ip: c.ip, name: c.name }) } }, "Limit speed") : null,
        c.ip ? h("button", { on: { click: () => { showView("windows"); openPing(); setTimeout(() => { const i = document.querySelector('.mdi-win.active input'); if (i) i.value = c.ip; }, 0); } } }, "Ping") : null,
        dnsHits && c.ip ? h("button", { title: "This device's DNS queries in Technitium", on: { click: () => { showView("windows"); openDnsServer({ client: c.ip }); } } }, "DNS log") : null,
        c.ip ? h("button", { on: { click: () => navigator.clipboard?.writeText(c.ip).then(() => setStatus(`Copied ${c.ip}`)).catch(() => setStatus(c.ip)) } }, "Copy IP") : null),
    );
  }

  async function load() {
    if (!isConnected()) {
      clients = [];
      summary.textContent = "Not connected.";
      render();
      return;
    }
    try {
      let sum;
      [{ clients }, sum] = await Promise.all([collectClients(), dnsSummary().catch(() => null)]);
      dnsHits = sum && !sum.error ? dnsHitsByIp(sum) : null;
      summary.textContent = `${clients.filter((c) => c.online).length} online · updated ${new Date().toLocaleTimeString()}`;
      render();
    } catch (e) {
      summary.textContent = errorText(e);
    }
  }

  async function rename(c) {
    await formDialog(`Rename ${c.label}`, [
      { name: "name", label: "Name", value: c.name || "", hint: c.fixedIp ? "Renames the fixed-IP mapping and the local DNS name." : "Adds a local DNS name (name.lan style) for this IP." },
    ], async (v) => {
      const name = v.name.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(name)) throw new Error("Use letters, digits, dots and hyphens");
      const cmds = [];
      const hosts = (await api.getConfig(["system", "static-host-mapping", "host-name"])) || {};
      for (const [hn, hcfg] of Object.entries(hosts)) {
        if (hn !== name && toArray(hcfg?.inet).includes(c.ip)) cmds.push({ op: "delete", path: ["system", "static-host-mapping", "host-name", hn] });
      }
      if (!toArray(hosts[name]?.inet).includes(c.ip)) cmds.push({ op: "set", path: ["system", "static-host-mapping", "host-name", name, "inet"], value: c.ip });
      if (c.fixed && c.fixed.name !== name && /^[A-Za-z0-9._-]{1,64}$/.test(name)) {
        const base = ["service", "dhcp-server", "shared-network-name", c.fixed.network, "subnet", c.fixed.subnet, "static-mapping"];
        cmds.push(
          { op: "delete", path: [...base, c.fixed.name] },
          { op: "set", path: [...base, name, "ip-address"], value: c.fixed.ip },
          { op: "set", path: [...base, name, "mac"], value: c.mac },
        );
      }
      if (cmds.length) await applyChanges(cmds, `rename ${name}`);
      await load();
      return true;
    }, { okLabel: "Apply" });
  }

  async function fixIp(c) {
    const nets = (await api.getConfig(["service", "dhcp-server", "shared-network-name"])) || {};
    let where = null;
    for (const [net, n] of Object.entries(nets)) for (const cidr of Object.keys(n?.subnet || {})) if (ipv4InCidr(c.ip, cidr)) where = { net, cidr };
    if (!where) return alertBox("Fix IP", `No DHCP server covers ${c.ip}. Set up a DHCP server for this network first.`);
    const suggested = (c.name || `host-${c.ip.replaceAll(".", "-")}`).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
    await formDialog(`Fix IP for ${c.label}`, [
      { name: "name", label: "Name", value: suggested },
      { name: "ip", label: "IP address", value: c.ip },
    ], async (v) => {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(v.name.trim())) throw new Error("Name: letters, digits, - _ .");
      if (!ipv4InCidr(v.ip.trim(), where.cidr)) throw new Error(`${v.ip} is not inside ${where.cidr}`);
      const base = ["service", "dhcp-server", "shared-network-name", where.net, "subnet", where.cidr, "static-mapping", v.name.trim()];
      await applyChanges([{ op: "set", path: [...base, "ip-address"], value: v.ip.trim() }, { op: "set", path: [...base, "mac"], value: c.mac }], `fix IP ${v.ip}`);
      await load();
      return true;
    }, { okLabel: "Apply" });
  }

  async function toggleBlock(c) {
    let fw;
    try {
      fw = (await api.getConfig(["firewall"])) || {};
    } catch (e) {
      return alertBox("Block", errorText(e));
    }
    try {
      if (c.blocked) {
        await applyChanges(unblockCommands(c.mac, fw), `unblock ${c.label}`);
      } else {
        const ok = await confirmBox("Block client", `Block ${c.label} (${c.mac}) from reaching the internet and other networks?\n\nIt can still reach the router itself. Devices with a private MAC can escape this by changing their MAC.`, "Block");
        if (!ok) return;
        await applyChanges(blockCommands(c.mac, fw), `block ${c.label}`);
      }
    } catch (e) {
      return alertBox("Failed", errorText(e));
    }
    await load();
  }

  registerView("clients", {
    show: () => {
      load();
      timer = setInterval(load, 15000);
    },
    hide: () => clearInterval(timer),
  });
  render();
}
