// VPN page, "VPN client" section (UniFi Traffic Routes): connect the router
// to a VPN provider and choose which devices, groups or networks use it.
import { api, errorText } from "../lib/api.js";
import { h, clear, formatBytes, formatAge } from "../lib/dom.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges } from "../lib/session.js";
import { icon } from "../lib/icons.js";
import { wanInfo } from "../lib/wan.js";
import { readNetworks } from "../lib/netplan.js";
import { readGroups } from "../lib/devgroups.js";
import { readClients, parseWgConf, addClientCommands, routeCommands, removeClientCommands, killSwitchCommands, tunnelState } from "../lib/vpnclient.js";
import { deviceList, deviceOptions, macOf } from "./groups.js";

const ONLINE_SECS = 180;
const CIDR_IN = /(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})\s*$/;

async function loadState() {
  const [cfg, dump, w] = await Promise.all([
    api.getConfig([]).then((c) => c || {}),
    api.wireguardDump().catch(() => ""),
    wanInfo(),
  ]);
  const nets = readNetworks(cfg, w.wan);
  return { cfg, dump, nets, lanIfaces: nets.map((n) => n.iface), clients: readClients(cfg) };
}

/** The section element; it loads itself. onChange re-renders the page. */
export function vpnClientSection(onChange) {
  const body = h("div", h("div.hint", "Loading…"));
  const el = h("section.vpn-server",
    h("div.vpn-head",
      h("span.net-icon", icon("globe", 18)),
      h("div.grow",
        h("div.net-name", "VPN client"),
        h("div.hint", "Send chosen devices through a VPN provider (Mullvad, Proton VPN, IVPN, …) with WireGuard. The rest of your network keeps using your normal internet.")),
      h("button", { on: { click: () => add().then((ok) => ok && onChange()) } }, icon("plus", 14), "Add VPN client")),
    body);
  load();
  el.refresh = load; // updates in place (no "Loading…" flash)
  return el;

  async function load() {
    let st;
    try {
      st = await loadState();
    } catch (e) {
      clear(body).append(h("div.err-box", errorText(e)));
      return;
    }
    const devs = await deviceList();
    clear(body).append(st.clients.length
      ? h("div.rule-grid", st.clients.map((c) => card(st, c, devs)))
      : h("div.hint", "None yet. Download a WireGuard config file from your VPN provider's website, then press Add VPN client."));
  }

  function card(st, c, devs) {
    const t = tunnelState(st.dump, c.iface);
    const up = t?.handshake && Date.now() / 1000 - t.handshake < ONLINE_SECS;
    const groups = readGroups(st.cfg);
    const who = [
      ...c.routes.macs.map((m) => devs.find((d) => d.mac === m)?.label || m),
      ...c.routes.groups.map((g) => `group ${groups.find((x) => x.gname === g)?.name || g}`),
      ...c.routes.networks.map((n) => st.nets.find((x) => x.network === n)?.name || n),
    ];
    const ks = h("input", { type: "checkbox", checked: c.killSwitch });
    ks.addEventListener("change", async () => {
      try {
        await applyChanges(killSwitchCommands(st.cfg, c, ks.checked), `${ks.checked ? "turn on" : "turn off"} the kill switch for ${c.name}`);
      } catch (e) {
        if (!/^Cancelled/.test(e?.message || "")) alertBox("Kill switch", errorText(e));
      }
      onChange();
    });
    return h("div.rule-card", { style: { cursor: "default" } },
      h("div.rule-top",
        h("span.rule-icon", icon("vpn", 18)),
        h("div.grow", h("div.rule-name", c.name), h("div.hint", `${c.iface} · ${c.host}:${c.port}`))),
      h("div.badges",
        up ? h("span.badge.ok", "Connected") : h("span.badge.bad", t?.handshake ? `Not connected (last ${formatAge(t.handshake)})` : "Not connected yet"),
        t && (t.rx || t.tx) ? h("span.badge", `↓ ${formatBytes(t.rx)} · ↑ ${formatBytes(t.tx)}`) : null),
      h("dl.kv-list",
        h("dt", "Used by"), h("dd", { title: who.join("\n") }, who.length ? who.join(", ") : "nobody yet"),
        h("dt", "Kill switch"), h("dd", h("label", { title: "If the VPN goes down, these devices get no internet instead of using your normal line" }, ks, c.killSwitch ? " on: no internet if the VPN is down" : " off: falls back to your normal line"))),
      h("div.card-actions",
        h("button", { on: { click: () => chooseRoutes(st, c).then((ok) => ok && onChange()) } }, "Choose devices…"),
        h("span.grow"),
        h("button.danger", { on: { click: () => remove(st, c).then((ok) => ok && onChange()) } }, icon("trash", 14), "Remove")));
  }

  async function add() {
    let st;
    try {
      st = await loadState();
    } catch (e) {
      alertBox("VPN client", errorText(e));
      return false;
    }
    let made = null;
    await formDialog("Add VPN client", [
      { name: "name", label: "Name", placeholder: "e.g. Mullvad Sweden" },
      { name: "conf", label: "WireGuard config", type: "textarea", rows: 9, placeholder: "[Interface]\nPrivateKey = …\nAddress = …\n\n[Peer]\nPublicKey = …\nEndpoint = …", hint: "From your provider's website (Mullvad: Account → WireGuard configuration; Proton VPN: Downloads → WireGuard). Open the .conf file in a text editor and paste it here. The private key is stored on the router only." },
      { name: "killSwitch", label: "Kill switch: no internet for these devices if the VPN is down", type: "checkbox", value: true },
    ], async (v) => {
      const w = parseWgConf(v.conf);
      const { iface, cmds } = addClientCommands(st.cfg, v);
      await applyChanges(cmds, `VPN client ${v.name.trim()}`);
      made = { iface, dns: w.dns };
      return true;
    }, { okLabel: "Add", intro: "The router connects to the provider; nothing goes through it until you choose devices next." });
    if (!made) return false;
    try {
      st = await loadState();
    } catch {
      return true;
    }
    const c = st.clients.find((x) => x.iface === made.iface);
    if (c) await chooseRoutes(st, c, made.dns);
    return true;
  }

  async function chooseRoutes(st, c, providerDns = []) {
    const devs = await deviceList();
    const devOpts = deviceOptions(devs, c.routes.macs);
    const groups = readGroups(st.cfg);
    const netOpts = st.nets.map((n) => `${n.name} — ${n.network}`);
    let ok = false;
    await formDialog(`Through ${c.name}`, [
      { name: "devices", label: "Devices", type: "multicheck", value: devOpts.filter((o) => c.routes.macs.includes(macOf(o))), options: devOpts },
      { name: "groups", label: "Device groups", type: "multicheck", value: groups.filter((g) => c.routes.groups.includes(g.gname)).map((g) => g.name), options: groups.map((g) => g.name), hint: groups.length ? "Devices added to a group later use the VPN too." : "Make groups on the Clients page (Groups…)." },
      { name: "networks", label: "Whole networks", type: "multicheck", value: netOpts.filter((o) => c.routes.networks.includes(o.match(CIDR_IN)?.[1])), options: netOpts },
    ], async (v) => {
      const routes = {
        macs: v.devices.map(macOf).filter(Boolean),
        groups: groups.filter((g) => v.groups.includes(g.name)).map((g) => g.gname),
        networks: v.networks.map((o) => o.match(CIDR_IN)?.[1]).filter(Boolean),
      };
      const cmds = routeCommands(st.cfg, c.iface, routes, st.lanIfaces);
      if (cmds.length) await applyChanges(cmds, `devices through ${c.name}`);
      ok = true;
      return true;
    }, {
      okLabel: "Apply",
      intro: `Their internet traffic goes through ${c.name}; traffic to your own networks and the router stays local. Name lookups (DNS) still go through the router${providerDns.length ? `: for full privacy, set ${providerDns.join(", ")} (the provider's DNS) as DNS server on those devices` : ""}.`,
    });
    return ok;
  }

  async function remove(st, c) {
    if (!(await confirmBox("Remove VPN client", `Remove ${c.name}? Its devices go back to your normal internet.`, "Remove"))) return false;
    try {
      await applyChanges(removeClientCommands(st.cfg, c, st.lanIfaces), `remove VPN client ${c.name}`);
      return true;
    } catch (e) {
      if (!/^Cancelled/.test(e?.message || "")) alertBox("Remove VPN client", errorText(e));
      return false;
    }
  }
}
