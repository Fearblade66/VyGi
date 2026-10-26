// One-line note about the router's internet address problem (see wanProblem).
import { h } from "../lib/dom.js";
import { alertBox } from "../lib/dialog.js";

/**
 * One-line note about wanProblem() for the pages it affects (Port
 * Forwarding, VPN): the full text is a click away, and "Don't show again"
 * hides it for that address. Settings > Internet always shows it in full.
 */
export function wanNotice(problem, ip) {
  if (!problem) return null;
  const key = `vygi.wan-notice.${problem.kind}.${ip}`;
  try {
    if (localStorage.getItem(key)) return null;
  } catch {
    /* no storage: show it */
  }
  const short = problem.kind === "cgnat"
    ? "Your provider shares its internet address with other customers, so the internet can't reach this router."
    : "This router sits behind another router (your modem), so the same ports must also be forwarded there.";
  const el = h("div.wan-notice",
    h("span.grow", short),
    h("button.link", { on: { click: () => alertBox("Internet address", problem.text) } }, "Details"),
    h("button.link", { on: { click: () => {
      try {
        localStorage.setItem(key, "1");
      } catch {
        /* shown again next time */
      }
      el.remove();
    } } }, "Don't show again"));
  return el;
}

