// Phone layout (narrow screens and the Android app): a tab bar at the bottom
// for the main pages, the left menu as a drawer behind "More", Safe Mode
// moved into that drawer and search behind an icon, so the top bar is one row.
import { h } from "./dom.js";
import { icon } from "./icons.js";
import { showView, onAnyView, navEntry } from "./views.js";

export const PHONE = "(max-width: 760px)";
const TABS = [
  ["dashboard", "dashboard", "Home"],
  ["clients", "clients", "Devices"],
  ["network", "networks", "Network"],
  ["security", "rules", "Security"],
];

export function isPhone() {
  return typeof matchMedia === "function" && matchMedia(PHONE).matches;
}

export function initPhone() {
  const app = document.getElementById("app");
  const side = document.getElementById("sidebar");
  const toolbar = document.getElementById("toolbar");
  const safe = toolbar.querySelector(".safe-group");
  const safeSlot = h("div#drawer-safe");
  document.getElementById("sidebar-foot").prepend(safeSlot);

  const back = h("div#drawer-back", { on: { click: () => setDrawer(false) } });
  app.append(back);
  function setDrawer(on) {
    app.classList.toggle("drawer-open", on);
  }
  // picking a page or a tool closes the drawer
  side.addEventListener("click", (e) => {
    if (e.target.closest("#view-switch button, .menu-sub, .menu-item:not(.group), #btn-connect")) setDrawer(false);
  });

  const more = h("button.tab", { on: { click: () => setDrawer(!app.classList.contains("drawer-open")) } }, icon("advanced", 20), h("span", "More"));
  const tabs = TABS.map(([view, ic, label]) => h("button.tab", { "data-view": view, on: { click: () => {
    setDrawer(false);
    showView(view);
  } } }, icon(ic, 20), h("span", label)));
  app.append(h("nav#tabbar", ...tabs, more));
  onAnyView((view) => {
    const entry = navEntry(view);
    for (const t of tabs) t.classList.toggle("on", t.dataset.view === entry);
    more.classList.toggle("on", !TABS.some(([v]) => v === entry));
  });

  // search: an icon that opens the field as a second row
  const searchWrap = toolbar.querySelector(".search-wrap");
  const searchBtn = h("button#btn-search.icon-btn", { title: "Search", on: { click: () => {
    const on = !toolbar.classList.contains("search-open");
    toolbar.classList.toggle("search-open", on);
    if (on) document.getElementById("search").focus();
  } } }, icon("search", 17));
  document.getElementById("btn-alerts").before(searchBtn);
  document.getElementById("search").addEventListener("blur", () => setTimeout(() => {
    if (!searchWrap.contains(document.activeElement)) toolbar.classList.remove("search-open");
  }, 200));

  // Safe Mode lives in the drawer on phones, in the top bar otherwise
  const place = () => {
    if (isPhone()) safeSlot.append(safe);
    else if (safe.parentElement !== toolbar) searchWrap.after(safe);
    if (!isPhone()) setDrawer(false);
    window.dispatchEvent(new Event("resize"));
  };
  matchMedia(PHONE).addEventListener("change", place);
  place();
  document.addEventListener("keydown", (e) => e.key === "Escape" && setDrawer(false));
}
