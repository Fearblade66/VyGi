// Networks page, "Ports" view: the internet, the router and each physical
// port with what's on it (UniFi's topology / port manager, for one router).
import { api, errorText } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { wanInfo } from "../lib/wan.js";
import { buildTopology, speedText } from "../lib/topology.js";
import { deviceList } from "./groups.js";
import { lldpRows } from "./neighbors.js";
import { openClient } from "./clients.js";

const ROLE = { internet: "Internet", network: "Network", bridge: "Bridge", unused: "Unused" };
const SHOW = 8;

export async function renderPorts(el) {
  clear(el).append(h("div.hint", "Loading ports…"));
  let t;
  let w;
  let lldpOff = false;
  try {
    const [cfg, wi, info, stats, clients, lldpRaw] = await Promise.all([
      api.getConfig([]).then((c) => c || {}),
      wanInfo(),
      api.portInfo().catch(() => ({ ports: [], fdb: [] })),
      api.interfaceStats().catch(() => ({ links: [] })),
      deviceList(),
      api.lldpNeighbors().catch(() => null),
    ]);
    w = wi;
    lldpOff = lldpRaw === null;
    t = buildTopology({ cfg, wan: wi.wan, ports: info.ports, fdb: info.fdb, links: stats.links || [], clients, lldp: lldpRows(lldpRaw) });
  } catch (e) {
    clear(el).append(h("div.err-box", errorText(e)));
    return;
  }

  const wanPort = t.ports.find((p) => p.role === "internet");
  const diagram = h("div.topo-head",
    h("div.topo-node", icon("globe", 20), h("div", h("b", "Internet"), h("div.hint", w.wanIp || "no address"))),
    h(`div.topo-link${wanPort?.up === false ? ".down" : ""}`, h("span.hint", wanPort ? `${wanPort.name}${wanPort.speedMbit ? ` · ${speedText(wanPort.speedMbit)}` : ""}` : "")),
    h("div.topo-node.router", icon("router", 20), h("div", h("b", "Router"), h("div.hint", `${t.ports.length} ports · ${t.ports.filter((p) => p.up).length} connected`))));

  const card = (p) => {
    const more = p.devices.length > SHOW;
    const list = h("div.topo-devs", p.devices.slice(0, SHOW).map(dev));
    const moreBtn = more ? h("button.link", { on: { click: () => { list.replaceChildren(...p.devices.map(dev)); moreBtn.remove(); } } }, `+${p.devices.length - SHOW} more`) : null;
    return h(`div.topo-port.${p.role}${p.up === false ? ".down" : ""}`,
      h("div.topo-port-head",
        h(`span.led${p.up ? ".on" : p.up === false ? ".off" : ""}`, { title: p.up ? "cable connected" : p.up === false ? "no cable / link down" : "unknown" }),
        h("b", p.name),
        p.speedMbit ? h("span.hint", speedText(p.speedMbit)) : p.up === false ? h("span.hint", "no link") : null,
        h("span.grow"),
        h(`span.badge${p.role === "internet" ? ".ok" : ""}`, p.role === "bridge" ? `Bridge ${p.bridge}` : ROLE[p.role])),
      p.description && p.role === "unused" ? h("div.hint", p.description) : null,
      p.networks.length ? h("div.topo-nets", p.networks.map((n) => h("div", h("span", n.name), n.vlan ? h("span.badge", `VLAN ${n.vlan}`) : null, h("span.hint", ` ${n.cidr}`)))) : null,
      p.neighbors.map((n) => h("div.topo-neighbor", { title: [n.platform, n.mgmt].filter(Boolean).join("\n") }, icon("router", 13), ` ${n.device || "device"}`, n.port ? h("span.hint", ` (its port ${n.port})`) : null)),
      p.devices.length ? list : p.role !== "internet" && p.role !== "unused" ? h("div.hint", "No devices seen") : null,
      moreBtn);
  };

  clear(el).append(
    diagram,
    lldpOff ? h("div.hint.topo-note", "Switches and access points show up on their port when LLDP is on (Advanced → IP → ARP / Neighbors → LLDP).") : "", // append() would print null
    h("div.topo-ports", t.ports.map(card)),
    t.elsewhere.length ? h("div.topo-elsewhere",
      h("div.section-title", "Not pinned to a port"),
      h("div.hint", "VPN devices, and devices on a bridge the bridge hasn't seen recently."),
      h("div.topo-devs", t.elsewhere.map(dev))) : "");
}

function dev(c) {
  return h("button.topo-dev", { title: [c.ip, c.mac].filter(Boolean).join(" · "), on: { click: () => openClient(c.key || c.mac || c.ip, c.label) } },
    h(`span.dot${c.online ? ".on" : ""}`), h("span.topo-dev-name", c.label || c.ip), h("span.hint", c.ip || ""));
}
