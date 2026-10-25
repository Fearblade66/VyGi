// System > Backup / Restore: save the config to a file, load one, and browse the
// automatic snapshot history taken at each connect (see checkup.js).
import { save, open } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../lib/api.js";
import { isDesktop, saveText, pickText } from "../lib/platform.js";
import { h, setStatus } from "../lib/dom.js";
import { openWindow, tabs } from "../lib/mdi.js";
import { makeTable } from "../lib/table.js";
import { changesPre, fmtDate } from "../lib/changes.js";
import { confirmBox, alertBox } from "../lib/dialog.js";
import { applyTxStatus, session } from "../lib/session.js";

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

let selectTab = null; // switches tabs of the open window, if any

export function openBackup(startTab = "Backup") {
  const win = openWindow({ key: "backup", title: "Backup / Restore", width: 780, height: 500 });
  if (!win.isNew) return selectTab?.(startTab);
  const t = tabs(["Backup", "History"], (name) => name === "History" && loadHistory());
  win.body.append(t.el);
  selectTab = t.select;
  win.onClose(() => (selectTab = null));

  const host = () => (session.info?.hostname || "vyos").replace(/[^A-Za-z0-9._-]/g, "_");

  async function exportAs(format) {
    const isBoot = format === "boot";
    if (!isDesktop) {
      // browser: the server sends the text, the browser downloads it
      try {
        const text = await api.exportConfigText(format);
        const name = await saveText(`${host()}-${stamp()}${isBoot ? ".config.boot" : "-commands.txt"}`, text);
        setStatus(`Downloaded ${name} (${text.length} bytes).`);
        if (isBoot && !text.includes("vyos-config-version")) {
          alertBox("Backup saved (no version info)", "The router's commit archive was not available, so this backup has no VyOS version footer. It restores fine on the same VyOS version, but may not migrate correctly to a different one.");
        }
      } catch (e) {
        alertBox("Backup failed", errorText(e));
      }
      return;
    }
    const file = await save({
      title: "Save configuration backup",
      defaultPath: `${host()}-${stamp()}${isBoot ? ".config.boot" : "-commands.txt"}`,
      filters: isBoot ? [{ name: "VyOS config", extensions: ["boot", "conf", "txt"] }] : [{ name: "Text", extensions: ["txt"] }],
    });
    if (!file) return;
    try {
      const r = await api.exportConfig(file, format);
      setStatus(`Saved ${r.bytes} bytes to ${file}`);
      if (isBoot && !r.hasVersionFooter) {
        alertBox("Backup saved (no version info)", "The router's commit archive was not available, so this backup has no VyOS version footer. It restores fine on the same VyOS version, but may not migrate correctly to a different one.");
      }
    } catch (e) {
      alertBox("Backup failed", errorText(e));
    }
  }

  async function restore() {
    let file;
    let text = null;
    if (isDesktop) {
      file = await open({ title: "Choose a config.boot backup", multiple: false, directory: false });
    } else {
      const picked = await pickText();
      if (picked?.tooBig) return alertBox("Restore", "That file is too large to be a VyOS config.");
      file = picked?.name;
      text = picked?.text;
    }
    if (!file) return;
    const safe = document.getElementById("safe-mode").checked;
    const minutes = safe ? Number(document.getElementById("safe-minutes").value) : 0;
    const ok = await confirmBox(
      "Restore configuration",
      `Replace the ENTIRE running configuration of ${session.info?.hostname} with:\n${file}\n\n` +
        "Interfaces, addresses, firewall, users, everything is replaced. If the file is from another router you will likely lose access.\n\n" +
        (safe ? `Safe Mode is ON: press Confirm within ${minutes} min to keep it, otherwise the router reverts.` : "Safe Mode is OFF: this is final. Turning Safe Mode on first is strongly recommended."),
      "Restore",
    );
    if (!ok) return;
    try {
      setStatus("Restoring configuration…");
      applyTxStatus(await (isDesktop ? api.importConfig(file, minutes) : api.importConfigText(text, minutes)));
      setStatus(safe ? "Configuration loaded. Check access, then press Confirm." : "Configuration loaded.");
    } catch (e) {
      alertBox("Restore failed", errorText(e));
      setStatus("Restore failed.", true);
    }
  }

  const section = (title, text, ...buttons) =>
    h("div", { style: { padding: "8px 10px", borderBottom: "1px solid var(--border)" } },
      h("div", { style: { fontWeight: "bold", marginBottom: "4px" } }, title),
      h("div.hint", { style: { marginBottom: "6px" } }, text),
      h("div", { style: { display: "flex", gap: "6px" } }, ...buttons));

  t.pages.Backup.style.overflow = "auto";
  t.pages.Backup.append(
    section("Backup", isDesktop ? "Saves the router's current running configuration to a file on this computer." : "Downloads the router's current running configuration to this device.",
      h("button", { on: { click: () => exportAs("boot") } }, "Save as config.boot…"),
      h("button", { on: { click: () => exportAs("commands") } }, "Save as set-commands…")),
    section("Restore", "Loads a config.boot backup as the running configuration (live, no reboot). Press Save afterwards to keep it across reboots.",
      h("button", { on: { click: restore } }, "Restore from file…")),
  );

  // ---------------- History ----------------
  const detail = h("div", { style: { flex: "1", display: "flex", flexDirection: "column", minHeight: "0" } }, h("div.hint", { style: { padding: "6px" } }, "Select a snapshot to see what changed in it."));
  const table = makeTable(
    [
      { key: "when", label: "Taken", width: "200px" },
      { key: "size", label: "Size", width: "80px", className: "num" },
      { key: "note", label: "" },
    ],
    {
      rowKey: (r) => r.id,
      onSelect: async (r) => {
        detail.innerHTML = "";
        try {
          const d = await api.historyDiff(r.id);
          detail.append(
            h("div.hint", { style: { padding: "4px 6px" } }, d.since ? `Changes compared to ${fmtDate(d.since)}:` : "First snapshot (everything is new):"),
            changesPre(d.added, d.removed),
          );
        } catch (e) {
          detail.append(h("div.err-box", errorText(e)));
        }
      },
    },
  );
  table.wrap.style.flex = "1";
  t.pages.History.append(
    h(
      "div.win-toolbar",
      h("button", { on: { click: () => loadHistory() } }, "⟳"),
      h("button", { title: "Load the selected snapshot as the running config", on: { click: restoreSnapshot } }, "Restore selected…"),
      h("span.hint", "A snapshot is saved automatically each time you connect and the config has changed."),
    ),
    h("div.split", table.wrap, detail),
  );

  async function loadHistory() {
    try {
      const list = await api.historyList();
      table.setRows(list.map((s, i) => ({ ...s, when: fmtDate(s.id), size: `${(s.bytes / 1024).toFixed(1)} KiB`, note: i === 0 ? "latest" : "" })));
    } catch (e) {
      setStatus(errorText(e), true);
    }
  }

  async function restoreSnapshot() {
    const r = table.selected();
    if (!r) return setStatus("Select a snapshot first.", true);
    const safe = document.getElementById("safe-mode").checked;
    const minutes = safe ? Number(document.getElementById("safe-minutes").value) : 0;
    const ok = await confirmBox(
      "Restore snapshot",
      `Replace the running configuration of ${session.info?.hostname} with the snapshot from ${r.when}?\n\n` +
        (safe ? `Safe Mode is ON: press Confirm within ${minutes} min to keep it.` : "Safe Mode is OFF: this is final."),
      "Restore",
    );
    if (!ok) return;
    try {
      applyTxStatus(await api.historyRestore(r.id, minutes));
      setStatus(`Snapshot from ${r.when} loaded.${safe ? " Press Confirm to keep it." : ""}`);
    } catch (e) {
      alertBox("Restore failed", errorText(e));
    }
  }

  t.select(startTab);
}
