// Inside the Android app: the back button, a read-only API token for the
// app's alert notifications, and "change server". The native side is in
// android/ (window.VyGiApp).
import { h, toast } from "./dom.js";
import { androidApp, webTokenCreate } from "./platform.js";
import { closeMenu } from "./menu.js";
import { showView, currentView } from "./views.js";

/** What the back button closes, innermost first; false = leave the app. */
function back() {
  const app = document.getElementById("app");
  if (document.querySelector(".popup-menu")) return closeMenu(), true;
  const dialog = [...document.querySelectorAll(".modal-back")].pop();
  if (dialog) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return true;
  }
  if (app.classList.contains("drawer-open")) return app.classList.remove("drawer-open"), true;
  const toolbar = document.getElementById("toolbar");
  if (toolbar.classList.contains("search-open")) return toolbar.classList.remove("search-open"), true;
  const side = currentView() === "clients" && document.querySelector("#clients .side:not([hidden]) button[title='Close']");
  if (side) return side.click(), true;
  if (currentView() === "windows") {
    const win = [...document.querySelectorAll("#workspace .mdi-win")].sort((a, b) => (Number(b.style.zIndex) || 0) - (Number(a.style.zIndex) || 0))[0];
    if (win) return win.querySelector(".mdi-title button[title='Close']").click(), true;
  }
  if (currentView() !== "dashboard") return showView("dashboard"), true;
  return false;
}

/** After logging in: give the app its own read-only token for notifications (once). */
async function ensureToken() {
  if (androidApp.hasToken()) return;
  const name = `Android app (${androidApp.deviceName()})`;
  try {
    // an earlier install's token is useless (its secret is gone): make a new one
    const { token, secret } = await webTokenCreate(name, "read");
    androidApp.setToken(secret, token.id);
    toast("Phone notifications are on: the app checks the VyGi server for new alerts every 15 minutes.");
  } catch (e) {
    console.warn("app token", e);
  }
}

export function initAndroidApp() {
  if (!androidApp) return;
  document.documentElement.dataset.app = "android";
  window.vygiBack = back;
  document.getElementById("web-account").append(" · ", h("a", { href: "#", on: { click: (e) => {
    e.preventDefault();
    androidApp.changeServer();
  } } }, "Change server"));
  ensureToken();
}
