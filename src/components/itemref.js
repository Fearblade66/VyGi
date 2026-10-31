// Items on the simple pages (a network, a port forward, a traffic rule, a VPN
// device) and where they live in the VyOS configuration:
//  - "⋯" menu: Open in Advanced, the configuration tree opened at that item;
//  - "Show commands" (switch in the top bar on Network and Security): the
//    VyOS commands behind each item, under it (secrets hidden).
import { h } from "../lib/dom.js";
import { redact } from "../lib/redact.js";
import { showView, onAnyView, navEntry } from "../lib/views.js";
import { popMenu } from "./switcher.js";
import { openConfigTree } from "./config_tree.js";

const KEY = "vygi.showCommands";
const GROUPS = new Set(["network", "security"]);

/** [{ label, path }] -> the "⋯" button with "Open in Advanced: label" for each. */
export function itemMenu(refs, extra = []) {
  const list = refs.filter((r) => r && r.path?.length);
  const btn = h("button.icon-btn.item-more", { type: "button", title: "More", "aria-label": "More", "aria-haspopup": "menu" }, "⋯");
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // cards open their editor on click
    if (document.querySelector(".pop-menu")) return document.querySelector(".pop-menu").remove();
    popMenu(btn, (close) => [
      ...extra.map(([label, fn]) => h("button.pop-item", { role: "menuitem", on: { click: () => { close(); fn(); } } }, label)),
      ...list.map((r) => h("button.pop-item", { role: "menuitem", on: { click: () => { close(); openInAdvanced(r.path, r.label); } } }, `Open in Advanced: ${r.label}`)),
    ]);
  });
  return btn;
}

/** Opens the configuration tree at `path` in the Advanced workspace. */
export function openInAdvanced(path, label) {
  showView("windows");
  openConfigTree(path, label || path.join(" "));
}

/** The "set ..." lines for the config at each path (secrets as <redacted>). */
export function itemCommandLines(cfg, paths) {
  const lines = [];
  const quote = (s) => (/^[A-Za-z0-9._/:@-]+$/.test(s) ? s : `'${String(s).replaceAll("'", "'\\''")}'`);
  const walk = (node, path) => {
    if (node == null) return;
    if (typeof node !== "object" || Array.isArray(node)) {
      for (const v of [].concat(node)) lines.push(`set ${[...path, v].map(quote).join(" ")}`);
      return;
    }
    const entries = Object.entries(node);
    if (!entries.length) lines.push(`set ${path.map(quote).join(" ")}`);
    for (const [k, v] of entries) walk(v, [...path, k]);
  };
  for (const p of paths.filter(Boolean)) {
    const node = p.reduce((n, k) => (n == null ? undefined : n[k]), cfg);
    if (node !== undefined) walk(redact({ [p[p.length - 1]]: node })[p[p.length - 1]], p);
  }
  return lines;
}

/** The commands block under an item (shown while "Show commands" is on). */
export function itemCommands(cfg, paths) {
  const lines = itemCommandLines(cfg, paths);
  return lines.length ? h("pre.item-cmds", lines.join("\n")) : "";
}

/** The "Show commands" switch in the top bar (Network and Security pages). */
export function initShowCommands() {
  const app = document.getElementById("app");
  let on = false;
  try {
    on = localStorage.getItem(KEY) === "1";
  } catch {
    /* not remembered */
  }
  const box = h("input", { type: "checkbox", checked: on });
  const label = h("label.switch.tb-check#show-cmds", { title: "Show the VyOS commands behind each item" }, box, h("span.switch-ui"), " Show commands");
  const apply = () => app.classList.toggle("show-cmds", box.checked);
  box.addEventListener("change", () => {
    apply();
    try {
      localStorage.setItem(KEY, box.checked ? "1" : "0");
    } catch {
      /* not remembered */
    }
  });
  apply();
  document.querySelector("#toolbar .safe-group")?.before(label);
  const sync = (view) => (label.hidden = !GROUPS.has(navEntry(view)));
  onAnyView(sync);
  label.hidden = true;
}
