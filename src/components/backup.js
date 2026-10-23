// System > Backup / Restore: save the config to a file on this computer, or load one.
import { save, open } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../lib/api.js";
import { h, setStatus } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { confirmBox, alertBox } from "../lib/dialog.js";
import { applyTxStatus, session } from "../lib/session.js";

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function openBackup() {
  const win = openWindow({ key: "backup", title: "Backup / Restore", width: 560, height: 330 });
  if (!win.isNew) return;

  const host = () => (session.info?.hostname || "vyos").replace(/[^A-Za-z0-9._-]/g, "_");

  async function exportAs(format) {
    const isBoot = format === "boot";
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
    const file = await open({ title: "Choose a config.boot backup", multiple: false, directory: false });
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
      applyTxStatus(await api.importConfig(file, minutes));
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

  win.body.style.overflow = "auto";
  win.body.append(
    section("Backup", "Saves the router's current running configuration to a file on this computer.",
      h("button", { on: { click: () => exportAs("boot") } }, "Save as config.boot…"),
      h("button", { on: { click: () => exportAs("commands") } }, "Save as set-commands…")),
    section("Restore", "Loads a config.boot backup as the running configuration (live, no reboot). Press Save afterwards to keep it across reboots.",
      h("button", { on: { click: restore } }, "Restore from file…")),
  );
}
