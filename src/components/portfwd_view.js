// Port Forwarding page: send a port from the internet to one device (game
// server, NAS, cameras), with an on/off switch per forward.
import { itemMenu, itemCommands } from "./itemref.js";
import { api, errorText } from "../lib/api.js";
import { h, clear, every } from "../lib/dom.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges, isConnected, onSessionChange } from "../lib/session.js";
import { registerView, welcome, loadingPage } from "../lib/views.js";
import { icon } from "../lib/icons.js";
import { collectClients } from "../lib/netdata.js";
import { readNetworks } from "../lib/netplan.js";
import { ipv4InCidr } from "../lib/vyos.js";
import { wanInfo, wanProblem } from "../lib/wan.js";
import { wanNotice } from "./wan_notice.js";
import { parseForwards, forwardCommands, deleteForwardCommands, toggleForwardCommands, SERVICES } from "../lib/portfwd.js";

const IP_IN = /(\d{1,3}(?:\.\d{1,3}){3})\s*$/;
const PROTO = { tcp: "TCP", udp: "UDP", tcp_udp: "TCP + UDP", all: "all" };

async function loadState() {
  const [cfg, w, { clients }] = await Promise.all([
    api.getConfig([]),
    wanInfo(),
    collectClients().catch(() => ({ clients: [] })),
  ]);
  return { cfg: cfg || {}, ...w, clients: clients.filter((c) => c.ip && c.kind !== "vpn") };
}

export function initPortForwards() {
  const root = document.getElementById("ports");
  let st = null;
  let timer = null;

  const deviceLabel = (ip) => st.clients.find((c) => c.ip === ip)?.label || ip;

  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    if (!isConnected()) {
      clear(root).append(welcome(() => document.getElementById("btn-connect").click()));
      return;
    }
    if (!root.querySelector(".page")) clear(root).append(loadingPage(2));
    let next;
    try {
      next = await loadState();
    } catch (e) {
      if (seq === renderSeq) clear(root).append(h("div.page", h("div.err-box", errorText(e))));
      return;
    }
    if (seq !== renderSeq) return;
    st = next;
    const fwds = parseForwards(st.cfg);
    const problem = wanProblem(st.wanIp);
    const head = h("div.page-head",
      h("div.hint", "Let the internet reach a device at home: a game server, NAS or camera. ",
        st.endpoint ? `People connect to ${st.endpoint} on the outside port.` : ""),
      h("span.grow"),
      h("button.primary", { on: { click: () => edit(null) } }, icon("plus", 16), "New forward"));
    const grid = h("div.rule-grid", fwds.map(card));
    if (!fwds.length) {
      grid.append(h("div.empty-state",
        h("span.net-icon", icon("forward", 20)),
        h("div", h("b", "No port forwards"), h("div.hint", "Only open ports you need: anything forwarded can be reached by anyone on the internet.")),
        h("button", { on: { click: () => edit(null) } }, "Forward a port")));
    }
    clear(root).append(h("div.page", head, wanNotice(problem, st.wanIp), grid));
  }

  function card(f) {
    const sw = h("input", { type: "checkbox", checked: f.enabled, title: f.enabled ? "On: click to pause" : "Paused: click to turn on" });
    sw.addEventListener("change", async () => {
      el.classList.toggle("off", !sw.checked);
      try {
        await applyChanges(toggleForwardCommands(f, sw.checked), `${sw.checked ? "enable" : "pause"} forward ${f.name}`);
      } catch (e) {
        alertBox("Failed", errorText(e));
      }
      render();
    });
    const ports = f.inside !== f.outside ? `${f.outside} → ${f.inside}` : f.outside || "all ports";
    const refs = [{ label: `NAT → destination rule ${f.n}`, path: ["nat", "destination", "rule", f.n] }, f.fw && { label: `Firewall → forward rule ${f.fw}`, path: ["firewall", "ipv4", "forward", "filter", "rule", f.fw] }];
    const el = h(`div.rule-card${f.enabled ? "" : ".off"}`, { on: { click: () => (f.ours ? edit(f) : alertBox(f.name, "This forward was made outside VyGi. Change it in Advanced → Firewall → NAT.")) }, title: f.ours ? "Click to edit" : "Made outside VyGi" },
      h("div.rule-top",
        h("span.rule-icon", icon("forward", 18)),
        h("div.grow", h("div.rule-name", f.name), h("div.hint", `${PROTO[f.protocol] || f.protocol} ${ports}`)),
        f.ours ? h("label.switch", { on: { click: (e) => e.stopPropagation() } }, sw) : h("span.badge", "Advanced"),
        itemMenu(refs)),
      h("dl.kv-list",
        h("dt", "Device"), h("dd", f.ip ? `${deviceLabel(f.ip)}${deviceLabel(f.ip) !== f.ip ? ` (${f.ip})` : ""}` : "–"),
        h("dt", "Allowed from"), h("dd", f.from || "anyone")),
      itemCommands(st.cfg, refs.filter(Boolean).map((r) => r.path)));
    return el;
  }

  async function edit(f) {
    try {
      st = await loadState();
    } catch (e) {
      return alertBox("Port Forwarding", errorText(e));
    }
    if (f) f = parseForwards(st.cfg).find((x) => x.n === f.n) || f;
    const nets = readNetworks(st.cfg, st.wan);
    const lans = nets.map((n) => n.network);
    const devices = st.clients.filter((c) => lans.some((n) => ipv4InCidr(c.ip, n)));
    const opts = devices.map((c) => `${c.label === c.ip ? "" : `${c.label} — `}${c.ip}`);
    if (f?.ip && !devices.some((c) => c.ip === f.ip)) opts.unshift(f.ip);
    const custom = "Other address…";
    const findDevice = (choice) => devices.find((c) => c.ip === choice.match(IP_IN)?.[1]);
    const dhcp = st.cfg?.service?.["dhcp-server"]?.["shared-network-name"] || {};
    const dhcpWhere = (ip) => {
      for (const [network, n] of Object.entries(dhcp)) for (const subnet of Object.keys(n?.subnet || {})) if (ipv4InCidr(ip, subnet)) return { network, subnet };
      return null;
    };
    const reservedTo = (ip) => {
      for (const n of Object.values(dhcp)) for (const s of Object.values(n?.subnet || {})) for (const m of Object.values(s?.["static-mapping"] || {})) if (m?.["ip-address"] === ip) return true;
      return false;
    };
    const current = f ? opts.find((o) => o.match(IP_IN)?.[1] === f.ip) : opts[0];

    await formDialog(f ? `Forward: ${f.name}` : "New port forward", [
      { name: "service", label: "Preset", type: "select", value: "", options: [{ value: "", label: "(choose to fill in)" }, ...SERVICES.map((s, i) => ({ value: String(i), label: `${s.label} (${s.protocol.toUpperCase()} ${s.port})` }))] },
      { name: "name", label: "Name", value: f?.name || "", placeholder: "e.g. Minecraft server" },
      { name: "device", label: "Device", type: "select", value: current || custom, options: [...opts, custom] },
      { name: "ip", label: "Device address", value: f?.ip || "", placeholder: "192.168.1.20" },
      { name: "protocol", label: "Protocol", type: "select", value: f?.protocol && PROTO[f.protocol] ? f.protocol : "tcp", options: [{ value: "tcp", label: "TCP" }, { value: "udp", label: "UDP" }, { value: "tcp_udp", label: "TCP and UDP" }] },
      { name: "outside", label: "Outside port", value: f?.outside || "", placeholder: "e.g. 25565 or 8000-8010", hint: "The port people on the internet connect to." },
      { name: "inside", label: "Inside port", value: f && f.inside !== f.outside ? f.inside : "", placeholder: "same as outside", hint: "The port the device listens on, if different." },
      { name: "from", label: "Allowed from", value: f?.from || "", placeholder: "anyone", hint: "Optional: only this address or network (e.g. a friend's IP) can connect." },
      { name: "reserve", label: "Keep this device on this address (DHCP reservation)", type: "checkbox", value: false },
      { name: "enabled", label: "Forward on", type: "checkbox", value: f ? f.enabled : true },
    ], async (v) => {
      const dev = v.device === custom ? null : findDevice(v.device);
      const ip = v.device === custom ? v.ip.trim() : v.device.match(IP_IN)?.[1] || "";
      let reserve = null;
      if (v.reserve && dev?.mac && !dev.fixedIp) {
        const where = dhcpWhere(ip);
        if (where) reserve = { ...where, mac: dev.mac, name: dev.name || `fwd-${ip.replaceAll(".", "-")}` };
      }
      const spec = { ...v, ip, reserve };
      await applyChanges(forwardCommands(st.cfg, spec, { wan: st.wan, lans }, f), f ? `forward ${v.name}` : `new forward ${v.name}`);
      render();
      return true;
    }, {
      okLabel: f ? "Apply" : "Create",
      initChange: true,
      extra: f ? { label: "Delete forward", onClick: () => remove(f) } : null,
      onChange(field, v, set) {
        if (field === "service" && v.service !== "") {
          const s = SERVICES[Number(v.service)];
          set("protocol", s.protocol);
          set("outside", s.port);
          if (!v.name.trim()) set("name", s.label);
        }
        set.show("ip", v.device === custom);
        const dev = v.device === custom ? null : findDevice(v.device);
        const ip = v.device === custom ? v.ip.trim() : v.device.match(IP_IN)?.[1];
        const canReserve = !!dev?.mac && !dev.fixedIp && !reservedTo(ip) && !!dhcpWhere(ip);
        set.show("reserve", canReserve);
        if (field === "device" || field === null) set("reserve", canReserve);
        set.hint("device", dev?.fixedIp || reservedTo(ip) ? "This device has a reserved address." : canReserve ? "Its address comes from DHCP and may change: tick the box below to keep it." : "Make sure this device always gets the same address, or the forward stops working.");
      },
    });
  }

  async function remove(f) {
    if (!(await confirmBox("Delete forward", `Delete "${f.name}"? The port closes to the internet.`, "Delete"))) return;
    try {
      await applyChanges(deleteForwardCommands(f), `delete forward ${f.name}`);
      render();
    } catch (e) {
      alertBox("Failed", errorText(e));
    }
  }

  onSessionChange(() => {
    if (!root.hidden) render();
  });
  registerView("ports", {
    show: () => {
      render();
      timer = every(() => !document.querySelector(".dialog") && render(), 60000);
    },
    hide: () => clearInterval(timer),
  });
}
