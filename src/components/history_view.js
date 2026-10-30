// Change History: what VyGi changed on this router, in plain words, with Undo;
// changes made outside VyGi (the CLI, other tools) as router revisions; and the
// backups VyGi keeps, to go back further.
import { api, errorText } from "../lib/api.js";
import { h, clear, setStatus } from "../lib/dom.js";
import { confirmBox, alertBox, modal } from "../lib/dialog.js";
import { isConnected, onSessionChange, rollbackTo, session, applyTxStatus } from "../lib/session.js";
import { registerView, welcome, loadingPage } from "../lib/views.js";
import { icon } from "../lib/icons.js";
import { isDesktop } from "../lib/platform.js";
import { historyList, parseRevisions, undoPlan, updateEntry, describeRevision, revisionDate } from "../lib/history.js";
import { renderDiff } from "./system.js";
import { openBackup } from "./backup.js";

const when = (ms) => {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? `Today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
};
const sentence = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function initHistory() {
  const root = document.getElementById("history");
  let seq = 0;

  async function render() {
    const mine = ++seq;
    if (!isConnected()) {
      clear(root).append(welcome(() => document.getElementById("btn-connect").click()));
      return;
    }
    if (!root.querySelector(".page")) clear(root).append(loadingPage(1));
    const [rawRevisions, backups] = await Promise.all([
      api.listRevisions().catch(() => ""),
      api.routerBackups(session.info.profileId).catch(() => []),
    ]);
    const revisions = parseRevisions(rawRevisions);
    if (mine !== seq) return;
    const entries = historyList(session.info.profileId);
    const ours = new Set(entries.map((e) => e.stamp).filter(Boolean));
    const outside = revisions.filter((r) => !ours.has(r.stamp) && r.via !== "vyos-http-api").slice(0, 10);
    const head = h("div.page-head", h("div.hint", "Changes made with VyGi on this router, newest first. Undo puts the router back to how it was before that change (Safe Mode applies)."));
    const list = entries.length
      ? h("div.hist-list", entries.map((e) => row(e, entries, revisions)))
      : h("div.empty-state", h("span.net-icon", icon("clock", 20)), h("div", h("b", "No changes yet"), h("div.hint", "Everything you change with VyGi shows up here, so you can see what changed and undo it.")));
    clear(root).append(h("div.page", head, list,
      outside.length ? h("div", h("h4", "Changes Made Outside VyGi"), h("div.hint", "From the router's command line, other tools or the router itself. To undo one, use Advanced → System → Revisions."),
        h("div.hist-list", outside.map((r) => {
          const d = revisionDate(r.stamp);
          return h("div.hist-item",
            h("span.hist-when", { title: `${r.stamp} on the router's clock` }, d ? when(d.getTime()) : r.stamp),
            h("span.grow", { title: `Revision ${r.rev} by ${r.by}${r.via ? ` via ${r.via}` : ""}` }, describeRevision(r)),
            h("button", { on: { click: () => showRevision(r) } }, "What changed"));
        }))) : null,
      backupSection(backups)));
  }

  /** The newest backups (whole configuration), each with what changed and Restore. */
  function backupSection(backups) {
    const shown = backups.filter((b) => b.restorable).slice(0, 8);
    // a backup much smaller than the one before it is likely a router that lost its settings
    const small = (b) => {
      const i = backups.indexOf(b);
      return i + 1 < backups.length && b.lines < backups[i + 1].lines / 2;
    };
    return h("div",
      h("h4", "Backups"),
      h("div.hint", `The whole configuration, saved ${isDesktop ? "on this computer each time VyGi connects" : "by the VyGi server when it changes"}. Restoring one replaces the router's settings (Safe Mode applies).`),
      shown.length
        ? h("div.hist-list", shown.map((b) => h("div.hist-item",
          h("span.hist-when", when(b.id * 1000)),
          h("span.grow", `${b.lines} settings`, small(b) ? h("span.badge.warn", { style: { marginLeft: "8px" } }, "much smaller than the one before") : ""),
          h("button", { on: { click: () => showBackup(b) } }, "What changed"),
          h("button", { on: { click: () => restoreBackup(b) } }, "Restore…"))))
        : h("div.hint", "No backups yet."),
      h("p", h("button.link", { on: { click: () => openBackup("History") } }, "All backups, or save / load a backup file…")));
  }

  async function restoreBackup(b) {
    const safe = document.getElementById("safe-mode").checked;
    const minutes = safe ? Number(document.getElementById("safe-minutes").value) : 0;
    const ok = await confirmBox("Restore backup",
      `Replace the router's settings with the backup from ${when(b.id * 1000)}?\n\n${safe ? `Safe Mode is on: press Confirm within ${minutes} min to keep it.` : "Safe Mode is off: this is final."}`,
      "Restore");
    if (!ok) return;
    try {
      applyTxStatus(await api.historyRestore(b.id, minutes));
      setStatus(`Backup from ${when(b.id * 1000)} loaded.${safe ? " Press Confirm to keep it." : ""}`);
    } catch (e) {
      alertBox("Restore failed", errorText(e));
    }
    render();
  }

  function row(e, entries, revisions) {
    const off = e.reverted || e.undone;
    const state = e.reverted ? h("span.badge", "Undone by Safe Mode") : e.undone ? h("span.badge", "Undone") : e.pending ? h("span.badge.warn", "Waiting for Confirm") : null;
    return h(`div.hist-item${off ? ".off" : ""}`,
      h("span.hist-when", when(e.at)),
      h("span.grow", sentence(e.what)),
      state,
      off ? null : h("button", { on: { click: () => undo(e, entries, revisions) } }, "Undo"));
  }

  async function undo(e, entries, revisions) {
    const plan = undoPlan(entries, e, revisions);
    if (plan.error) return alertBox("Can't undo", plan.error);
    const also = [
      ...plan.later.map((x) => `• ${sentence(x.what)}`),
      ...(plan.foreign ? [`• ${plan.foreign} change(s) made outside VyGi`] : []),
    ];
    const msg = `Put the router back to how it was before "${e.what}"?` + (also.length ? `\n\nThese later changes will be undone too:\n${also.join("\n")}` : "");
    if (!(await confirmBox("Undo change", msg, "Undo"))) return;
    try {
      await rollbackTo(plan.rev, `undo: ${e.what}`);
      for (const x of [e, ...plan.later]) updateEntry(session.info.profileId, x.id, { undone: true });
      setStatus(`Undone: ${e.what}.`);
    } catch (err) {
      alertBox("Undo failed", errorText(err));
    }
    render();
  }

  onSessionChange(() => {
    if (!root.hidden) render();
  });
  registerView("history", { show: render, hide: () => {} });
}

/** What a backup changed compared with the one before it. */
async function showBackup(b) {
  const pre = h("pre.out.diff", "Loading…");
  api.historyDiff(b.id).then((d) => {
    renderDiff(pre, [...d.removed.map((l) => `- ${l}`), ...d.added.map((l) => `+ ${l}`)].join("\n") || "Same as the backup before it.");
  }).catch((e) => (pre.textContent = errorText(e)));
  await modal(`Backup from ${when(b.id * 1000)}`, h("div", { style: { width: "640px", maxWidth: "100%" } },
    h("div.hint", { style: { marginBottom: "6px" } }, "Compared with the backup before it: lines starting with + were added, lines with - were removed."), pre),
  [{ label: "Close", value: "ok", primary: true }]);
}

/** The changes one router revision made (lines starting + were added, - removed). */
async function showRevision(r) {
  const pre = h("pre.out.diff", "Loading…");
  api.revisionDiff(r.rev).then((t) => renderDiff(pre, t)).catch((e) => (pre.textContent = errorText(e)));
  await modal(describeRevision(r), h("div", { style: { width: "640px", maxWidth: "100%" } },
    h("div.hint", { style: { marginBottom: "6px" } }, "Lines starting with + were added, lines with - were removed."), pre),
  [{ label: "Close", value: "ok", primary: true }]);
}

