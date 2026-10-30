// Health check: the config doctor's findings (problems, conflicts, security
// and leftovers) with fixes. Fixes that only touch VyGi's own settings apply
// in one click; ones that change hand-made settings show exactly what they
// change and ask first.
import { api, errorText } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges } from "../lib/session.js";
import { diagnose } from "../lib/doctor.js";
import { routerContext } from "../lib/routerctx.js";
import { changePassword } from "./security.js";
import { statusFindings } from "./checkup.js";

const ORDER = { bad: 0, warn: 1, info: 2 };
const line = (c) => `${c.op} ${c.path.join(" ")}${c.value !== undefined ? ` '${c.value}'` : ""}`;

export async function loadDoctor() {
  const [cfg, ctx] = await Promise.all([api.getConfig([]), routerContext({ fresh: true })]);
  return [...diagnose(cfg || {}, ctx), ...statusFindings()].sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Renders findings into `el`; `reload` runs after a fix. compact (Dashboard):
 * one line per finding with its explanation a click away, and a summary
 * line when there are several.
 */
export function renderDoctor(el, findings, reload, { compact = false } = {}) {
  if (!findings.length) {
    clear(el).append(h("div.empty", h("span.pill.ok", "all good"), " No problems or conflicts found."));
    return;
  }
  const tidy = findings.filter((f) => f.id.startsWith("leftover-") && f.fix);
  const main = findings.filter((f) => !f.id.startsWith("leftover-"));
  const bad = main.filter((f) => f.level === "bad").length;
  const warn = main.filter((f) => f.level === "warn").length;
  const summary = compact && main.length > 2
    ? h("div.sec-summary", [bad ? count(bad, "problem", "problems") : "", warn ? count(warn, "piece of advice", "pieces of advice") : ""].filter(Boolean).join(", ") + ". Click one for details.")
    : null;
  clear(el).append(...(summary ? [summary] : []), h(`div.sec-list${compact ? ".compact" : ""}`,
    main.map((f) => {
      const more = h("div.sec-more", h("div.hint", f.text),
        f.manual ? h("div.hint", { style: { fontStyle: "italic" } }, "The fix changes settings made by hand, so VyGi asks first.") : null);
      more.hidden = compact;
      const title = h("div.sec-title", h(`span.pill.${f.level === "bad" ? "bad" : f.level === "warn" ? "warn" : "muted"}`, f.level === "bad" ? "problem" : f.level === "warn" ? "advice" : "note"), " ", f.title);
      if (compact) {
        title.classList.add("toggle");
        title.title = "Show or hide the details";
        title.addEventListener("click", () => {
          more.hidden = !more.hidden;
          title.classList.toggle("open", !more.hidden);
        });
      }
      return h(`div.sec-item.${f.level}`,
        h("div.grow", title, more),
        f.fix || f.needs ? h("button", { on: { click: () => fix(f, reload) } }, f.fixLabel || "Fix") : null);
    }),
    tidy.length ? h("div.sec-item.info",
      h("div.grow", h("div.sec-title", h("span.pill.muted", "tidy"), ` ${tidy.length} leftover${tidy.length === 1 ? "" : "s"} from deleted VyGi settings`),
        h("div.hint", tidy.map((f) => f.text).join(" "))),
      h("button", { on: { click: () => fixAll(tidy, reload) } }, "Clean up")) : null));
}

async function fix(f, reload) {
  if (f.needs === "password") return changePassword(reload, f.user || null);
  if (f.manual && !(await confirmBox("Change hand-made settings?", `To fix "${f.title}", VyGi would run:\n\n${f.fix.map(line).join("\n")}\n\nThese change settings that weren't made by VyGi's simple pages. Safe Mode applies.`, "Fix it"))) return;
  try {
    await applyChanges(f.fix, `fix: ${f.title.toLowerCase()}`, { check: false });
  } catch (e) {
    alertBox("Fix failed", errorText(e));
  }
  reload();
}

async function fixAll(list, reload) {
  try {
    await applyChanges(list.flatMap((f) => f.fix), "clean up leftovers", { check: false });
  } catch (e) {
    alertBox("Clean-up failed", errorText(e));
  }
  reload();
}
