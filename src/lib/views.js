// Top-level views: Dashboard, Clients, Networks, Traffic Rules (UniFi-style pages)
// and Advanced (the Winbox-style window workspace), plus the Classic / Modern look.
import { h } from "./dom.js";
import { icon, logo } from "./icons.js";

const VIEWS = {
  dashboard: { title: "Dashboard", icon: "dashboard", el: "dashboard" },
  clients: { title: "Clients", icon: "clients", el: "clients" },
  networks: { title: "Networks", icon: "networks", el: "networks" },
  rules: { title: "Traffic Rules", icon: "rules", el: "rules" },
  windows: { title: "Advanced", icon: "advanced", el: "workspace" },
};
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

export function registerView(name, handlers) {
  listeners.set(name, handlers);
}

export function currentView() {
  return current;
}

/** Switches page; choosing the current page again reloads it. remember: save as the page to reopen. */
export function showView(name, { remember = true } = {}) {
  if (!VIEWS[name]) name = "dashboard";
  if (current) listeners.get(current)?.hide?.();
  current = name;
  for (const [v, def] of Object.entries(VIEWS)) document.getElementById(def.el).hidden = v !== name;
  for (const b of document.querySelectorAll("#view-switch button")) b.classList.toggle("on", b.dataset.view === name);
  document.getElementById("app").dataset.view = name;
  document.getElementById("page-title").textContent = VIEWS[name].title;
  if (remember) store("vygi.view", name);
  listeners.get(name)?.show?.();
}

export function savedView() {
  const v = store("vygi.view");
  return VIEWS[v] ? v : "dashboard";
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

/** Empty state for pages that need a router. */
export function welcome(onConnect) {
  return h("div.welcome",
    h("div.welcome-card",
      logo(56),
      h("h2", "Welcome to VyGi"),
      h("p", "Manage your VyOS router: devices, networks, traffic rules, VPN and every setting, with Safe Mode undoing anything that cuts you off."),
      h("button.primary", { on: { click: onConnect } }, "Connect to a router"),
      h("p.hint", "Tip: the window button next to the router name opens another window for a second router.")));
}

export function initViews() {
  const theme = store("vygi.theme") || "modern-auto";
  const sel = document.getElementById("theme");
  sel.value = theme;
  applyTheme(theme);
  sel.addEventListener("change", () => applyTheme(sel.value));
  document.getElementById("brand-logo").append(logo(26));
  for (const b of document.querySelectorAll("#view-switch button")) {
    b.prepend(icon(VIEWS[b.dataset.view].icon));
    b.addEventListener("click", () => showView(b.dataset.view));
  }
  document.getElementById("btn-new-window").append(icon("window", 16));
  document.getElementById("btn-terminal").prepend(icon("terminal", 15));
  document.getElementById("btn-save").title = "Write running config to the boot config";
}
