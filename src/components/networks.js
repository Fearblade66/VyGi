// Networks page (UniFi-style): every LAN/VLAN as a card, plus a guided
// "New network" form that sets up the interface, DHCP, DNS, NAT, internet
// access and isolation in one Safe Mode commit.
import { api, errorText } from "../lib/api.js";
import { h, clear, setStatus, every } from "../lib/dom.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges, isConnected, session, onSessionChange } from "../lib/session.js";
import { registerView, welcome, loadingPage, showView } from "../lib/views.js";
import { icon } from "../lib/icons.js";
import { toArray, ipv4InCidr, parseIpv4Cidr } from "../lib/vyos.js";
import { renderPorts } from "./topology_view.js";

const VIEW_KEY = "vygi.networks.view";
const getView = () => {
  try {
    return localStorage.getItem(VIEW_KEY) === "ports" ? "ports" : "networks";
  } catch {
    return "networks";
  }
};
import { readNetworks, suggestSubnet, suggestVlan, suggestPool, networkCommands, deleteNetworkCommands } from "../lib/netplan.js";

const ipNum = (ip) => ip.split(".").reduce((a, b) => a * 256 + Number(b), 0);

const PRESETS = {
  standard: { label: "Standard (trusted devices)", internet: true, isolate: false },
  guest: { label: "Guest (internet only, isolated)", internet: true, isolate: true },
  iot: { label: "IoT / cameras (isolated, no internet)", internet: false, isolate: true },
};

async function loadState() {
  const [cfg, routes, links, neighbors, leases] = await Promise.all([
    api.getConfig([]),
    api.routes(4, "default").catch(() => []),
    api.interfaceStats().then((s) => s.links || []).catch(() => []),
    api.neighbors().catch(() => []),
    api.dhcpLeases(4).catch(() => []),
  ]);
  const def = routes.find((r) => r.dst === "default");
  const wan = def?.dev || (def?.nexthops || [])[0]?.dev || "";
  return { cfg: cfg || {}, wan, links, neighbors, leases: Array.isArray(leases) ? leases : [] };
}

/** Ethernet ports with no address and not in a bridge (for "separate port"). */
function freePorts(st) {
  const eth = st.cfg.interfaces?.ethernet || {};
  const bridged = new Set(Object.values(st.cfg.interfaces?.bridge || {}).flatMap((b) => Object.keys(b?.member?.interface || {})));
  const names = new Set([...Object.keys(eth), ...st.links.filter((l) => l.link_type === "ether" && /^eth\d+$/.test(l.ifname)).map((l) => l.ifname)]);
  return [...names].filter((p) => p !== st.wan && !toArray(eth[p]?.address).length && !bridged.has(p)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Interfaces a VLAN can sit on: physical ports, bonds and bridges (not the WAN). */
function vlanParents(st) {
  const out = [];
  for (const type of ["ethernet", "bonding", "bridge"]) for (const name of Object.keys(st.cfg.interfaces?.[type] || {})) if (name !== st.wan) out.push(name);
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function initNetworks() {
  const root = document.getElementById("networks");
  let st = null;
  let timer = null;

  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    if (!isConnected()) {
      clear(root).append(welcome(() => document.getElementById("btn-connect").click()));
      return;
    }
    if (!root.querySelector(".page")) clear(root).append(loadingPage(3));
    let next;
    try {
      next = await loadState();
    } catch (e) {
      if (seq === renderSeq) clear(root).append(h("div.page", h("div.err-box", errorText(e))));
      return;
    }
    if (seq !== renderSeq) return; // a newer refresh is on its way
    st = next;
    const nets = readNetworks(st.cfg, st.wan);
    const view = getView();
    const switcher = h("span.seg", [["networks", "Networks"], ["ports", "Ports"]].map(([k, l]) => h(`button${k === view ? ".on" : ""}`, { on: { click: () => {
      try {
        localStorage.setItem(VIEW_KEY, k);
      } catch {
        /* not remembered */
      }
      render();
    } } }, l)));
    const head = h("div.page-head",
      switcher,
      h("div.hint", view === "ports" ? "Each port of the router: cable, speed, networks and the devices behind it." : `${nets.length} local network${nets.length === 1 ? "" : "s"} · internet via ${st.wan || "?"}. Click a network to change it.`),
      h("span.grow"),
      h("button.primary", { on: { click: () => edit(null) } }, icon("plus", 16), "New network"));
    if (view === "ports") {
      const box = h("div.topo");
      clear(root).append(h("div.page", head, box));
      return renderPorts(box);
    }
    const grid = h("div.net-grid", nets.map((n) => card(n)));
    if (!nets.length) grid.append(h("div.empty", "No local networks yet. Create one, or use Quick Set for a basic home setup."));
    const access = nets.length ? h("div.hint", "Which networks can reach each other: ", h("button.link", { on: { click: () => showView("access") } }, "Security → Network access")) : "";
    clear(root).append(h("div.page", head, grid, access));
  }

  function card(n) {
    const online = st.neighbors.filter((x) => x.lladdr && x.dst && !x.dst.includes(":") && ipv4InCidr(x.dst, n.network) && /REACHABLE|DELAY|PROBE|STALE/.test(toArray(x.state).join(","))).length;
    let pool = null;
    if (n.dhcp?.start && n.dhcp?.stop) {
      const size = ipNum(n.dhcp.stop) - ipNum(n.dhcp.start) + 1;
      const used = st.leases.filter((l) => l.ip && ipv4InCidr(l.ip, n.network) && (!l.state || l.state === "active")).length;
      pool = { size, used };
    }
    const mgmt = session.info?.profile?.host && ipv4InCidr(session.info.profile.host, n.network);
    const badges = [
      n.vlan ? h("span.badge", `VLAN ${n.vlan}`) : h("span.badge", n.ports?.length ? `${n.iface}: ${n.ports.join(", ")}` : n.iface),
      n.isolated ? h("span.badge.warn", icon("lock", 12), "Isolated") : null,
      !n.internet ? h("span.badge.bad", icon("ban", 12), "No internet") : null,
      mgmt ? h("span.badge.info", "VyGi connects here") : null,
    ];
    return h("div.net-card", { on: { click: () => edit(n) }, title: "Click to edit" },
      h("div.net-top", h("span.net-icon", icon(n.isolated ? "lock" : "networks", 18)), h("div.grow", h("div.net-name", n.name), h("div.hint", `${n.network} · gateway ${n.routerIp}`)), h("div.net-online", h("b", String(online)), h("span.hint", " online"))),
      h("div.badges", badges),
      h("dl.kv-list",
        h("dt", "DHCP"), h("dd", n.dhcp ? `${n.dhcp.start} – ${n.dhcp.stop}` : "off (static addresses only)"),
        h("dt", "DNS for devices"), h("dd", n.dhcp ? (n.dnsMode === "router" ? `the router (${n.routerIp})` : n.dnsServers.join(", ")) : "–"),
        h("dt", "Internet"), h("dd", n.internet ? "allowed" : "blocked")),
      pool ? h("div", { title: `${pool.used} of ${pool.size} addresses leased` }, h("div.bar", h("span", { style: { width: `${Math.min(100, (pool.used / pool.size) * 100)}%` } })), h("div.hint", { style: { marginTop: "4px" } }, `${pool.used} / ${pool.size} DHCP addresses in use`)) : null);
  }

  async function edit(n) {
    try {
      st = await loadState();
    } catch (e) {
      return alertBox("Networks", errorText(e));
    }
    const env = { wan: st.wan, mgmtHost: session.info?.profile?.host };
    if (n) n = readNetworks(st.cfg, st.wan).find((x) => x.iface === n.iface) || n;
    const parents = vlanParents(st);
    const ports = freePorts(st);
    const lanParent = parents.find((p) => readNetworks(st.cfg, st.wan).some((x) => x.iface === p)) || parents[0] || "";
    const vlan0 = suggestVlan(st.cfg, lanParent);
    const cidr0 = n ? n.cidr : suggestSubnet(st.cfg, vlan0);
    const pool0 = n?.dhcp ? { start: n.dhcp.start, stop: n.dhcp.stop } : suggestPool(cidr0);
    const fields = [
      { name: "name", label: "Name", value: n?.name || "Guest", placeholder: "e.g. Guest, IoT, Kids" },
      ...(n ? [] : [
        { name: "preset", label: "Purpose", type: "select", value: "guest", options: Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label })), hint: "" },
        { name: "mode", label: "Network on", type: "select", value: "vlan", options: [{ value: "vlan", label: "a VLAN (needs a VLAN-capable switch or access point)" }, { value: "port", label: "its own port(s)" }] },
        { name: "parent", label: "VLAN on port", type: "select", value: lanParent, options: parents },
        { name: "vlan", label: "VLAN ID", value: vlan0, placeholder: "2–4094" },
        { name: "ports", label: "Ports", type: "multicheck", value: ports.slice(0, 1), options: ports, hint: ports.length ? "Tick several to join them into one network (a bridge): they then work like one switch." : "No free ports: every port already has an address or is in a bridge." },
        { name: "cidr", label: "Gateway / subnet", value: cidr0, hint: "The router's address on this network, with the size (/24 = 254 devices)." },
      ]),
      ...(n?.type === "bridge" ? [{ name: "ports", label: "Ports", type: "multicheck", value: n.ports, options: [...n.ports, ...ports].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), hint: "The ports in this network (a bridge). Devices plugged into any of them are on this network." }] : []),
      { name: "dhcp", label: "Hand out addresses (DHCP)", type: "checkbox", value: n ? !!n.dhcp : true },
      { name: "poolStart", label: "Pool from", value: pool0.start },
      { name: "poolStop", label: "Pool to", value: pool0.stop },
      { name: "dnsMode", label: "DNS for devices", type: "select", value: n?.dnsMode || "router", options: [{ value: "router", label: "the router" }, { value: "custom", label: "other DNS servers (e.g. Technitium, 1.1.1.1)" }] },
      { name: "dnsServers", label: "DNS servers", value: n?.dnsMode === "custom" ? n.dnsServers.join(" ") : "", placeholder: "192.168.1.5 1.1.1.1" },
      { name: "internet", label: "Internet access", type: "checkbox", value: n ? n.internet : PRESETS.guest.internet },
      { name: "isolate", label: "Isolate from other networks and the router", type: "checkbox", value: n ? n.isolated : PRESETS.guest.isolate, hint: "" },
    ];
    await formDialog(n ? `Network: ${n.name}` : "New network", fields, async (v) => {
      const spec = { ...v };
      if (n && v.cidr === undefined) spec.cidr = n.cidr;
      const cmds = networkCommands(st.cfg, spec, env, n);
      if (!cmds.length) return true;
      await applyChanges(cmds, n ? `network ${v.name}` : `new network ${v.name}`);
      render();
      return true;
    }, {
      okLabel: n ? "Apply" : "Create",
      initChange: true,
      extra: n ? { label: "Delete network", onClick: () => remove(n) } : null,
      onChange(field, v, set) {
        if (field === "preset") {
          const p = PRESETS[v.preset];
          const box = (name, on) => {
            const el = [...document.querySelectorAll(".dialog .form label")].find((l) => l.textContent.trim().startsWith(name === "internet" ? "Internet access" : "Isolate"))?.querySelector("input");
            if (el) el.checked = on;
          };
          box("internet", p.internet);
          box("isolate", p.isolate);
        }
        if (field === "parent" || field === "mode") {
          const vlan = v.mode === "vlan" ? suggestVlan(st.cfg, v.parent) : "";
          if (field === "parent") set("vlan", vlan);
        }
        if (!n && (field === "vlan" || field === "parent" || field === "mode")) {
          const cidr = suggestSubnet(st.cfg, v.mode === "vlan" ? v.vlan : "");
          set("cidr", cidr);
          const p = suggestPool(cidr);
          set("poolStart", p.start);
          set("poolStop", p.stop);
        }
        if (!n && field === "cidr" && parseIpv4Cidr(v.cidr)) {
          const p = suggestPool(v.cidr);
          set("poolStart", p.start);
          set("poolStop", p.stop);
        }
        if (!n) {
          set.show("parent", v.mode === "vlan");
          set.show("vlan", v.mode === "vlan");
          set.show("ports", v.mode === "port");
          set.hint("preset", { guest: "Guests get internet but can't reach your devices or the router's settings.", iot: "Devices can talk to each other and get DHCP/DNS, nothing else. Good for cameras and smart plugs that shouldn't phone home.", standard: "Like your main network: full access." }[v.preset] || "");
        }
        set.show("poolStart", v.dhcp);
        set.show("poolStop", v.dhcp);
        set.show("dnsMode", v.dhcp);
        set.show("dnsServers", v.dhcp && v.dnsMode === "custom");
        set.hint("isolate", v.isolate ? "Blocks traffic to and from your other local networks, and allows only DHCP, DNS and ping to the router." : "");
      },
    });
  }

  async function remove(n) {
    const env = { wan: st.wan, mgmtHost: session.info?.profile?.host };
    let cmds;
    try {
      cmds = deleteNetworkCommands(st.cfg, n, env);
    } catch (e) {
      return alertBox("Delete network", e.message);
    }
    if (!(await confirmBox("Delete network", `Delete "${n.name}" (${n.network})? Devices on it lose their connection. Its DHCP server and VyGi's rules for it are removed too.`, "Delete"))) return;
    try {
      await applyChanges(cmds, `delete network ${n.name}`);
      render();
    } catch (e) {
      alertBox("Failed", errorText(e));
    }
  }

  onSessionChange(() => {
    if (!root.hidden) render();
  });
  registerView("networks", {
    show: () => {
      render();
      timer = every(() => !document.querySelector(".dialog") && render(), 30000);
    },
    hide: () => clearInterval(timer),
  });
}
