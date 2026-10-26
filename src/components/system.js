// System > Revisions: commit history, diffs, and rollback without reboot.
import { api, errorText } from "../lib/api.js";
import { h, clear, setStatus } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { makeTable } from "../lib/table.js";
import { confirmBox, alertBox } from "../lib/dialog.js";
import { rollbackTo, onSessionChange } from "../lib/session.js";

/** `show system commit` lines look like "3  2026-01-02 10:11:12  by vyos  via cli",
 * optionally followed by an indented commit-comment line. */
export function parseRevisions(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d{4}-\d\d-\d\d\s+[\d:]+)\s+by\s+(\S+)\s+via\s+(.*?)\s*$/);
    if (m) out.push({ rev: Number(m[1]), time: m[2], user: m[3], via: m[4], comment: "" });
    else if (line.trim() && out.length) out[out.length - 1].comment = line.trim(); // commit comment line
  }
  return out;
}

export function renderDiff(pre, text) {
  clear(pre);
  for (const line of (text || "(no differences)").split("\n")) {
    const cls = /^\s*\+/.test(line) ? "diff-add" : /^\s*-/.test(line) ? "diff-del" : null;
    pre.append(cls ? h(`span.${cls}`, line) : line, "\n");
  }
}

export function openRevisions() {
  const win = openWindow({ key: "revisions", title: "Configuration Revisions", width: 820, height: 520 });
  if (!win.isNew) return;

  const pre = h("pre.out");
  const table = makeTable(
    [
      { key: "rev", label: "#", width: "40px", className: "num" },
      { key: "time", label: "Time", width: "170px" },
      { key: "user", label: "User", width: "90px" },
      { key: "via", label: "Via", width: "120px" },
      { key: "comment", label: "Comment" },
    ],
    {
      rowKey: (r) => r.rev,
      onSelect: async (r) => {
        pre.textContent = "Loading diff…";
        try {
          renderDiff(pre, await api.revisionDiff(r.rev));
        } catch (e) {
          pre.textContent = errorText(e);
        }
      },
    },
  );
  const toolbar = h(
    "div.win-toolbar",
    h("button", { on: { click: load } }, "⟳"),
    h("button", { title: "Make the selected revision the running config", on: { click: rollback } }, "Rollback to selected"),
    h("span.grow"),
    h("span.hint", "Select a revision to see what that commit changed."),
  );
  table.wrap.style.flex = "1";
  win.body.append(toolbar, h("div.split", table.wrap, pre));

  async function load() {
    try {
      table.setRows(parseRevisions(await api.listRevisions()));
    } catch (e) {
      setStatus(errorText(e), true);
    }
  }

  async function rollback() {
    const r = table.selected();
    if (!r) return setStatus("Select a revision first.", true);
    if (r.rev === 0) return alertBox("Rollback", "Revision 0 is the current config already.");
    const safe = document.getElementById("safe-mode").checked;
    const ok = await confirmBox(
      "Rollback",
      `Load revision ${r.rev} (${r.time}) as the running configuration?\n\n` +
        `This is done live, without a reboot. ${safe ? "Safe Mode is ON: press Confirm afterwards to keep it." : "Safe Mode is OFF: the change is final once applied."}`,
      "Rollback",
    );
    if (!ok) return;
    try {
      setStatus(`Rolling back to revision ${r.rev}…`);
      await rollbackTo(r.rev);
      setStatus(`Revision ${r.rev} loaded.${safe ? " Press Confirm to keep it." : ""}`);
      load();
    } catch (e) {
      alertBox("Rollback failed", errorText(e));
    }
  }

  const off = onSessionChange(load);
  win.onClose(off);
  load();
}
