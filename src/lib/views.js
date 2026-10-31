// The pages and the sidebar: Home, Devices, Network, Security, Activity,
// System (groups of pages shown as tabs) and Advanced (the Winbox-style
// window workspace), plus the Classic / Modern look.
import { h } from "./dom.js";
import { icon, logo } from "./icons.js";

const VIEWS = {
  dashboard: { title: "Home", icon: "dashboard", el: "dashboard" },
  clients: { title: "Devices", icon: "clients", el: "clients" },
  networks: { title: "Local Networks", icon: "networks", el: "networks" },
  rules: { title: "Traffic Rules", icon: "rules", el: "rules" },
  access: { title: "Network Policies", icon: "networks", el: "access" },
  ports: { title: "Port Forwarding", icon: "forward", el: "ports" },
  filtering: { title: "Content Filtering", icon: "ban", el: "filtering" },
  ids: { title: "Intrusion Prevention", icon: "shield", el: "idspage" },
  vpn: { title: "VPN", icon: "vpn", el: "vpnpage" },
  history: { title: "Changes & Backups", icon: "clock", el: "history" },
  insights: { title: "Traffic & Logs", icon: "dashboard", el: "insights" },
  settings: { title: "Settings", icon: "gear", el: "settings" },
  windows: { title: "Advanced", icon: "advanced", el: "workspace" },
};
// Sidebar entries that hold several pages, shown as tabs under the top bar.
// An item is a view, or a view plus one of its own tabs (the Settings page
// has Internet, under Network, and Router and VyGi, under System).
const GROUPS = {
  network: { title: "Network", icon: "globe", items: [
    { view: "settings", tab: "internet", label: "Internet" },
    { view: "networks" },
    { view: "vpn" },
  ] },
  security: { title: "Security", icon: "shield", items: [{ view: "rules" }, { view: "access" }, { view: "ports" }, { view: "filtering" }, { view: "ids" }] },
  activity: { title: "Activity", icon: "activity", items: [{ view: "insights", webOnly: true }, { view: "history" }] },
  system: { title: "System", icon: "gear", items: [
    { view: "settings", tab: "router", label: "Router" },
    { view: "settings", tab: "vygi", label: "VyGi" },
  ] },
};
// the desktop app has no 24/7 server, so no Traffic & Logs page
const shown = (it) => !(it.webOnly && typeof window !== "undefined" && window.__TAURI_INTERNALS__);
/** The group a view (with its tab, for Settings) belongs to, or null. */
const groupOf = (view, tab = null) => Object.keys(GROUPS).find((g) =>
  GROUPS[g].items.some((i) => i.view === view && (!i.tab || !tab || i.tab === tab))) || null;
const listeners = new Map(); // view -> { show(), hide() }
let current = null;

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
  return value;
}

/**
 * [{ name, tab, title, group }] of every page as the menu names it (for the
 * search bar): Home, Devices, Advanced, and each group's tabs.
 */
export function pageList() {
  const out = [];
  for (const name of ["dashboard", "clients"]) out.push({ name, tab: null, title: VIEWS[name].title, group: null });
  for (const g of Object.values(GROUPS)) {
    for (const it of g.items.filter(shown)) out.push({ name: it.view, tab: it.tab || null, title: it.label || VIEWS[it.view].title, group: g.title });
  }
  out.push({ name: "windows", tab: null, title: VIEWS.windows.title, group: null });
  return out;
}

export function registerView(name, handlers) {
  listeners.set(name, handlers);
}

export function currentView() {
  return current;
}

/** The tab a view with its own tabs (Settings) shows. */
export function viewTab(view, fallback) {
  return store(`vygi.${view}.tab`) || fallback;
}

/**
 * Switches page; choosing the current page again reloads it. remember: save
 * as the page to reopen. A group name (security) opens its last-used page;
 * tab picks one of a page's own tabs.
 */
export function showView(name, { remember = true, tab = null } = {}) {
  // a group opens the page (and tab) used last in it
  if (GROUPS[name]) {
    const items = GROUPS[name].items.filter(shown);
    const [v, t] = String(store(`vygi.group.${name}`) || "").split(":");
    const last = items.find((i) => i.view === v && (i.tab || "") === (t || "")) || items[0];
    name = last.view;
    tab = last.tab || null;
  }
  if (!VIEWS[name]) name = "dashboard";
  if (tab) store(`vygi.${name}.tab`, tab);
  const group = groupOf(name, tab || viewTab(name, null));
  if (group) store(`vygi.group.${group}`, `${name}:${tab || ""}`);
  if (current) listeners.get(current)?.hide?.();
  current = name;
  currentGroup = group;
  for (const [v, def] of Object.entries(VIEWS)) document.getElementById(def.el).hidden = v !== name;
  for (const b of document.querySelectorAll("#view-switch button")) b.classList.toggle("on", b.dataset.view === (group || name));
  document.getElementById("app").dataset.view = name;
  document.getElementById("page-title").textContent = group ? GROUPS[group].title : VIEWS[name].title;
  renderSubnav(group, name);
  if (remember) store("vygi.view", name);
  listeners.get(name)?.show?.();
  anyView.forEach((fn) => fn(name));
}
let currentGroup = null;

/** The group's pages as tabs under the top bar. */
function renderSubnav(group, name) {
  const nav = document.getElementById("subnav");
  if (!nav) return;
  const items = group ? GROUPS[group].items.filter(shown) : [];
  nav.hidden = items.length < 2;
  nav.replaceChildren();
  if (!group) return;
  const tab = viewTab(name, items.find((x) => x.view === name)?.tab);
  for (const it of items) {
    const on = it.view === name && (!it.tab || it.tab === tab);
    nav.append(h(`button${on ? ".on" : ""}`, { on: { click: () => showView(it.view, { tab: it.tab }) } }, it.label || VIEWS[it.view].title));
  }
}

const anyView = [];
/** fn(view) after every view change. */
export function onAnyView(fn) {
  anyView.push(fn);
}

export function savedView() {
  const v = store("vygi.view");
  return VIEWS[v] ? v : "dashboard";
}

/** The sidebar entry a view belongs to (its group, or itself). */
export function navEntry(view) {
  if (view === current) return currentGroup || view;
  return groupOf(view) || view;
}

export function applyTheme(value) {
  const [ui, mode] = value === "classic" ? ["classic", ""] : value.split("-");
  const root = document.documentElement;
  if (ui === "modern") {
    root.dataset.ui = "modern";
    root.dataset.mode = mode || "auto";
  } else {
    delete root.dataset.ui;
    delete root.dataset.mode;
  }
  store("vygi.theme", value);
}

/** Placeholder while a page loads for the first time (grey cards that shimmer). */
export function loadingPage(cards = 3) {
  return h("div.page", h("div.skel.skel-line", { style: { width: "40%" } }),
    h("div.net-grid", Array.from({ length: cards }, () => h("div.skel.skel-card"))));
}

/** Empty state for pages that need a router. */
let welcomeExtra = null;
/** Something shown under the welcome card (the first-run setup steps). */
export function setWelcomeExtra(fn) {
  welcomeExtra = fn;
}

export function welcome(onConnect) {
  return h("div.welcome",
    h("div.welcome-card",
      logo(56),
      h("h2", "Welcome to VyGi"),
      h("p", "Manage your VyOS router: devices, networks, traffic rules, VPN and every setting, with Safe Mode undoing anything that cuts you off."),
      h("button.primary", { on: { click: onConnect } }, "Connect to a router"),
      h("p.hint", "Tip: the window button next to the router name opens another window for a second router.")),
    welcomeExtra ? welcomeExtra() : null);
}

// Coming back from minimized: refresh the page (its timers skipped runs while hidden).
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (current && Date.now() - hiddenAt > 15_000 && !document.querySelector(".dialog")) {
    listeners.get(current)?.hide?.();
    listeners.get(current)?.show?.();
  }
});

export function initViews() {
  const theme = store("vygi.theme") || "modern-auto";
  const sel = document.getElementById("theme");
  sel.value = theme;
  applyTheme(theme);
  sel.addEventListener("change", () => applyTheme(sel.value));
  document.getElementById("brand-logo").append(logo(26));
  for (const b of document.querySelectorAll("#view-switch button")) {
    const label = b.textContent.trim();
    b.textContent = "";
    b.title = label; // shown when the sidebar is narrow (icons only)
    b.append(icon((VIEWS[b.dataset.view] || GROUPS[b.dataset.view]).icon), h("span.nav-text", label));
    b.addEventListener("click", () => showView(b.dataset.view));
  }
  const connect = document.getElementById("btn-connect");
  connect.textContent = "";
  connect.append(icon("power", 15), h("span#connect-label.nav-text", "Connect"));
  document.getElementById("btn-new-window").append(icon("window", 16));
  document.getElementById("btn-terminal").prepend(icon("terminal", 15));
  document.getElementById("btn-save").title = "Write running config to the boot config";
}
