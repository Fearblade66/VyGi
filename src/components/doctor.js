// Health check: the config doctor's findings (problems, conflicts, security
// and leftovers) with fixes. Fixes that only touch VyGi's own settings apply
// in one click; ones that change hand-made settings show exactly what they
// change and ask first.
import { api, errorText } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges, session } from "../lib/session.js";
import { diagnose } from "../lib/doctor.js";
import { wanInfo } from "../lib/wan.js";
import { changePassword } from "./security.js";

const ORDER = { bad: 0, warn: 1, info: 2 };
const line = (c) => `${c.op} ${c.path.join(" ")}${c.value !== undefined ? ` '${c.value}'` : ""}`;

export async function loadDoctor() {
  const [cfg, w, vygiAddr] = await Promise.all([api.getConfig([]), wanInfo(), api.clientAddress().catch(() => "")]);
  return diagnose(cfg || {}, {
    wan: w.wan,
    wanCidr: w.wanCidr,
    mgmtHost: session.info?.profile?.host,
    defaultPassword: !!session.info?.defaultPassword,
    user: session.info?.profile?.sshUser || "vyos",
    vygiAddr,
  }).sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}

/** Renders findings into `el`; `reload` runs after a fix. */
export function renderDoctor(el, findings, reload) {
  if (!findings.length) {
    clear(el).append(h("div.empty", h("span.pill.ok", "all good"), " No problems or conflicts found."));
    return;
  }
  const tidy = findings.filter((f) => f.id.startsWith("leftover-") && f.fix);
  clear(el).append(h("div.sec-list",
    findings.filter((f) => !f.id.startsWith("leftover-")).map((f) => h(`div.sec-item.${f.level}`,
      h("div.grow",
        h("div.sec-title", h(`span.pill.${f.level === "bad" ? "bad" : f.level === "warn" ? "warn" : "muted"}`, f.level === "bad" ? "problem" : f.level === "warn" ? "advice" : "note"), " ", f.title),
        h("div.hint", f.text),
        f.manual ? h("div.hint", { style: { fontStyle: "italic" } }, "The fix changes settings made by hand, so VyGi asks first.") : null),
      f.fix || f.needs ? h("button", { on: { click: () => fix(f, reload) } }, f.fixLabel || "Fix") : null)),
    tidy.length ? h("div.sec-item.info",
      h("div.grow", h("div.sec-title", h("span.pill.muted", "tidy"), ` ${tidy.length} leftover${tidy.length === 1 ? "" : "s"} from deleted VyGi settings`),
        h("div.hint", tidy.map((f) => f.text).join(" "))),
      h("button", { on: { click: () => fixAll(tidy, reload) } }, "Clean up")) : null));
}

async function fix(f, reload) {
  if (f.needs === "password") return changePassword(reload);
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
