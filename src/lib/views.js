// Top-level views: Dashboard and Clients (UniFi-style pages) and Windows (Winbox MDI),
// plus the Classic / Modern look.
const listeners = new Map(); // view -> { show(), hide() }
let current = "windows";

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

export function showView(name) {
  if (name === current && !document.getElementById(name === "windows" ? "workspace" : name).hidden) return;
  listeners.get(current)?.hide?.();
  current = name;
  for (const v of ["dashboard", "clients", "windows"]) {
    document.getElementById(v === "windows" ? "workspace" : v).hidden = v !== name;
  }
  for (const b of document.querySelectorAll("#view-switch button")) b.classList.toggle("on", b.dataset.view === name);
  store("vygi.view", name);
  listeners.get(name)?.show?.();
}

export function savedView() {
  return store("vygi.view") || "dashboard";
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

export function initViews() {
  const theme = store("vygi.theme") || "modern-auto";
  const sel = document.getElementById("theme");
  sel.value = theme;
  applyTheme(theme);
  sel.addEventListener("change", () => applyTheme(sel.value));
  for (const b of document.querySelectorAll("#view-switch button")) b.addEventListener("click", () => showView(b.dataset.view));
}
