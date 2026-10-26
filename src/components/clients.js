// Clients: a UniFi-style list of devices on the network, with a detail panel
// and actions (rename, fixed IP, block, ping).
import { api, errorText } from "../lib/api.js";
import { h, clear, setStatus, formatBytes, formatAge, formatBits, every } from "../lib/dom.js";
import { makeTable } from "../lib/table.js";
import { registerView, showView, welcome } from "../lib/views.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges, isConnected } from "../lib/session.js";
import { collectClients, BLOCK_GROUP } from "../lib/netdata.js";
import { toArray, ipv4InCidr } from "../lib/vyos.js";
import { openPing } from "./tools.js";
import { editQueue } from "./queues.js";
import { openGroups, editDeviceGroups } from "./groups.js";
import { readGroups, groupsOf } from "../lib/devgroups.js";
import { dnsSummary, dnsHitsByIp, openDnsServer } from "./technitium.js";
import { loadSites, siteRows, sitesFootnote } from "../lib/activity.js";
import { iconsEnabled, setIconsEnabled } from "../lib/siteicon.js";

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

/** "↓ 1.2 Mbps ↑ 80 kbps" when traffic counting is on, else the connection count. */
function activity(c) {
  if (c.down != null) {
    if (!c.rateReady) return "measuring…";
    if (c.down + c.up < 1) return c.connections ? "idle" : "";
    return h("span", { title: `${c.connections} connections` }, `↓ ${formatBits(c.down * 8)} ↑ ${formatBits(c.up * 8)}`);
  }
  return c.connections ? `${c.connections} conn.` : "";
}

let focusRequest = null; // { key, text } from the search bar, applied on the next load

/** Opens Clients filtered to one device, with its details (used by the search bar). */
export function openClient(key, text) {
  focusRequest = { key, text };
  showView("clients");
}

export function initClients() {
  const root = document.getElementById("clients");
  let clients = [];
  let dnsHits = null; // ip -> DNS queries in the last hour, when Technitium is linked
  let filter = "all";
  let groups = []; // device groups (devgroups.js)
  let search = "";
  let selectedKey = null;
  let timer = null;

  const chipsEl = h("div.clients-bar");
  const searchEl = h("input", { type: "text", placeholder: "Search name, IP or MAC", style: { width: "240px" }, on: { input: (e) => { search = e.target.value.trim().toLowerCase(); render(); } } });
  const summary = h("span.hint");
  const acctBanner = h("div.warn-box", { hidden: true, style: { margin: "0 0 8px" } },
    "Per-device download/upload speeds need the router to count bytes per connection (off by default in VyOS; a small CPU cost). ",
    h("button", { on: { click: enableAccounting } }, "Turn on traffic counting"));
  const side = h("aside.side", { hidden: true });
  const table = makeTable(
    [
      { key: "statusDot", label: "", width: "26px", render: (c) => h(`span.dot${c.online ? ".on" : ""}`, { title: c.online ? "online" : "offline" }) },
      { key: "label", label: "Name", render: (c) => h("div", h("div.client-name", c.label), h("div.client-sub", c.mac || (c.kind === "vpn" ? "WireGuard peer" : ""))) },
      { key: "ip", label: "IP Address", width: "112px" },
      { key: "network", label: "Network", width: "84px", render: (c) => c.network || c.iface || "" },
      { key: "kind", label: "Connection", width: "100px", render: (c) => (c.kind === "vpn" ? "VPN" : "Wired / LAN") },
      { key: "tags", label: "", width: "150px", render: (c) => h("span", c.blocked ? h("span.tag.bad", "blocked") : null, ...groupsOf(groups, c.mac || "").map((g) => h("span.tag.group", g.name)), c.fixedIp ? h("span.tag", "fixed IP") : null, c.privateMac ? h("span.tag", "private MAC") : null, c.source.includes("dhcp") ? h("span.tag", "DHCP") : null) },
      { key: "activity", label: "Activity", width: "190px", className: "num", render: activity },
    ],
    {
      rowKey: (c) => c.key,
      onSelect: (c) => { selectedKey = c.key; renderSide(); },
      rowClass: (c) => (c.online ? "" : "disabled"),
    },
  );
  table.wrap.style.flex = "1";

  const welcomeEl = welcome(() => document.getElementById("btn-connect").click());
  root.append(welcomeEl);
  root.append(h("div.clients",
    h("div.clients-main",
      h("div.clients-bar", searchEl, h("button", { on: { click: load } }, "⟳ Refresh"), h("button", { title: "Groups of devices, for Traffic Rules, the VPN client and speed limits", on: { click: () => openGroups(load) } }, "Groups…"), summary, h("span.grow"),
        h("label.hint", { title: "Site icons are downloaded from each site itself (no third-party service) and cached on this computer." },
          h("input", { type: "checkbox", checked: iconsEnabled(), on: { change: (e) => { setIconsEnabled(e.target.checked); sitesFor = null; renderSide(); } } }), " Site icons")),
      acctBanner, chipsEl, table.wrap),
    side));

  function render() {
    clear(chipsEl);
    const filters = [...FILTERS, ...groups.map((g) => [`g:${g.id}`, g.name, (c) => g.macs.includes(c.mac)])];
    if (!filters.some((f) => f[0] === filter)) filter = "all";
    for (const [id, label, fn] of filters) {
      const n = clients.filter(fn).length;
      chipsEl.append(h(`button.chip${filter === id ? ".on" : ""}${id.startsWith("g:") ? ".group" : ""}`, { on: { click: () => { filter = id; render(); } } }, `${label} ${n}`));
    }
    const fn = filters.find((f) => f[0] === filter)[2];
    const rows = clients.filter(fn).filter((c) => !search || [c.label, c.ip, c.mac, c.network].some((v) => String(v || "").toLowerCase().includes(search)));
    table.setRows(rows);
    renderSide();
  }

  // Sites of the selected device; kept between refreshes to avoid flicker.
  const sitesBox = h("div", h("div.hint", "Loading…"));
  let sitesFor = null;
  async function fillSites(c) {
    if (sitesFor !== c.key) {
      sitesFor = c.key;
      sitesBox.replaceChildren(h("div.hint", "Loading…"));
    }
    const res = await loadSites({ client: c.ip });
    if (sitesFor !== c.key) return;
    sitesBox.replaceChildren(
      res.measured ? siteRows(res.sites) : h("div.hint", "Measuring…"),
      sitesFootnote(res, () => fillSites(c)));
  }

  function renderSide() {
    const c = clients.find((x) => x.key === selectedKey);
    side.hidden = !c;
    if (!c) return;
    if (c.ip && c.down != null) fillSites(c).catch(() => {});
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
        ...row("Groups", groupsOf(groups, c.mac || "").map((g) => g.name).join(", ")),
        ...row("Network", c.network),
        ...row("Interface", c.iface),
        ...row("Connection", c.kind === "vpn" ? "VPN (WireGuard)" : "Wired / LAN"),
        ...row("Endpoint", c.endpoint),
        ...row("Last handshake", c.lastSeen ? formatAge(c.lastSeen) : ""),
        ...row("Traffic", c.rx != null ? `↓ ${formatBytes(c.rx)} ↑ ${formatBytes(c.tx)}` : ""),
        ...row("Active connections", c.connections ? String(c.connections) : ""),
        ...row("Download now", c.down != null && c.rateReady ? formatBits(c.down * 8) : ""),
        ...row("Upload now", c.down != null && c.rateReady ? formatBits(c.up * 8) : ""),
        ...row("Data (open conn.)", c.totalDown != null ? `↓ ${formatBytes(c.totalDown)} ↑ ${formatBytes(c.totalUp)}` : ""),
        ...row("DNS queries (1 h)", dnsHits && c.ip ? (dnsHits.get(c.ip) ?? 0).toLocaleString() : ""),
        ...row("Neighbor state", c.state),
        ...row("Known from", c.source.join(", ")),
        ...row("MAC type", c.privateMac ? "private (randomized)" : c.mac ? "hardware" : "")),
      c.privateMac ? h("div.hint", "This device uses a private MAC address. Phones may change it per network or over time, which breaks fixed IPs and blocking.") : "", // append() would print null
      c.ip && c.down != null ? h("div", h("h3", { style: { margin: "14px 0 4px" } }, "Sites"), sitesBox) : "",
      h("div.actions",
        c.ip ? h("button", { on: { click: () => rename(c) } }, "Rename") : null,
        c.mac && c.iface && c.kind !== "vpn" && !c.online ? h("button", { title: "Send a Wake-on-LAN packet (the device must have Wake-on-LAN turned on)", on: { click: () => wake(c) } }, "Wake up") : null,
        c.mac && c.ip && c.kind !== "vpn" && !c.fixedIp ? h("button", { on: { click: () => fixIp(c) } }, "Fix IP") : null,
        c.mac && c.kind !== "vpn" ? h("button", { on: { click: async () => (await editDeviceGroups(c.mac, c.label)) && load() } }, "Groups…") : null,
        c.mac && c.kind !== "vpn" ? h("button", { style: { color: c.blocked ? "var(--ok)" : "var(--bad)" }, on: { click: () => toggleBlock(c) } }, c.blocked ? "Unblock" : "Block") : null,
        c.ip && c.kind !== "vpn" && !c.ip.includes(":") ? h("button", { title: "Limit this device's download/upload speed (Simple Queue)", on: { click: () => editQueue({ ip: c.ip, name: c.name }) } }, "Limit speed") : null,
        c.ip ? h("button", { on: { click: () => { showView("windows"); openPing(); setTimeout(() => { const i = document.querySelector('.mdi-win.active input'); if (i) i.value = c.ip; }, 0); } } }, "Ping") : null,
        dnsHits && c.ip ? h("button", { title: "This device's DNS queries in Technitium", on: { click: () => { showView("windows"); openDnsServer({ client: c.ip }); } } }, "DNS log") : null,
        c.ip ? h("button", { on: { click: () => navigator.clipboard?.writeText(c.ip).then(() => setStatus(`Copied ${c.ip}`)).catch(() => setStatus(c.ip)) } }, "Copy IP") : null),
    );
  }

  async function load() {
    welcomeEl.hidden = isConnected();
    if (!isConnected()) {
      clients = [];
      summary.textContent = "Not connected.";
      render();
      return;
    }
    try {
      let sum;
      let traffic;
      let macGroups;
      [{ clients, traffic }, sum, macGroups] = await Promise.all([
        collectClients(),
        dnsSummary().catch(() => null),
        api.getConfig(["firewall", "group", "mac-group"]).catch(() => ({})),
      ]);
      groups = readGroups({ firewall: { group: { "mac-group": macGroups || {} } } });
      acctBanner.hidden = traffic.accounting || !clients.some((c) => c.connections);
      if (traffic.accounting && !traffic.ready) setTimeout(() => !root.hidden && load(), 3000); // second sample for rates
      dnsHits = sum && !sum.error ? dnsHitsByIp(sum) : null;
      summary.textContent = `${clients.filter((c) => c.online).length} online · updated ${new Date().toLocaleTimeString()}`;
      if (focusRequest) {
        searchEl.value = focusRequest.text;
        search = focusRequest.text.toLowerCase();
        if (clients.some((c) => c.key === focusRequest.key)) selectedKey = focusRequest.key;
        focusRequest = null;
        renderSide();
      }
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

  async function wake(c) {
    try {
      await api.wakeOnLan(c.iface, c.mac);
      setStatus(`Wake-up packet sent to ${c.label}. It can take a minute to come online.`);
    } catch (e) {
      alertBox("Wake up", errorText(e));
    }
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

  async function enableAccounting() {
    try {
      await applyChanges([{ op: "set", path: ["system", "sysctl", "parameter", "net.netfilter.nf_conntrack_acct", "value"], value: "1" }], "turn on per-connection traffic counting");
      // also live: when the setting was already there (the router lost it after a restart) the commit changes nothing
      await api.accountingSync();
      setStatus("Traffic counting is on. Speeds appear for connections opened from now on.");
      load();
    } catch (e) {
      alertBox("Failed", errorText(e));
    }
  }

  registerView("clients", {
    show: () => {
      load();
      timer = every(load, 10000);
    },
    hide: () => clearInterval(timer),
  });
  render();
}
