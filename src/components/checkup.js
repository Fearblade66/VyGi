// Router check-up, run after each connect: local backup, changes since last visit, health.
import { api, errorText } from "../lib/api.js";
import { isDesktop } from "../lib/platform.js";
import { toast, h, setStatus, formatBytes } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { refreshTx, session } from "../lib/session.js";
import { flattenInterfaces, has } from "../lib/vyos.js";
import { openBackup } from "./backup.js";
import { showView } from "../lib/views.js";
import { changesPre, fmtDate } from "../lib/changes.js";

function fmtUptime(s) {
  if (s == null) return "?";
  const d = Math.floor(s / 86400);
  const hrs = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${hrs}h` : hrs ? `${hrs}h ${m}m` : `${m}m`;
}

/** Interfaces that are configured and enabled but have no link. */
async function downInterfaces() {
  const [cfg, stats] = await Promise.all([api.getConfig(["interfaces"]), api.interfaceStats()]);
  const conf = flattenInterfaces(cfg);
  const links = new Map((stats.links || []).map((l) => [l.ifname, l]));
  const down = [];
  for (const [name, c] of conf) {
    if (has(c.cfg, "disable") || c.type === "loopback") continue;
    const l = links.get(name);
    if (!l) down.push(`${name} (missing)`);
    else if (!(l.flags || []).includes("LOWER_UP") && l.operstate !== "UP" && l.operstate !== "UNKNOWN") down.push(name);
  }
  return down;
}

/**
 * Runs the check-up. Shows a window when there is something to look at;
 * otherwise only a status-bar line (unless `alwaysShow`).
 */
export async function runCheckup({ alwaysShow = false } = {}) {
  setStatus("Running check-up…");
  let c;
  try {
    c = await api.connectCheckup();
  } catch (e) {
    setStatus(`Check-up failed: ${errorText(e)}`, true);
    return;
  }
  await refreshTx();
  let down = [];
  try {
    down = await downInterfaces();
  } catch (e) {
    c.problems.push(`interface check: ${errorText(e)}`);
  }

  const hl = c.health;
  const warnings = [];
  if (c.unsaved) warnings.push("The running config has changes that are NOT saved — they will be lost on reboot. Press Save if you want to keep them.");
  if (down.length) warnings.push(`Interfaces down: ${down.join(", ")}`);
  for (const d of hl.disks || []) if (d.usedPercent >= 85) warnings.push(`Disk ${d.mount} is ${d.usedPercent}% full`);
  if (hl.memTotalKb && hl.memAvailableKb != null && hl.memAvailableKb / hl.memTotalKb < 0.1) warnings.push(`Low memory: ${Math.round((hl.memAvailableKb / hl.memTotalKb) * 100)}% available`);
  if (hl.load?.length && hl.cpus && hl.load[1] > hl.cpus * 1.5) warnings.push(`High load: ${hl.load.join(" / ")} on ${hl.cpus} CPUs`);
  if (hl.uptimeSecs != null && hl.uptimeSecs < 3600) warnings.push(`Router restarted recently (up ${fmtUptime(hl.uptimeSecs)})`);
  if (hl.errors?.length) warnings.push(`${hl.errors.length} error(s) logged in the last 24 hours`);

  const changed = c.changes && (c.changes.added.length || c.changes.removed.length);
  const summary = [
    c.backupSaved ? (c.changes ? "Config changed: new backup saved" : "First visit: backup history started") : "Config unchanged since last visit",
    `${c.snapshotCount} backup(s) on ${isDesktop ? "this computer" : "the VyGi server"}`,
    warnings.length ? `${warnings.length} warning(s)` : "no warnings",
  ].join(" · ");
  const msg = `Check-up: ${summary}`;
  const modern = document.documentElement.dataset.ui === "modern";
  const nothing = !warnings.length && !changed && !c.problems.length;
  if (modern && !alwaysShow) {
    // Modern look: a pop-up with Details instead of a window over everything.
    setStatus(msg, false, { silent: true });
    toast(nothing ? msg : `${msg}${changed ? " · config changed since last visit" : ""}`, {
      warn: warnings.length > 0,
      action: nothing ? null : { label: "Details", fn: () => { showView("windows"); showWindow(c, warnings, down); } },
    });
    return false;
  }
  setStatus(msg, warnings.length > 0);

  if (!alwaysShow && nothing) return false;
  showView("windows");
  showWindow(c, warnings, down);
  return true;
}

function showWindow(c, warnings) {
  const win = openWindow({ key: "checkup", title: `Check-up <${session.info?.hostname ?? ""}>`, width: 760, height: 520 });
  win.body.innerHTML = "";
  const hl = c.health;
  const section = (title, ...content) => h("div", { style: { padding: "6px 10px" } }, h("div", { style: { fontWeight: "bold", marginBottom: "4px" } }, title), ...content);
  const kv = (rows) => h("table.kv", rows.filter(Boolean).map(([k, v]) => h("tr", h("td", k), h("td.val", v))));
  const memPct = hl.memTotalKb ? Math.round(((hl.memTotalKb - (hl.memAvailableKb ?? 0)) / hl.memTotalKb) * 100) : null;

  const body = h("div", { style: { overflow: "auto", flex: "1" } },
    warnings.length
      ? section("Warnings", h("div.warn-box", warnings.map((w) => h("div", "• ", w))))
      : section("Warnings", h("div.hint", "None — everything looks healthy.")),
    section("Health", kv([
      ["Uptime", fmtUptime(hl.uptimeSecs)],
      ["Load (1/5/15 min)", hl.load?.length ? `${hl.load.join(" / ")}${hl.cpus ? ` on ${hl.cpus} CPUs` : ""}` : "?"],
      ["Memory used", memPct != null ? `${memPct}% of ${formatBytes(hl.memTotalKb * 1024)}` : "?"],
      ...(hl.disks || []).map((d) => [`Disk ${d.mount}`, `${d.usedPercent}% used`]),
      ["Unsaved changes", c.unsaved == null ? "unknown" : c.unsaved ? "YES" : "no"],
    ])),
    hl.errors?.length ? section("Recent errors (24 h)", h("pre.out", { style: { maxHeight: "160px" } }, hl.errors.join("\n"))) : null,
    c.changes
      ? section(`Changes since ${fmtDate(c.changes.since)} (${c.changes.added.length} added, ${c.changes.removed.length} removed)`,
          changesPre(c.changes.added, c.changes.removed),
          h("div.hint", "Includes changes made by anyone, from any tool (CLI, API, other apps). Secrets are masked."))
      : section("Changes", h("div.hint", `First visit to this router from ${isDesktop ? "this computer" : "the VyGi server"} — nothing to compare yet.`)),
    section("Backups",
      h("div.hint", `${c.snapshotCount} snapshot(s) kept in ${c.backupDir}. They contain secrets (keys, password hashes); keep ${isDesktop ? "this computer" : "the VyGi server"} secure.`),
      h("button", { style: { marginTop: "4px" }, on: { click: () => openBackup("History") } }, "Open backup history…")),
    c.problems.length ? section("Could not check", h("div.err-box", c.problems.map((p) => h("div", p)))) : null,
  );
  win.body.append(body);
}
