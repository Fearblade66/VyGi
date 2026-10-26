// Ports map (Networks page): the internet, the router, each physical port
// with its cable state, speed, role, networks (and VLANs), what announces
// itself on it (LLDP) and the devices behind it. Pure: no API calls.
import { toArray, parseIpv4Cidr } from "./vyos.js";

const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });

/** The physical port an interface name sits on: eth1.20 -> eth1, pppoe0 -> its port. */
function portOf(cfg, iface) {
  if (iface.startsWith("pppoe")) return String(cfg?.interfaces?.pppoe?.[iface]?.["source-interface"] || "").split(".")[0];
  return iface.split(".")[0];
}

/**
 * input: { cfg, wan, ports: [{ name, speedMbit, carrier }], links (ip -d link), fdb (bridge fdb),
 *          clients: [{ mac, ip, iface, label, online, kind }], lldp: [{ local, device, port, mgmt, caps }] }
 * -> { wan, wanPort, ports: [{ name, up, speedMbit, role, bridge, description, networks: [{ iface, name, cidr, vlan }],
 *       neighbors: [lldp rows], devices: [client] }], elsewhere: [client] }
 */
export function buildTopology({ cfg = {}, wan = "", ports = [], links = [], fdb = [], clients = [], lldp = [] }) {
  const eth = cfg?.interfaces?.ethernet || {};
  const bridges = cfg?.interfaces?.bridge || {};
  const memberOf = new Map();
  for (const [br, b] of Object.entries(bridges)) for (const m of Object.keys(b?.member?.interface || {})) memberOf.set(m, br);
  const wanPort = wan ? portOf(cfg, wan) : "";
  const linkUp = new Map(links.map((l) => [l.ifname, l.operstate === "UP" || (l.flags || []).includes("LOWER_UP")]));
  // which bridge port a MAC was last seen on
  const macPort = new Map();
  for (const e of Array.isArray(fdb) ? fdb : []) {
    if (e?.mac && e?.ifname && !toArray(e.flags).includes("self") && !e.state?.includes?.("permanent")) macPort.set(String(e.mac).toLowerCase(), e.ifname);
  }

  const networksOn = (name) => {
    const out = [];
    const add = (iface, node, vlan) => {
      for (const a of toArray(node?.address)) {
        const p = parseIpv4Cidr(a);
        if (p) out.push({ iface, name: node.description || iface, cidr: p.network, vlan });
      }
      if (!out.some((n) => n.iface === iface) && toArray(node?.address).includes("dhcp")) out.push({ iface, name: node.description || iface, cidr: "from the provider (DHCP)", vlan });
    };
    const node = eth[name] || bridges[name];
    if (!node) return out;
    add(name, node, "");
    for (const [vid, v] of Object.entries(node.vif || {})) add(`${name}.${vid}`, v, vid);
    return out;
  };

  const names = [...new Set([...ports.map((p) => p.name), ...Object.keys(eth)])].filter((n) => /^eth\d+$/.test(n)).sort(natural);
  const placed = new Set();
  const out = names.map((name) => {
    const info = ports.find((p) => p.name === name) || {};
    const bridge = memberOf.get(name) || "";
    const nets = bridge ? networksOn(bridge) : networksOn(name);
    const role = name === wanPort ? "internet" : nets.length ? (bridge ? "bridge" : "network") : "unused";
    const devices = clients.filter((c) => {
      if (!c.iface || c.kind === "vpn") return false;
      const port = portOf(cfg, c.iface);
      if (port === name) return true;
      // on a bridge: the port the bridge last saw the device's MAC on
      return bridge && port === bridge && macPort.get(String(c.mac || "").toLowerCase()) === name;
    });
    devices.forEach((d) => placed.add(d));
    return {
      name,
      up: info.carrier ?? linkUp.get(name) ?? null,
      speedMbit: info.speedMbit ?? null,
      role,
      bridge,
      description: eth[name]?.description || "",
      networks: nets,
      neighbors: lldp.filter((n) => n.local === name),
      devices: devices.sort((a, b) => Number(b.online) - Number(a.online) || natural(a.label || "", b.label || "")),
    };
  });
  // devices VyGi knows about but can't pin to a port (VPN, bridged ones not seen by the bridge yet)
  const elsewhere = clients.filter((c) => !placed.has(c));
  return { wan, wanPort, ports: out, elsewhere };
}

/** "1 Gbit/s", "100 Mbit/s", "2.5 Gbit/s" */
export function speedText(mbit) {
  if (!mbit) return "";
  return mbit >= 1000 ? `${+(mbit / 1000).toFixed(1)} Gbit/s` : `${mbit} Mbit/s`;
}
