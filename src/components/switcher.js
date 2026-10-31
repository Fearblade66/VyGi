// The router switcher: the router card at the top of the sidebar opens a
// list of the saved routers (with their status on the web version), each to
// switch to, open in a new window or forget, plus Add router and Disconnect.
import { api, errorText } from "../lib/api.js";
import { h } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { confirmBox, alertBox } from "../lib/dialog.js";
import { session, isConnected } from "../lib/session.js";
import { isDesktop } from "../lib/platform.js";
import { showConnectDialog } from "./connect.js";

export const profileId = (p) => p.key || `${p.sshUser}@${p.host}`;

/**
 * A small menu next to `anchor` (closes on a click outside or Escape).
 * build(close) returns its content. Shared with the account menu.
 */
export function popMenu(anchor, build, { above = false } = {}) {
  document.querySelector(".pop-menu")?.remove();
  const menu = h("div.pop-menu", { role: "menu" });
  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", esc, true);
    anchor.setAttribute("aria-expanded", "false");
  };
  const outside = (e) => !menu.contains(e.target) && !anchor.contains(e.target) && close();
  const esc = (e) => e.key === "Escape" && close();
  menu.append(...[build(close)].flat());
  const r = anchor.getBoundingClientRect();
  Object.assign(menu.style, { left: `${Math.max(8, r.left)}px`, minWidth: `${Math.max(240, r.width)}px` });
  if (above) menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
  else menu.style.top = `${r.bottom + 6}px`;
  document.body.append(menu);
  document.addEventListener("mousedown", outside, true);
  document.addEventListener("keydown", esc, true);
  anchor.setAttribute("aria-expanded", "true");
  return close;
}

let disconnectFn = () => Promise.resolve();
let switchFn = () => {};
/** Disconnects this window (asks about unsaved changes first). */
export const disconnectRouter = () => disconnectFn();
/** Switches this window to saved router p. */
export const switchToRouter = (p) => switchFn(p);

/** disconnect(): the toolbar's disconnect (asks about unsaved changes); resolves when done or cancelled. */
export function initRouterSwitcher(disconnect) {
  disconnectFn = disconnect;
  switchFn = (p) => switchTo(p);
  const card = document.getElementById("router-card");
  card.setAttribute("role", "button");
  card.setAttribute("tabindex", "0");
  card.setAttribute("aria-haspopup", "menu");
  card.title = "Switch router";
  card.append(h("span.switch-chevron", icon("chevron", 14)));
  const open = () => {
    if (document.querySelector(".pop-menu")) return document.querySelector(".pop-menu").remove();
    popMenu(card, (close) => {
      const list = h("div.pop-list", h("div.hint", { style: { padding: "6px 10px" } }, "Loading…"));
      fill(list, close).catch((e) => list.replaceChildren(h("div.err-box", errorText(e))));
      return [
        h("div.pop-label", "Routers"),
        list,
        h("div.pop-sep"),
        h("button.pop-item.pop-accent", { role: "menuitem", on: { click: () => { close(); showConnectDialog({ blank: true }); } } }, "+ Add router"),
        isConnected() ? h("button.pop-item", { role: "menuitem", on: { click: () => { close(); disconnect(); } } }, `Disconnect from ${session.info?.profile?.name || session.info?.hostname || "this router"}`) : null,
      ];
    });
  };
  card.addEventListener("click", (e) => {
    if (e.target.closest("button")) return; // the card's own buttons
    open();
  });
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });

  async function switchTo(p) {
    if (isConnected()) {
      await disconnect();
      if (isConnected()) return; // cancelled
    }
    location.hash = `router=${encodeURIComponent(profileId(p))}`;
    showConnectDialog();
  }

  async function fill(list, close) {
    const [routers, overview] = await Promise.all([
      api.listRouters(),
      isDesktop ? Promise.resolve([]) : api.routersOverview().catch(() => []),
    ]);
    const live = new Map(overview.map((r) => [r.id, r.status || {}]));
    const me = session.info?.profileId;
    if (!routers.length) {
      list.replaceChildren(h("div.hint", { style: { padding: "6px 10px" } }, "No routers yet."));
      return;
    }
    list.replaceChildren(...routers.map((p) => {
      const id = profileId(p);
      const st = live.get(id);
      const state = id === me ? ["ok", "connected here"] : st?.connected ? ["ok", "online (watched 24/7)"] : st?.error ? ["bad", "can't reach it"] : ["muted", ""];
      return h("div.pop-row",
        h("button.pop-item", { role: "menuitem", title: id === me ? "This window's router" : `Switch to ${p.name || p.host}`, on: { click: () => { close(); if (id !== me) switchTo(p); } } },
          h(`span.pop-dot.${state[0]}`),
          h("span.grow", h("b", p.name || p.host), h("span.hint", ` ${p.host}`), state[1] ? h("div.hint", state[1]) : null)),
        h("button.icon-btn", { title: "Open in a new window", "aria-label": `Open ${p.name || p.host} in a new window`, on: { click: () => {
          close();
          if (isDesktop) api.newWindow().catch((e) => alertBox("New window", errorText(e)));
          else window.open(`${location.pathname}#router=${encodeURIComponent(id)}`, "_blank", "noopener");
        } } }, icon("window", 14)),
        id === me ? null : h("button.icon-btn", { title: "Forget this router", "aria-label": `Forget ${p.name || p.host}`, on: { click: async () => {
          close();
          if (!(await confirmBox("Forget router", `Forget ${p.name || p.host} (${p.host}) and its saved password and key? Its backups and history stay.`, "Forget"))) return;
          await api.forgetRouter(id).catch((e) => alertBox("Forget router", errorText(e)));
        } } }, icon("trash", 14)));
    }));
  }
}
