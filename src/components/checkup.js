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
import { loadDoctor } from "./doctor.js";

// The router's state from the last check-up (unsaved changes, ports down, disk,
// memory…), shown in the Health Check next to the configuration findings.
let lastStatus = { router: null, items: [] };

/** Health Check entries from the last check-up of the connected router. */
export function statusFindings() {
  return lastStatus.router === session.info?.profileId ? lastStatus.items : [];
}

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
  const items = [];
  const item = (id, title, text) => items.push({ id: `status:${id}`, level: "warn", title, text, fix: null });
  if (c.unsaved) item("unsaved", "Changes aren't saved to the boot configuration", "They're lost when the router restarts. Press Save, or turn on Save changes automatically.");
  if (down.length) item("down", `No link on ${down.join(", ")}`, "These ports are set up but have no connection: an unplugged cable, or the device on the other side is off.");
  for (const d of hl.disks || []) if (d.usedPercent >= 85) item(`disk:${d.mount}`, `Disk ${d.mount} is ${d.usedPercent}% full`, "Remove old VyOS images (System > Router) or large logs before it fills up.");
  if (hl.memTotalKb && hl.memAvailableKb != null && hl.memAvailableKb / hl.memTotalKb < 0.1) item("memory", `Low memory: ${Math.round((hl.memAvailableKb / hl.memTotalKb) * 100)}% available`, "The router may slow down or stop services.");
  if (hl.load?.length && hl.cpus && hl.load[1] > hl.cpus * 1.5) item("load", `High load: ${hl.load.join(" / ")} on ${hl.cpus} CPUs`, "Something on the router is busy (intrusion detection, a big firewall, heavy traffic).");
  if (hl.errors?.length) item("errors", `${hl.errors.length} error${hl.errors.length === 1 ? "" : "s"} logged in the last 24 hours`, "See Advanced > Log, or the check-up details.");
  lastStatus = { router: session.info?.profileId, items };
  if (c.unsaved) warnings.push("The running config has changes that are NOT saved — they will be lost on reboot. Press Save if you want to keep them.");
  if (down.length) warnings.push(`Interfaces down: ${down.join(", ")}`);
  for (const d of hl.disks || []) if (d.usedPercent >= 85) warnings.push(`Disk ${d.mount} is ${d.usedPercent}% full`);
  if (hl.memTotalKb && hl.memAvailableKb != null && hl.memAvailableKb / hl.memTotalKb < 0.1) warnings.push(`Low memory: ${Math.round((hl.memAvailableKb / hl.memTotalKb) * 100)}% available`);
  if (hl.load?.length && hl.cpus && hl.load[1] > hl.cpus * 1.5) warnings.push(`High load: ${hl.load.join(" / ")} on ${hl.cpus} CPUs`);
  if (hl.uptimeSecs != null && hl.uptimeSecs < 3600) warnings.push(`Router restarted recently (up ${fmtUptime(hl.uptimeSecs)})`);
  if (hl.errors?.length) warnings.push(`${hl.errors.length} error(s) logged in the last 24 hours`);

  const changed = c.changes && (c.changes.added.length || c.changes.removed.length);
  // one count everywhere: the Health Check's (configuration and router state)
  const health = await loadDoctor().catch(() => null);
  const toLook = health ? health.filter((f) => f.level === "bad" || f.level === "warn").length : warnings.length;
  const summary = [
    c.backupSaved ? (c.changes ? "Configuration changed: new backup saved" : "First visit: backup history started") : "Configuration unchanged since last visit",
    `${c.snapshotCount} backup${c.snapshotCount === 1 ? "" : "s"} on ${isDesktop ? "this computer" : "the VyGi server"}`,
    toLook ? `Health Check: ${toLook} to look at` : "Health Check: all good",
  ].join(" · ");
  const msg = `Check-up: ${summary}`;
  const modern = document.documentElement.dataset.ui === "modern";
  const nothing = !toLook && !changed && !c.problems.length;
  if (modern && !alwaysShow) {
    // Modern look: a pop-up with Details instead of a window over everything.
    setStatus(msg, false, { silent: true });
    toast(msg, {
      warn: !!health?.some((f) => f.level === "bad"),
      // what changed since last time is in the check-up window; anything else is the Health Check
      action: nothing ? null : changed || c.problems.length
        ? { label: "Details", fn: () => { showView("windows"); showWindow(c, warnings, down); } }
        : { label: "Health Check", fn: () => showView("settings", { tab: "router" }) },
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
