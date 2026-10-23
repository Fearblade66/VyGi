// VPN: WireGuard peers (live), IPsec SAs and OpenVPN status (VyOS op-mode text).
import { api, errorText } from "../lib/api.js";
import { h, setStatus, formatBytes, formatAge } from "../lib/dom.js";
import { openWindow, tabs } from "../lib/mdi.js";
import { makeTable, filterBox } from "../lib/table.js";
import { openConfigTree } from "./config_tree.js";
import { quickSetup, addPeer, removePeer } from "./wireguard.js";

/**
 * Parses `wg show all dump`. Peer lines have 9 tab-separated fields:
 * iface, public-key, preshared-key, endpoint, allowed-ips, latest-handshake, rx, tx, keepalive
 */
export function parseWgDump(text) {
  const peers = [];
  for (const line of text.split("\n")) {
    const f = line.split("\t");
    if (f.length !== 9) continue;
    peers.push({
      iface: f[0],
      publicKey: f[1],
      endpoint: f[3] === "(none)" ? "" : f[3],
      allowedIps: f[4] === "(none)" ? "" : f[4].replaceAll(",", ", "),
      handshake: Number(f[5]) || 0,
      rx: Number(f[6]) || 0,
      tx: Number(f[7]) || 0,
    });
  }
  return peers;
}

export function openVpn() {
  const win = openWindow({ key: "vpn", title: "VPN", width: 960, height: 420 });
  if (!win.isNew) return;
  const t = tabs(["WireGuard", "IPsec", "OpenVPN"], (name) => refreshers[name]?.());
  win.body.append(t.el);

  // ---- WireGuard ----
  const wg = makeTable(
    [
      { key: "flags", label: "", width: "30px", className: "flag" },
      { key: "iface", label: "Interface", width: "70px" },
      { key: "name", label: "Peer", width: "110px" },
      { key: "endpoint", label: "Endpoint", width: "160px" },
      { key: "allowedIps", label: "Allowed IPs", width: "180px" },
      { key: "handshakeText", label: "Last Handshake", width: "120px" },
      { key: "rxText", label: "Rx", width: "80px", className: "num" },
      { key: "txText", label: "Tx", width: "80px", className: "num" },
      { key: "publicKey", label: "Public Key" },
    ],
    { rowKey: (r) => r.iface + r.publicKey, rowClass: (r) => (r.flags === "X" ? "disabled" : "") },
  );
  const reloadAll = () => loadWgNames().then(loadWg);
  t.pages.WireGuard.append(
    h(
      "div.win-toolbar",
      h("button", { title: "Create a WireGuard server and a first device", on: { click: () => quickSetup(reloadAll) } }, "Quick Setup…"),
      h("button.icon-add", { title: "Add a device (peer) and get its config/QR code", on: { click: () => addPeer(reloadAll) } }, "+ Device"),
      h("button.icon-remove", { title: "Remove the selected peer", on: { click: () => removePeer(wg.selected(), reloadAll) } }, "−"),
      h("button", { title: "Raw WireGuard configuration", on: { click: () => openConfigTree(["interfaces", "wireguard"], "WireGuard Config") } }, "Config…"),
      h("button", { on: { click: () => loadWg() } }, "⟳"),
      h("span.hint", "R = handshake in last 3 minutes"),
      h("span.grow"),
      filterBox(wg),
    ),
    wg.wrap,
    wg.count,
  );

  let peerNames = new Map();
  async function loadWgNames() {
    try {
      const cfg = await api.getConfig(["interfaces", "wireguard"]);
      peerNames = new Map();
      for (const [, ifc] of Object.entries(cfg || {})) for (const [name, p] of Object.entries(ifc?.peer || {})) peerNames.set(p["public-key"], name);
    } catch {
      /* none configured */
    }
  }
  async function loadWg() {
    try {
      const peers = parseWgDump(await api.wireguardDump());
      const now = Date.now() / 1000;
      wg.setRows(
        peers.map((p) => ({
          ...p,
          name: peerNames.get(p.publicKey) || "",
          flags: p.handshake && now - p.handshake < 180 ? "R" : "X",
          handshakeText: formatAge(p.handshake),
          rxText: formatBytes(p.rx),
          txText: formatBytes(p.tx),
        })),
      );
    } catch (e) {
      setStatus(errorText(e), true);
    }
  }

  // ---- IPsec / OpenVPN: op-mode text ----
  const textPage = (page, choices) => {
    const out = h("pre.out");
    const sel = h("select", choices.map(([label]) => h("option", label)));
    const load = async () => {
      const path = choices[sel.selectedIndex][1];
      out.textContent = "Loading…";
      try {
        out.textContent = (await api.runShow(path)) || "(no output)";
      } catch (e) {
        out.textContent = errorText(e);
      }
    };
    sel.addEventListener("change", load);
    page.append(h("div.win-toolbar", sel, h("button", { on: { click: load } }, "⟳")), out);
    return load;
  };
  const refreshers = {
    WireGuard: loadWg,
    IPsec: textPage(t.pages.IPsec, [
      ["show vpn ipsec sa", ["vpn", "ipsec", "sa"]],
      ["show vpn ipsec connections", ["vpn", "ipsec", "connections"]],
      ["show vpn ike sa", ["vpn", "ike", "sa"]],
    ]),
    OpenVPN: textPage(t.pages.OpenVPN, [
      ["show openvpn server", ["openvpn", "server"]],
      ["show openvpn client", ["openvpn", "client"]],
      ["show openvpn site-to-site", ["openvpn", "site-to-site"]],
    ]),
  };

  loadWgNames().then(() => t.select("WireGuard"));
  const timer = setInterval(() => {
    if (t.pages.WireGuard.classList.contains("active")) loadWg();
  }, 3000);
  win.onClose(() => clearInterval(timer));
}
