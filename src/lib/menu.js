// Small popup menu (row "⋯" buttons, right-click). items: [{ label, fn,
// title?, danger? } | "-" (separator) | null (skipped)].
import { h } from "./dom.js";

let open = null;

export function closeMenu() {
  open?.remove();
  open = null;
}

/** Opens at the mouse position of `event`, or under `anchor`. */
export function popupMenu(items, { event = null, anchor = null } = {}) {
  closeMenu();
  const list = items.filter(Boolean).filter((it, i, all) => it !== "-" || (i > 0 && i < all.length - 1 && all[i - 1] !== "-"));
  while (list.at(-1) === "-") list.pop();
  const el = h("div.popup-menu", { role: "menu" }, list.map((it) => (it === "-"
    ? h("div.popup-sep")
    : h(`button.popup-item${it.danger ? ".danger" : ""}`, { role: "menuitem", title: it.title || "", on: { click: () => {
      closeMenu();
      it.fn();
    } } }, it.label))));
  document.body.append(el);
  open = el;
  const r = anchor?.getBoundingClientRect();
  let x = event ? event.clientX : r ? r.right - el.offsetWidth : 0;
  let y = event ? event.clientY : r ? r.bottom + 4 : 0;
  // keep it on screen
  x = Math.max(4, Math.min(x, innerWidth - el.offsetWidth - 4));
  if (y + el.offsetHeight > innerHeight - 4) y = Math.max(4, (r ? r.top - 4 : y) - el.offsetHeight);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.querySelector("button")?.focus();
}

if (typeof document !== "undefined") {
  document.addEventListener("mousedown", (e) => open && !open.contains(e.target) && closeMenu(), true);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());
  window.addEventListener("resize", closeMenu);
}
