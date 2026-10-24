// System windows: Resources (live CPU/memory), Identity & Clock, Reboot/Shutdown, Images.
import { api, errorText } from "../lib/api.js";
import { h, setStatus, formatBytes } from "../lib/dom.js";
import { openWindow, closeAllWindows } from "../lib/mdi.js";
import { makeTable } from "../lib/table.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges, session, setConnected } from "../lib/session.js";
import { liveChart } from "../lib/chart.js";
import { showView } from "../lib/views.js";
import { tagKeys, diffSingle } from "../lib/vyos.js";

export function fmtUptime(s) {
  if (s == null) return "?";
  const d = Math.floor(s / 86400);
  const hrs = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${hrs}h ${m}m` : hrs ? `${hrs}h ${m}m` : `${m}m`;
}

/** CPU % from two /proc/stat samples (user nice system idle iowait irq softirq steal). */
export function cpuPercent(prev, cur) {
  if (!prev || !cur || prev.length < 4 || cur.length < 4) return NaN;
  const total = (a) => a.slice(0, 8).reduce((x, y) => x + y, 0);
  const idle = (a) => a[3] + (a[4] || 0);
  const dt = total(cur) - total(prev);
  return dt > 0 ? Math.max(0, Math.min(100, (1 - (idle(cur) - idle(prev)) / dt) * 100)) : NaN;
}

const meter = (pct) => h(`div.meter${pct >= 90 ? ".bad" : pct >= 75 ? ".warn" : ""}`, h("span", { style: { width: `${Math.min(100, pct || 0)}%` } }));

export function openResources() {
  const win = openWindow({ key: "resources", title: "Resources", width: 720, height: 520 });
  if (!win.isNew) return;
  const stats = h("div.stat-grid");
  const cpuChart = liveChart([{ label: "CPU", color: "#2b6cb0" }], { format: (v) => `${Math.round(v)}%`, max: 100, height: 120 });
  const memChart = liveChart([{ label: "Memory", color: "#2e8b3e" }], { format: (v) => `${Math.round(v)}%`, max: 100, height: 120 });
  const info = h("div.hint", { style: { padding: "4px 10px" } }, "Loading…");
  win.body.style.overflow = "auto";
  win.body.append(info, stats, h("div.section-title", "CPU"), cpuChart.el, h("div.section-title", "Memory"), memChart.el);

  let prev = null;
  let sys = null;
  api.systemInfo().then((s) => {
    sys = s;
    const v = s.version || {};
    info.textContent = `VyOS ${v.version ?? "?"} (${v.release_train ?? "?"}, ${v.architecture ?? "?"}) · ${s.cpus ?? "?"} × ${s.cpuModel ?? "CPU"}`;
  }).catch((e) => (info.textContent = errorText(e)));

  async function poll() {
    let l;
    try {
      l = await api.systemLoad();
    } catch (e) {
      return setStatus(errorText(e), true);
    }
    const cpu = cpuPercent(prev, l.cpuTimes);
    prev = l.cpuTimes;
    const memPct = l.memTotalKb ? ((l.memTotalKb - (l.memAvailableKb ?? 0)) / l.memTotalKb) * 100 : NaN;
    if (Number.isFinite(cpu)) cpuChart.push([cpu]);
    if (Number.isFinite(memPct)) memChart.push([memPct]);
    const disks = Array.isArray(sys?.storage) ? sys.storage : [];
    stats.textContent = "";
    const stat = (k, v, pct) => h("div.stat", h("div.k", k), h("div.v", v), pct != null ? meter(pct) : null);
    stats.append(
      stat("Uptime", fmtUptime(l.uptimeSecs)),
      stat("CPU", Number.isFinite(cpu) ? `${cpu.toFixed(0)}%` : "…", cpu),
      stat("Load (1/5/15)", (l.load || []).map((x) => x.toFixed(2)).join(" / ")),
      stat("Memory", l.memTotalKb ? `${formatBytes((l.memTotalKb - l.memAvailableKb) * 1024)} / ${formatBytes(l.memTotalKb * 1024)}` : "?", memPct),
      ...(l.temperatures || []).map((t, i) => stat(`Temperature ${i + 1}`, `${t.toFixed(1)} °C`)),
      ...disks.map((d) => stat(`Disk ${d.mount ?? d.filesystem ?? ""}`, `${d.use ?? d.percent ?? "?"}`)),
    );
  }
  poll();
  const timer = setInterval(poll, 2000);
  win.onClose(() => {
    clearInterval(timer);
    cpuChart.dispose();
    memChart.dispose();
  });
}

export async function openIdentityClock() {
  let cfg = {};
  let ntp = {};
  try {
    [cfg, ntp] = await Promise.all([api.getConfig(["system"]), api.getConfig(["service", "ntp"])]);
  } catch (e) {
    return alertBox("Identity & Clock", errorText(e));
  }
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const before = {
    host: cfg["host-name"] || "",
    domain: cfg["domain-name"] || "",
    tz: cfg["time-zone"] || "UTC",
    ntp: tagKeys(ntp?.server),
  };
  await formDialog("Identity & Clock", [
    { name: "host", label: "Router name", value: before.host },
    { name: "domain", label: "Domain", value: before.domain, placeholder: "optional, e.g. home.lan" },
    { name: "tz", label: "Time zone", type: "select", options: [...new Set(["UTC", before.tz, ...zones])], value: before.tz },
    { name: "ntp", label: "NTP servers", value: before.ntp.join(" "), hint: "Space-separated, e.g. pool.ntp.org time.cloudflare.com" },
  ], async (v) => {
    const host = v.host.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(host)) throw new Error("Router name: letters, digits and hyphens");
    if (v.domain.trim() && !/^[A-Za-z0-9.-]{1,253}$/.test(v.domain.trim())) throw new Error("Bad domain name");
    const servers = v.ntp.split(/[\s,]+/).filter(Boolean);
    for (const s of servers) if (!/^[A-Za-z0-9.:-]{1,253}$/.test(s)) throw new Error(`Bad NTP server ${s}`);
    const cmds = [
      ...diffSingle(["system"], "host-name", before.host, host),
      ...diffSingle(["system"], "domain-name", before.domain, v.domain),
      ...diffSingle(["system"], "time-zone", before.tz, v.tz),
    ];
    for (const s of before.ntp) if (!servers.includes(s)) cmds.push({ op: "delete", path: ["service", "ntp", "server", s] });
    for (const s of servers) if (!before.ntp.includes(s)) cmds.push({ op: "set", path: ["service", "ntp", "server", s] });
    if (!cmds.length) return true;
    await applyChanges(cmds, "identity & clock");
    return true;
  }, { okLabel: "Apply" });
}

export async function powerAction(action) {
  const name = session.info?.hostname || "the router";
  const text = action === "reboot"
    ? `Reboot ${name} now? It will be unreachable for a minute or two.`
    : `Shut down ${name} now? You will need physical access (or out-of-band power control) to turn it back on.`;
  if (!(await confirmBox(action === "reboot" ? "Reboot" : "Shut down", text, action === "reboot" ? "Reboot" : "Shut down"))) return;
  if (session.unsaved && !session.confirmDeadline) {
    if (!(await confirmBox("Unsaved changes", "The running config has changes that are not saved. A reboot loads the saved config, so they will be lost. Continue without saving?", "Continue"))) return;
  }
  if (session.confirmDeadline) {
    if (!(await confirmBox("Unconfirmed changes", "There are Safe Mode changes waiting for Confirm. A reboot loads the SAVED config, so they will be lost. Continue?", "Continue"))) return;
  }
  try {
    setStatus(await api.power(action));
  } catch (e) {
    return alertBox("Failed", errorText(e));
  }
  showView("windows");
  closeAllWindows();
  await api.disconnect().catch(() => {});
  setConnected(null);
  setStatus(action === "reboot" ? "Router is rebooting. Connect again in a minute." : "Router is shutting down.");
}

export function openImages() {
  const win = openWindow({ key: "images", title: "System Images", width: 640, height: 320 });
  if (!win.isNew) return;
  const table = makeTable(
    [
      { key: "name", label: "Image", width: "300px" },
      { key: "def", label: "Boots by default", width: "120px" },
      { key: "run", label: "Running" },
    ],
    { rowKey: (r) => r.name },
  );
  const sel = (fn) => () => {
    const r = table.selected();
    if (!r) return setStatus("Select an image first.", true);
    fn(r);
  };
  win.body.append(
    h(
      "div.win-toolbar",
      h("button.icon-add", { title: "Download and install a new VyOS version", on: { click: addImage } }, "+ Install…"),
      h("button", { on: { click: sel(setDefault) } }, "Set as default"),
      h("button.icon-remove", { on: { click: sel(deleteImage) } }, "− Delete"),
      h("button", { on: { click: load } }, "⟳"),
      h("span.grow"),
      h("span.hint", "Like Winbox Packages: VyOS upgrades by installing a new image, then rebooting into it."),
    ),
    table.wrap,
    table.count,
  );

  async function load() {
    try {
      const list = await api.imageList();
      table.setRows(list.map((i) => ({ ...i, def: i.defaultBoot ? "yes" : "", run: i.running ? "yes" : "" })));
      if (!list.length) table.count.textContent = "No installed images (a live/ISO system, or a container).";
    } catch (e) {
      setStatus(errorText(e), true);
    }
  }

  async function addImage() {
    await formDialog("Install VyOS image", [
      { name: "url", label: "Image URL", placeholder: "https://…/vyos-…-generic-amd64.iso", hint: "Get the link from vyos.net (rolling: github.com/vyos/vyos-nightly-build/releases). The download runs on the router and can take several minutes." },
    ], async (v) => {
      setStatus("Downloading and installing image on the router… this can take several minutes.");
      const msg = await api.imageAdd(v.url);
      setStatus("Image installed. Set it as default and reboot to use it.");
      alertBox("Image installed", msg || "Done.");
      load();
      return true;
    }, { okLabel: "Install" });
  }

  async function setDefault(r) {
    try {
      setStatus(await api.imageSetDefault(r.name) || `${r.name} will boot next time.`);
      load();
    } catch (e) {
      alertBox("Failed", errorText(e));
    }
  }

  async function deleteImage(r) {
    if (r.running) return alertBox("Delete image", "You can't delete the image the router is running.");
    if (!(await confirmBox("Delete image", `Delete ${r.name}?`, "Delete"))) return;
    try {
      setStatus(await api.imageDelete(r.name) || `${r.name} deleted.`);
      load();
    } catch (e) {
      alertBox("Failed", errorText(e));
    }
  }

  load();
}
