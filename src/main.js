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
import { openPing, openTraceroute, openCapture, openTorch, openIpScan, openProfile } from "./components/tools.js";
import { openResources, openIdentityClock, powerAction, openImages } from "./components/resources.js";
import { openAddresses } from "./components/addresses.js";
import { openNeighbors } from "./components/neighbors.js";
import { openServices } from "./components/services.js";
import { openAddressLists, openConnections } from "./components/fwextra.js";
import { openQuickSet } from "./components/quickset.js";
import { openFirewall } from "./components/firewall.js";
import { openNat } from "./components/nat.js";
import { openDhcp, openDhcpLeases } from "./components/dhcp.js";
import { openDns } from "./components/dns.js";
import { openUsers } from "./components/users.js";
import { runCheckup } from "./components/checkup.js";
import { initViews, showView } from "./lib/views.js";
import { initDashboard } from "./components/dashboard.js";
import { initClients } from "./components/clients.js";
import { openBackup } from "./components/backup.js";
import { openQueues } from "./components/queues.js";

// Left menu. Sections without a dedicated window use the generic config editor.
const MENU = [
  { label: "Quick Set", open: openQuickSet },
  { label: "Interfaces", open: openInterfaces },
  {
    label: "IP",
    children: [
      { label: "Addresses", open: openAddresses },
      { label: "Routes", open: openRoutes },
      { label: "ARP / Neighbors", open: openNeighbors },
      { label: "DHCP Server", open: () => openDhcp() },
      { label: "DHCP Leases", open: openDhcpLeases },
      { label: "DNS", open: openDns },
      { label: "Services", open: openServices },
    ],
  },
  {
    label: "Firewall",
    children: [
      { label: "Filter Rules", open: openFirewall },
      { label: "NAT", open: openNat },
      { label: "Address Lists", open: openAddressLists },
      { label: "Connections", open: openConnections },
    ],
  },
  { label: "Queues", open: openQueues },
  { label: "VPN", open: openVpn },
  { label: "Routing Protocols", open: () => openConfigTree(["protocols"], "Protocols") },
  { label: "VRF", open: () => openConfigTree(["vrf"], "VRF") },
  {
    label: "Tools",
    children: [
      { label: "Ping", open: openPing },
      { label: "Traceroute", open: openTraceroute },
      { label: "Torch", open: () => openTorch() },
      { label: "Packet Sniffer", open: () => openCapture() },
      { label: "IP Scan", open: openIpScan },
      { label: "Profile", open: openProfile },
    ],
  },
  { label: "Log", open: openSyslog },
  {
    label: "System",
    children: [
      { label: "Resources", open: openResources },
      { label: "Identity & Clock", open: openIdentityClock },
      { label: "Users", open: openUsers },
      { label: "Images (Upgrade)", open: openImages },
      { label: "Revisions / Rollback", open: openRevisions },
      { label: "Backup / Restore", open: () => openBackup() },
      { label: "Check-up", open: () => runCheckup({ alwaysShow: true }) },
      { label: "System Settings", open: () => openConfigTree(["system"], "System") },
      { label: "Services (config)", open: () => openConfigTree(["service"], "Services") },
      { label: "Full Configuration", open: () => openConfigTree([], "Configuration") },
      { label: "Reboot", open: () => powerAction("reboot") },
      { label: "Shut Down", open: () => powerAction("poweroff") },
    ],
  },
  { label: "New Terminal", open: openTerminal },
];

function renderMenu() {
  const nav = clear(document.getElementById("menu"));
  const guard = (fn) => () => {
    if (!isConnected()) return setStatus("Connect to a router first.", true);
    showView("windows");
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
    showView("windows");
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
  initViews();
  initDashboard();
  initClients();
  showView("windows");
  renderMenu();
  document.getElementById("btn-connect").addEventListener("click", toggleConnect);
  document.getElementById("btn-terminal").addEventListener("click", () => openTerminal());
  showConnectDialog();
});
