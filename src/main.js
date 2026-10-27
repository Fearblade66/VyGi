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
import { initViews, showView, onAnyView } from "./lib/views.js";
import { initPhone } from "./lib/phone.js";
import { initAndroidApp } from "./lib/androidapp.js";
import { initNetworks } from "./components/networks.js";
import { initRules } from "./components/rules_view.js";
import { initPortForwards } from "./components/portfwd_view.js";
import { initVpnPage } from "./components/vpn_view.js";
import { initAlerts } from "./components/alerts.js";
import { initHistory } from "./components/history_view.js";
import { initSearch } from "./components/search.js";
import { initInsights } from "./components/insights.js";
import { initSecurityPages } from "./components/security_pages.js";
import { initSetup } from "./components/setup.js";
import { openApiAccess } from "./components/apiaccess.js";
import { openPhoneApp } from "./components/phoneapp.js";
import { openClaudeReport } from "./components/report.js";
import { initDashboard } from "./components/dashboard.js";
import { initSettings } from "./components/settings_view.js";
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
      { label: "Report for Claude", open: () => openClaudeReport() },
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
  const groups = [];
  for (const item of MENU) {
    if (item.children) {
      const subs = item.children.map((c) => h("div.menu-sub", { hidden: true, on: { click: guard(c.open) } }, c.label));
      const head = h("div.menu-item.group", item.label);
      groups.push({ head, subs });
      head.addEventListener("click", () => {
        const open = !head.classList.contains("open");
        // one group open at a time keeps the list short
        for (const g of groups) {
          g.head.classList.toggle("open", g.head === head && open);
          g.subs.forEach((x) => (x.hidden = !(g.head === head && open)));
        }
      });
      nav.append(head, ...subs);
    } else {
      nav.append(h("div.menu-item", { on: { click: guard(item.open) } }, item.label));
    }
  }
  renderLauncher(guard);
  if (!document.getElementById("adv-links")) initAdvancedLinks(guard);
}

// The Advanced windows behind each simple page (labels from MENU).
const RELATED = {
  dashboard: ["Interfaces", "Resources", "Connections", "Log"],
  clients: ["DHCP Leases", "ARP / Neighbors", "DHCP Server", "Queues", "Torch", "Connections"],
  networks: ["Interfaces", "Addresses", "DHCP Server", "Routes", "DNS"],
  rules: ["Filter Rules", "Address Lists", "Connections"],
  access: ["Filter Rules", "Address Lists", "Interfaces"],
  ids: ["Filter Rules", "Address Lists", "Log"],
  ports: ["NAT", "Filter Rules"],
  vpn: ["VPN", "Interfaces", "Routes"],
  history: ["Revisions / Rollback", "Backup / Restore"],
  insights: ["Log", "Torch", "DNS Server (Technitium)"],
  settings: ["Interfaces", "DNS", "Dynamic DNS", "Filter Rules", "Services", "Queues", "Identity & Clock", "Images (Upgrade)", "Backup / Restore", "Users"],
};

/** "Advanced ▾" next to the page title: opens the related Advanced windows. */
function initAdvancedLinks(guard) {
  const items = new Map(MENU.flatMap((m) => (m.children || [m]).map((c) => [c.label, c.open])));
  const btn = h("button#adv-links", { title: "Open the related Advanced windows (every setting, RouterOS-style)" }, "Advanced ▾");
  const pop = h("div.adv-pop", { hidden: true });
  const close = () => (pop.hidden = true);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
  });
  document.addEventListener("click", close);
  document.addEventListener("keydown", (e) => e.key === "Escape" && close());
  document.getElementById("page-title").after(h("span.adv-wrap", btn, pop));
  const render = (view) => {
    const labels = (RELATED[view] || []).filter((l) => items.has(l));
    btn.hidden = !labels.length;
    close();
    clear(pop).append(...labels.map((l) => h("button.adv-item", { on: { click: () => {
      close();
      guard(items.get(l))();
    } } }, l)), h("div.adv-sep"), h("button.adv-item", { on: { click: () => {
      close();
      showView("windows");
    } } }, "All Advanced tools…"));
  };
  onAnyView(render);
  render(document.getElementById("app").dataset.view);
}

/** The empty Advanced workspace: every tool on one screen, grouped. */
function renderLauncher(guard) {
  const ws = document.getElementById("ws-area");
  ws.querySelector("#launcher")?.remove();
  const loose = MENU.filter((m) => !m.children);
  const card = (title, items) => h("section.launch-group", h("h3", title),
    h("div.launch-items", items.map((c) => h("button.launch-item", { on: { click: guard(c.open) } }, c.label))));
  ws.prepend(h("div#launcher",
    h("div.hint", "Pick a tool. Its window opens here; you can open several and arrange them. The same tools are in the list on the left."),
    h("div.launch-grid",
      card("General", loose),
      ...MENU.filter((m) => m.children).map((m) => card(m.label, m.children)))));
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

/** Drag the left menu's right edge to make it wider (double-click: back to normal). */
function initSidebarResize() {
  const app = document.getElementById("app");
  const side = document.getElementById("sidebar");
  const KEY = "vygi.sidebar.width";
  const set = (w) => (w ? app.style.setProperty("--sidebar-w", `${w}px`) : app.style.removeProperty("--sidebar-w"));
  try {
    set(Number(localStorage.getItem(KEY)) || 0);
  } catch {
    /* no storage: default width */
  }
  const grip = h("div#sidebar-grip", { title: "Drag to resize the menu (double-click to reset)" });
  side.append(grip);
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const left = side.getBoundingClientRect().left;
    const move = (ev) => set(Math.round(Math.min(Math.max(ev.clientX - left, 160), 520)));
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      app.classList.remove("resizing");
      try {
        localStorage.setItem(KEY, String(parseInt(app.style.getPropertyValue("--sidebar-w"), 10) || ""));
      } catch {
        /* not remembered */
      }
      window.dispatchEvent(new Event("resize")); // windows and charts re-fit
    };
    app.classList.add("resizing");
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });
  grip.addEventListener("dblclick", () => {
    set(0);
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* nothing stored */
    }
    window.dispatchEvent(new Event("resize"));
  });
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
  document.getElementById("web-api").addEventListener("click", (e) => {
    e.preventDefault();
    openApiAccess();
  });
  document.getElementById("web-phone").addEventListener("click", (e) => {
    e.preventDefault();
    openPhoneApp();
  });
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
  initSidebarResize();
  initViews();
  initPhone();
  initDashboard();
  initSettings();
  initClients();
  initNetworks();
  initRules();
  initPortForwards();
  initSecurityPages();
  initSetup();
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
    initAndroidApp();
  }
  showConnectDialog();
});
