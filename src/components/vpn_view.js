// VPN page (UniFi Teleport-style): a WireGuard server per card, its devices
// with online status, data used and where they connect from; add a device
// (QR code), pause or remove it.
import { itemIssues } from "./doctor.js";
import { itemMenu, itemCommands } from "./itemref.js";
import { api, errorText } from "../lib/api.js";
import { h, clear, every, formatBytes, formatAge } from "../lib/dom.js";
import { alertBox } from "../lib/dialog.js";
import { applyChanges, isConnected, onSessionChange, session } from "../lib/session.js";
import { registerView, welcome, loadingPage } from "../lib/views.js";
import { icon } from "../lib/icons.js";
import { toArray } from "../lib/vyos.js";
import { wanInfo, wanProblem } from "../lib/wan.js";
import { wanNotice } from "./wan_notice.js";
import { parseWgDump } from "./vpn.js";
import { countryName } from "../lib/sites.js";
import { flag } from "../lib/activity.js";
import { quickSetup, addPeer, removePeer, showPeerConfig } from "./wireguard.js";
import { vpnServers } from "../lib/vpnclient.js";
import { vpnClientSection } from "./vpnclient_view.js";

const ONLINE_SECS = 180; // a WireGuard handshake happens at least every 2 minutes while in use

async function loadState() {
  const [full, dump, w] = await Promise.all([
    api.getConfig([]).catch(() => ({})),
    api.wireguardDump().catch(() => ""),
    wanInfo(),
  ]);
  const wg = vpnServers(full?.interfaces?.wireguard);
  const live = new Map(parseWgDump(dump).map((p) => [p.publicKey, p]));
  const servers = Object.entries(wg).map(([iface, c]) => ({
    iface,
    port: c?.port || "",
    address: toArray(c?.address).join(", "),
    disabled: "disable" in (c || {}),
    peers: Object.entries(c?.peer || {}).map(([name, p]) => ({
      iface,
      name,
      ip: toArray(p?.["allowed-ips"]).join(", "),
      paused: "disable" in (p || {}),
      ...(live.get(p?.["public-key"]) || {}),
    })).sort((a, b) => a.name.localeCompare(b.name)),
  }));
  return { servers, cfg: full || {}, ...w };
}

export function initVpnPage() {
  const root = document.getElementById("vpnpage");
  let timer = null;
  let geo = new Map(); // endpoint ip -> "Country"

  let renderSeq = 0;
  let vpnCfg = {}; // the WireGuard config last loaded (for Show commands)
  async function render() {
    const seq = ++renderSeq;
    if (!isConnected()) {
      clear(root).append(welcome(() => document.getElementById("btn-connect").click()));
      return;
    }
    if (!root.querySelector(".page")) clear(root).append(loadingPage(2));
    let st;
    try {
      st = await loadState();
    } catch (e) {
      if (seq === renderSeq) clear(root).append(h("div.page", h("div.err-box", errorText(e))));
      return;
    }
    if (seq !== renderSeq) return;
    vpnCfg = st.cfg;
    await lookupCountries(st);
    if (seq !== renderSeq) return;
    const problem = wanProblem(st.wanIp);
    const head = h("div.page-head",
      h("div.hint", "Reach your home network and use your home internet from anywhere, with the WireGuard app on a phone or laptop."),
      h("span.grow"),
      st.servers.length > 1 ? h("button.primary", { on: { click: () => addPeer(render) } }, icon("plus", 16), "Add device") : null);
    const body = st.servers.length
      ? st.servers.map(server)
      : [h("div.empty-state",
          h("span.net-icon", icon("vpn", 20)),
          h("div", h("b", "No VPN yet"), h("div.hint", "Set up a WireGuard VPN server on the router and get a QR code for your first device.")),
          h("button.primary", { on: { click: () => quickSetup(render) } }, "Set up VPN"))];
    clear(root).append(h("div.page", head,
      wanNotice(problem, st.wanIp),
      st.servers.length && !st.ddns ? h("div.hint", "Tip: set up Dynamic DNS (Advanced → IP → Dynamic DNS) so devices still find the router when your internet address changes.") : null,
      ...body,
      clientSection()));
  }

  let clientSec = null;
  let clientSecRouter = null;
  function clientSection() {
    const router = session.info?.profileId;
    if (!clientSec || clientSecRouter !== router) {
      clientSec = vpnClientSection(render);
      clientSecRouter = router;
    } else {
      clientSec.refresh();
    }
    return clientSec;
  }

  async function lookupCountries(st) {
    const ips = [...new Set(st.servers.flatMap((s) => s.peers).map((p) => endpointIp(p.endpoint)).filter((ip) => ip && !geo.has(ip)))];
    if (!ips.length) return;
    try {
      const res = await api.geoipLookup(ips);
      for (const ip of ips) geo.set(ip, res?.[ip]?.country ? `${flag(res[ip].country)}${countryName(res[ip].country)}` : "");
    } catch {
      for (const ip of ips) geo.set(ip, "");
    }
  }

  function server(s) {
    const online = s.peers.filter(isOnline).length;
    return h("section.vpn-server",
      h("div.vpn-head",
        h("span.net-icon", icon("vpn", 18)),
        h("div.grow",
          h("div.net-name", `WireGuard ${s.iface}`),
          h("div.hint", `${s.address || "no address"} · UDP port ${s.port || "?"} · ${online} of ${s.peers.length} device${s.peers.length === 1 ? "" : "s"} connected`)),
        s.disabled ? h("span.badge.bad", "Interface disabled") : null,
        h("button", { on: { click: () => addPeer(render, s.iface) } }, icon("plus", 14), "Add device")),
      itemIssues(vpnCfg, "vpn", { iface: s.iface }, render),
      s.peers.length
        ? h("div.rule-grid", s.peers.map(peerCard))
        : h("div.hint", "No devices yet."));
  }

  const isOnline = (p) => !p.paused && p.handshake && Date.now() / 1000 - p.handshake < ONLINE_SECS;
  const endpointIp = (ep) => (ep ? ep.replace(/^\[/, "").replace(/\]?:\d+$/, "") : "");

  function peerCard(p) {
    const on = isOnline(p);
    const ip = endpointIp(p.endpoint);
    const country = ip ? geo.get(ip) : "";
    const sw = h("input", { type: "checkbox", checked: !p.paused, title: p.paused ? "Paused: click to allow again" : "Allowed: click to pause" });
    sw.addEventListener("change", async () => {
      el.classList.toggle("off", !sw.checked);
      try {
        await applyChanges([{ op: sw.checked ? "delete" : "set", path: ["interfaces", "wireguard", p.iface, "peer", p.name, "disable"] }], `${sw.checked ? "allow" : "pause"} VPN device ${p.name}`);
      } catch (e) {
        alertBox("Failed", errorText(e));
      }
      render();
    });
    const peerPath = ["interfaces", "wireguard", p.iface, "peer", p.name];
    const el = h(`div.rule-card${p.paused ? ".off" : ""}`, { style: { cursor: "default" } },
      h("div.rule-top",
        h("span.rule-icon", icon("clients", 18)),
        h("div.grow", h("div.rule-name", p.name), h("div.hint", p.ip)),
        h("label.switch", sw),
        itemMenu([{ label: `WireGuard → ${p.iface} peer ${p.name}`, path: peerPath }])),
      h("div.badges",
        p.paused ? h("span.badge", "Paused") : on ? h("span.badge.ok", "Connected") : h("span.badge", p.handshake ? `Last seen ${formatAge(p.handshake)}` : "Never connected")),
      h("dl.kv-list",
        h("dt", "From"), h("dd", ip ? `${ip}${country ? ` (${country})` : ""}` : "–"),
        h("dt", "Data"), h("dd", p.rx || p.tx ? `↓ ${formatBytes(p.tx || 0)} · ↑ ${formatBytes(p.rx || 0)}` : "–")),
      h("div.card-actions",
        h("button", { title: "The config file and QR code for the WireGuard app", on: { click: () => showPeerConfig({ iface: p.iface, name: p.name }, render) } }, "Show config"),
        h("span.grow"),
        h("button.danger", { on: { click: () => removePeer({ iface: p.iface, name: p.name }, render) } }, icon("trash", 14), "Remove")),
      itemCommands(vpnCfg, [peerPath]));
    return el;
  }

  onSessionChange(() => {
    if (!root.hidden) render();
  });
  registerView("vpn", {
    show: () => {
      geo = new Map();
      render();
      timer = every(() => !document.querySelector(".dialog") && render(), 10000);
    },
    hide: () => clearInterval(timer),
  });
}
