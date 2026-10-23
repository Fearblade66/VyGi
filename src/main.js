import "./styles.css";
import { api, errorText } from "./lib/api.js";
import { h, clear, setStatus } from "./lib/dom.js";
import { closeAllWindows } from "./lib/mdi.js";
import { initToolbar, isConnected, setConnected } from "./lib/session.js";
import { showConnectDialog } from "./components/connect.js";
import { openInterfaces } from "./components/interfaces.js";
import { openRoutes } from "./components/routes.js";
import { openVpn } from "./components/vpn.js";
import { openConfigTree } from "./components/config_tree.js";
import { openRevisions } from "./components/system.js";
import { openTerminal } from "./components/terminal.js";
import { openSyslog } from "./components/syslog.js";
import { openPing, openTraceroute, openCapture } from "./components/tools.js";
import { openFirewall } from "./components/firewall.js";
import { openNat } from "./components/nat.js";
import { openDhcpLeases } from "./components/dhcp.js";
import { openBackup } from "./components/backup.js";

// Left menu. Sections without a dedicated window use the generic config editor.
const MENU = [
  { label: "Interfaces", open: openInterfaces },
  {
    label: "IP",
    children: [
      { label: "Routes", open: openRoutes },
      { label: "DHCP Leases", open: openDhcpLeases },
      { label: "DHCP Server", open: () => openConfigTree(["service", "dhcp-server"], "DHCP Server") },
      { label: "DNS Forwarding", open: () => openConfigTree(["service", "dns", "forwarding"], "DNS Forwarding") },
    ],
  },
  { label: "Firewall", open: openFirewall },
  { label: "NAT", open: openNat },
  { label: "VPN", open: openVpn },
  { label: "Routing Protocols", open: () => openConfigTree(["protocols"], "Protocols") },
  { label: "VRF", open: () => openConfigTree(["vrf"], "VRF") },
  {
    label: "Tools",
    children: [
      { label: "Ping", open: openPing },
      { label: "Traceroute", open: openTraceroute },
      { label: "Packet Capture (Torch)", open: () => openCapture() },
    ],
  },
  { label: "Log", open: openSyslog },
  {
    label: "System",
    children: [
      { label: "Revisions / Rollback", open: openRevisions },
      { label: "Backup / Restore", open: openBackup },
      { label: "System Settings", open: () => openConfigTree(["system"], "System") },
      { label: "Services", open: () => openConfigTree(["service"], "Services") },
      { label: "Full Configuration", open: () => openConfigTree([], "Configuration") },
    ],
  },
  { label: "New Terminal", open: openTerminal },
];

function renderMenu() {
  const nav = clear(document.getElementById("menu"));
  const guard = (fn) => () => {
    if (!isConnected()) return setStatus("Connect to a router first.", true);
    try {
      const r = fn();
      if (r && r.catch) r.catch((e) => setStatus(errorText(e), true));
    } catch (e) {
      setStatus(errorText(e), true);
    }
  };
  for (const item of MENU) {
    if (item.children) {
      const subs = item.children.map((c) => h("div.menu-sub", { hidden: true, on: { click: guard(c.open) } }, c.label));
      const head = h("div.menu-item.group", item.label);
      head.addEventListener("click", () => {
        const open = head.classList.toggle("open");
        subs.forEach((s) => (s.hidden = !open));
      });
      nav.append(head, ...subs);
    } else {
      nav.append(h("div.menu-item", { on: { click: guard(item.open) } }, item.label));
    }
  }
}

async function toggleConnect() {
  if (isConnected()) {
    closeAllWindows();
    try {
      await api.disconnect();
    } catch (e) {
      setStatus(errorText(e), true);
    }
    setConnected(null);
    setStatus("Disconnected.");
  } else {
    await showConnectDialog();
  }
}

window.addEventListener("DOMContentLoaded", () => {
  initToolbar();
  renderMenu();
  document.getElementById("btn-connect").addEventListener("click", toggleConnect);
  document.getElementById("btn-terminal").addEventListener("click", () => openTerminal());
  showConnectDialog();
});
