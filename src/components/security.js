// Security card (Dashboard): what makes the router easy to attack, with
// one-click fixes applied through Safe Mode.
import { api, errorText } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { formDialog, alertBox } from "../lib/dialog.js";
import { applyChanges, session } from "../lib/session.js";
import { securityFindings } from "../lib/secure.js";
import { wanInfo } from "../lib/wan.js";

export async function loadFindings() {
  const [cfg, w] = await Promise.all([api.getConfig([]), wanInfo()]);
  return securityFindings(cfg || {}, {
    wan: w.wan,
    wanCidr: w.wanCidr,
    mgmtHost: session.info?.profile?.host,
    defaultPassword: !!session.info?.defaultPassword,
    user: session.info?.profile?.sshUser || "vyos",
  });
}

/** Renders findings into `el`; `reload` runs after a fix. */
export function renderFindings(el, findings, reload) {
  if (!findings.length) {
    clear(el).append(h("div.empty", h("span.pill.ok", "all good"), " No common security problems found."));
    return;
  }
  clear(el).append(h("div.sec-list", findings.map((f) => h(`div.sec-item.${f.level}`,
    h("div.grow",
      h("div.sec-title", h(`span.pill.${f.level}`, f.level === "bad" ? "risk" : "advice"), " ", f.title),
      h("div.hint", f.text)),
    f.fix || f.needs ? h("button", { on: { click: () => fix(f, reload) } }, f.fixLabel || "Fix") : null))));
}

async function fix(f, reload) {
  if (f.needs === "password") return changePassword(reload);
  try {
    await applyChanges(f.fix, f.fixLabel ? `${f.fixLabel}: ${f.title.toLowerCase()}` : f.title);
  } catch (e) {
    alertBox("Fix failed", errorText(e));
  }
  reload();
}

async function changePassword(reload) {
  const user = session.info?.profile?.sshUser || "vyos";
  const ok = await formDialog(`New password for ${user}`, [
    { name: "pw", label: "New password", type: "password", hint: "At least 8 characters. Something long and unique; VyGi remembers it for you." },
    { name: "pw2", label: "Again", type: "password" },
  ], async (v) => {
    if (v.pw !== v.pw2) throw new Error("The two passwords don't match");
    await api.changeLoginPassword(v.pw);
    return true;
  }, {
    okLabel: "Change password",
    intro: "This takes effect right away and is saved to the router's boot config (together with any other unsaved changes). Safe Mode doesn't apply to it.",
  });
  if (ok) {
    session.info.defaultPassword = false;
    reload();
  }
}
