import "./styles.css";
import { api, errorText } from "./lib/api.js";
import { h, clear, setStatus } from "./lib/dom.js";
import { closeAllWindows } from "./lib/mdi.js";
import { modal, formDialog, alertBox } from "./lib/dialog.js";
import { isDesktop, setLoginHandler, webSession, webLogin, webLogout, webChangePassword } from "./lib/platform.js";
import { initToolbar, isConnected, setConnected, session, saveNow } from "./lib/session.js";
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
import { initNetworks } from "./components/networks.js";
import { initRules } from "./components/rules_view.js";
import { initPortForwards } from "./components/portfwd_view.js";
import { initVpnPage } from "./components/vpn_view.js";
import { initAlerts } from "./components/alerts.js";
import { initHistory } from "./components/history_view.js";
import { initSearch } from "./components/search.js";
import { initInsights } from "./components/insights.js";
import { initDashboard } from "./components/dashboard.js";
import { initClients } from "./components/clients.js";
import { openBackup } from "./components/backup.js";
import { openQueues } from "./components/queues.js";
import { openDnsServer } from "./components/technitium.js";
import { openDdns } from "./components/ddns.js";

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
      { label: "DNS Server (Technitium)", open: openDnsServer },
      { label: "Dynamic DNS", open: openDdns },
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
    if (session.unsaved && !session.confirmDeadline) {
      const r = await modal("Unsaved changes", h("div", { style: { maxWidth: "420px" } }, "The router has changes that aren't saved: they'll be lost if it restarts. Save them before disconnecting?"), [
        { label: "Cancel", value: "cancel" },
        { label: "Disconnect without saving", value: "skip" },
        { label: "Save and disconnect", value: "save", primary: true },
      ]);
      if (r === "cancel" || r === null) return;
      if (r === "save") await saveNow();
    }
    showView("dashboard", { remember: false });
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

/** Web version: the VyGi server's own password, before anything else. */
let loginOpen = false;
async function webLoginDialog() {
  if (loginOpen) return;
  loginOpen = true;
  await formDialog("Log in to VyGi", [
    { name: "password", label: "Password", type: "password", hint: "The VyGi web password (shown in the server's log on first start, or set with VYGI_PASSWORD)." },
  ], async (v) => {
    await webLogin(v.password);
    return true;
  }, { okLabel: "Log in" });
  loginOpen = false;
  if (!(await webSession().catch(() => false))) return webLoginDialog();
}

function initWebAccount() {
  document.getElementById("web-account").hidden = false;
  for (const el of document.querySelectorAll(".web-only")) el.hidden = false;
  document.getElementById("web-logout").addEventListener("click", (e) => {
    e.preventDefault();
    webLogout();
  });
  document.getElementById("web-password").addEventListener("click", async (e) => {
    e.preventDefault();
    const ok = await formDialog("Change the VyGi web password", [
      { name: "current", label: "Current password", type: "password" },
      { name: "pw", label: "New password", type: "password", hint: "At least 10 characters." },
      { name: "pw2", label: "Again", type: "password" },
    ], async (v) => {
      if (v.pw !== v.pw2) throw new Error("The new passwords don't match");
      await webChangePassword(v.current, v.pw);
      return true;
    }, { okLabel: "Change" });
    if (ok) alertBox("Password changed", "Use the new password next time you log in. If VYGI_PASSWORD is set in your Docker setup, it replaces this one when the server restarts.");
  });
  setLoginHandler(() => webLoginDialog().then(() => location.reload()));
}

window.addEventListener("DOMContentLoaded", async () => {
  initToolbar();
  initViews();
  initDashboard();
  initClients();
  initNetworks();
  initRules();
  initPortForwards();
  initVpnPage();
  initAlerts();
  initHistory();
  initInsights();
  initSearch(MENU.flatMap((m) => (m.children ? m.children.map((c) => ({ label: c.label, parent: m.label, open: c.open })) : [{ label: m.label, parent: null, open: m.open }])));
  showView("dashboard", { remember: false }); // the welcome screen until a router is connected
  renderMenu();
  document.getElementById("btn-connect").addEventListener("click", toggleConnect);
  document.getElementById("btn-new-window").addEventListener("click", () => api.newWindow().catch((e) => setStatus(errorText(e), true)));
  document.getElementById("btn-terminal").addEventListener("click", () => openTerminal());
  if (!isDesktop) {
    initWebAccount();
    if (!(await webSession().catch(() => false))) await webLoginDialog();
  }
  showConnectDialog();
});
