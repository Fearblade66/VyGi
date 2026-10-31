// The account menu at the bottom of the sidebar: VyGi's own settings (API
// tokens, phone app, web password, saving, look, log out) in one place. The
// original controls stay in the page, hidden, and the menu works them, so
// everything that listens to them keeps working.
import { h } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { isDesktop } from "../lib/platform.js";
import { popMenu } from "./switcher.js";

export function initAccountMenu() {
  const foot = document.getElementById("sidebar-foot");
  const autosave = document.getElementById("auto-save");
  const theme = document.getElementById("theme");
  const click = (id) => () => document.getElementById(id)?.click();
  const btn = h("button#account-btn", { type: "button", "aria-haspopup": "menu", title: "VyGi settings" },
    h("span.account-avatar", icon("gear", 15)),
    h("span.nav-text.grow", isDesktop ? "Settings" : "Account and settings"),
    h("span.account-chevron", icon("chevron", 13)));
  foot.prepend(btn);
  btn.addEventListener("click", () => {
    if (document.querySelector(".pop-menu")) return document.querySelector(".pop-menu").remove();
    popMenu(btn, (close) => {
      const item = (label, fn) => h("button.pop-item", { role: "menuitem", on: { click: () => { close(); document.getElementById("app").classList.remove("drawer-open"); fn(); } } }, label);
      const save = h("input", { type: "checkbox", checked: autosave.checked, on: { change: () => {
        autosave.checked = save.checked;
        autosave.dispatchEvent(new Event("change"));
      } } });
      const look = h("select", { "aria-label": "Look", on: { change: () => {
        theme.value = look.value;
        theme.dispatchEvent(new Event("change"));
      } } }, [...theme.options].map((o) => h("option", { value: o.value, selected: o.value === theme.value }, o.textContent)));
      return [
        h("div.pop-label", isDesktop ? "VyGi settings" : "Your VyGi account and settings"),
        isDesktop ? null : [
          item("API tokens and Claude", click("web-api")),
          item("Phone app", click("web-phone")),
          item("Change web password", click("web-password")),
          h("div.pop-sep"),
        ],
        h("label.pop-item", { title: autosave.closest("label")?.title || "" }, save, " Save changes automatically"),
        h("div.pop-item", h("span.grow", "Look"), look),
        isDesktop ? null : [h("div.pop-sep"), item("Log out", click("web-logout"))],
      ].flat().filter(Boolean);
    }, { above: true });
  });
}
