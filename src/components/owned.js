// Advanced windows: settings that a simple page made show which page owns
// them, and changing one here asks first (that page may change it back).
import { h } from "../lib/dom.js";
import { modal } from "../lib/dialog.js";
import { showView } from "../lib/views.js";
import { ownerOf, ownerText } from "../lib/owner.js";

export function openOwner(o) {
  if (o?.view) showView(o.view, { tab: o.tab });
}

/** A small tag "Traffic Rules: Kids bedtime" that opens that page. */
export function ownerBadge(description) {
  const o = ownerOf(description);
  if (!o) return "";
  return h("button.owner-badge", {
    title: o.view ? `Made on the ${o.feature} page. Click to change it there.` : "Made by VyGi.",
    on: { click: (e) => {
      e.stopPropagation();
      openOwner(o);
    } },
  }, ownerText(o));
}

/**
 * Before changing something a page owns: "go" (change it here anyway),
 * "manual" (detach it from the page first), or null (cancelled, or sent
 * to the page). canDetach: offer "Make it manual".
 */
export async function confirmOwned(description, what, { canDetach = true } = {}) {
  const o = ownerOf(description);
  if (!o) return "go";
  const buttons = [
    { label: "Cancel", value: null },
    ...(canDetach ? [{ label: "Make it manual", value: "manual" }] : []),
    { label: "Change it here", value: "go" },
    ...(o.view ? [{ label: `Open ${o.feature}`, value: "open", primary: true }] : []),
  ];
  const r = await modal(`Managed by ${o.feature}`, h("div", { style: { maxWidth: "480px" } },
    h("p", { style: { marginTop: 0 } }, `This ${what} belongs to `, h("b", ownerText(o)), "."),
    h("p.hint", "Changing it here works, but the next change on that page may undo it, and the page may stop showing it correctly. Change it there instead, or make it manual: VyGi then stops managing it (it disappears from that page and stays exactly as it is)."),
  ), buttons);
  if (r === "open") openOwner(o);
  return r === "go" || r === "manual" ? r : null;
}
