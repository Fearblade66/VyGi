// Traffic Rules page: block the internet or sites for devices/networks, always
// or on a schedule (e.g. kids' bedtime), with an on/off switch per rule.
import { api, errorText } from "../lib/api.js";
import { h, clear, every } from "../lib/dom.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges, isConnected, onSessionChange } from "../lib/session.js";
import { registerView, welcome, loadingPage } from "../lib/views.js";
import { icon } from "../lib/icons.js";
import { collectClients } from "../lib/netdata.js";
import { readNetworks } from "../lib/netplan.js";
import { DAYS, parseRules, ruleCommands, deleteRuleCommands, toggleCommands, describeSchedule, activeNow, routerClock } from "../lib/trafficrules.js";

const MAC_IN = /([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s*$/i;
const CIDR_IN = /(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})\s*$/;

// The device list is slow to build (several router calls); reuse it for a minute.
let clientCache = { at: 0, clients: null };
async function deviceList() {
  if (clientCache.clients && Date.now() - clientCache.at < 60_000) return clientCache.clients;
  const { clients } = await collectClients().catch(() => ({ clients: [] }));
  clientCache = { at: Date.now(), clients };
  return clients;
}
onSessionChange((s) => {
  if (!s.info) clientCache = { at: 0, clients: null };
});

async function loadState() {
  const [cfg, routes, clients, time] = await Promise.all([
    api.getConfig([]),
    api.routes(4, "default").catch(() => []),
    deviceList(),
    api.routerTime().then((t) => ({ ...t, readAt: Date.now() })).catch(() => null),
  ]);
  const clientData = { clients };
  const def = routes.find((r) => r.dst === "default");
  const wan = def?.dev || (def?.nexthops || [])[0]?.dev || "";
  return { cfg: cfg || {}, wan, time, clients: clientData.clients.filter((c) => c.mac && c.kind !== "vpn") };
}

export function initRules() {
  const root = document.getElementById("rules");
  let st = null;
  let timer = null;

  const deviceLabel = (mac) => st.clients.find((c) => c.mac === mac)?.label || mac;

  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    if (!isConnected()) {
      clear(root).append(welcome(() => document.getElementById("btn-connect").click()));
      return;
    }
    if (!root.querySelector(".page")) clear(root).append(loadingPage(2));
    let next;
    try {
      next = await loadState();
    } catch (e) {
      if (seq !== renderSeq) return;
      clear(root).append(h("div.page", h("div.err-box", errorText(e))));
      return;
    }
    if (seq !== renderSeq) return; // a newer refresh is on its way
    st = next;
    const rules = parseRules(st.cfg);
    const head = h("div.page-head",
      h("div.hint", "Block the internet or sites for some devices, always or on a schedule. Times follow the router's clock", st.time ? (() => { const c = clock(); return ` (now ${DAYS[c.getDay()]} ${String(c.getHours()).padStart(2, "0")}:${String(c.getMinutes()).padStart(2, "0")} there).`; })() : "."),
      h("span.grow"),
      h("button.primary", { on: { click: () => edit(null) } }, icon("plus", 16), "New rule"));
    const grid = h("div.rule-grid", rules.map(card));
    if (!rules.length) {
      grid.append(h("div.empty-state",
        h("span.net-icon", icon("clock", 20)),
        h("div", h("b", "No rules yet"), h("div.hint", "Example: no internet for the kids' tablet on school nights, 22:00–07:00.")),
        h("button", { on: { click: () => edit(null, { name: "Bedtime", schedule: "times", start: "22:00", stop: "07:00", days: [0, 1, 2, 3, 4] }) } }, "Create a bedtime rule")));
    }
    clear(root).append(h("div.page", head, grid));
  }

  function card(r) {
    const who = r.targets.kind === "devices" ? r.targets.macs.map(deviceLabel).join(", ") : r.targets.kind === "networks" ? r.targets.networks.join(", ") : "everyone";
    const what = r.block === "sites" ? `Blocks ${r.domains.filter((d) => !d.startsWith("www.")).join(", ")}` : "Blocks the internet";
    const sw = h("input", { type: "checkbox", checked: r.enabled, title: r.enabled ? "Rule on: click to pause" : "Paused: click to turn on" });
    sw.addEventListener("click", (e) => e.stopPropagation());
    sw.addEventListener("change", async () => {
      const on = sw.checked;
      // show the new state right away; the refresh after the commit confirms it
      el.classList.toggle("off", !on);
      status.replaceWith((status = statusBadge({ ...r, enabled: on })));
      try {
        await applyChanges(toggleCommands(r, on), `${on ? "enable" : "pause"} rule ${r.name}`);
      } catch (e) {
        alertBox("Failed", errorText(e));
      }
      render();
    });
    let status = statusBadge(r);
    const el = h(`div.rule-card${r.enabled ? "" : ".off"}`, { on: { click: () => edit(r) }, title: "Click to edit" },
      h("div.rule-top",
        h("span.rule-icon", icon(r.schedule.kind === "times" ? "clock" : "ban", 18)),
        h("div.grow", h("div.rule-name", r.name), h("div.hint", what)),
        h("label.switch", { on: { click: (e) => e.stopPropagation() } }, sw)),
      h("div.badges", status, h("span.badge.info", icon("clock", 12), describeSchedule(r.schedule))),
      h("dl.kv-list", h("dt", "Applies to"), h("dd", { title: who }, who)));
    return el;
  }

  // Schedules run on the router's clock and time zone, which may differ from this computer's.
  const clock = () => (st?.time ? routerClock(st.time, st.time.readAt) : new Date());

  function statusBadge(r) {
    if (!r.enabled) return h("span.badge", "Paused");
    return activeNow(r, clock()) ? h("span.badge.bad", "Blocking now") : h("span.badge.ok", "Not blocking now");
  }

  async function edit(r, preset = {}) {
    try {
      st = await loadState();
    } catch (e) {
      return alertBox("Traffic Rules", errorText(e));
    }
    if (r) r = parseRules(st.cfg).find((x) => x.id === r.id) || r;
    const nets = readNetworks(st.cfg, st.wan);
    const deviceOpts = st.clients.map((c) => `${c.label} — ${c.mac}`);
    // keep devices that are offline/unknown but already in the rule
    for (const m of r?.targets.macs || []) if (!st.clients.some((c) => c.mac === m)) deviceOpts.push(`(not seen now) — ${m}`);
    const netOpts = nets.map((n) => `${n.name} — ${n.network}`);
    const sched = r?.schedule || {};
    await formDialog(r ? `Rule: ${r.name}` : "New traffic rule", [
      { name: "name", label: "Name", value: r?.name || preset.name || "", placeholder: "e.g. Kids bedtime, No TikTok" },
      { name: "block", label: "Block", type: "select", value: r?.block || "internet", options: [{ value: "internet", label: "all internet" }, { value: "sites", label: "specific sites" }] },
      { name: "domains", label: "Sites", type: "textarea", rows: 3, value: (r?.domains || []).filter((d) => !d.startsWith("www.")).join("\n"), hint: "One per line, e.g. tiktok.com. The router blocks the addresses these names point to, so big services that share servers (YouTube with Google) can't be split, and apps may use other names. Works for IPv4 only. For reliable site blocking, use Technitium." },
      { name: "targets", label: "For", type: "select", value: r?.targets.kind || "devices", options: [{ value: "devices", label: "these devices" }, { value: "networks", label: "these networks" }, { value: "all", label: "everyone" }] },
      { name: "devices", label: "Devices", type: "multicheck", value: deviceOpts.filter((o) => r?.targets.macs.includes(o.match(MAC_IN)?.[1]?.toLowerCase())), options: deviceOpts },
      { name: "networks", label: "Networks", type: "multicheck", value: netOpts.filter((o) => r?.targets.networks.includes(o.match(CIDR_IN)?.[1])), options: netOpts },
      { name: "schedule", label: "When", type: "select", value: sched.kind || preset.schedule || "always", options: [{ value: "always", label: "always" }, { value: "times", label: "on a schedule" }] },
      { name: "days", label: "Days", type: "multicheck", value: (sched.days || preset.days || [0, 1, 2, 3, 4, 5, 6]).map((d) => DAYS[d]), options: DAYS },
      { name: "start", label: "From", value: sched.start || preset.start || "22:00", placeholder: "HH:MM" },
      { name: "stop", label: "Until", value: sched.stop || preset.stop || "07:00", placeholder: "HH:MM", hint: "An end time before the start runs overnight (22:00 → 07:00)." },
      { name: "enabled", label: "Rule on", type: "checkbox", value: r ? r.enabled : true },
    ], async (v) => {
      const cidrs = v.networks.map((o) => o.match(CIDR_IN)?.[1]).filter(Boolean);
      const spec = {
        ...v,
        macs: v.devices.map((o) => o.match(MAC_IN)?.[1]).filter(Boolean),
        networks: cidrs,
        networkIfaces: nets.filter((n) => cidrs.includes(n.network)).map((n) => n.iface),
        days: v.days.map((d) => DAYS.indexOf(d)),
      };
      await applyChanges(ruleCommands(st.cfg, spec, r), r ? `rule ${v.name}` : `new rule ${v.name}`);
      render();
      return true;
    }, {
      okLabel: r ? "Apply" : "Create",
      initChange: true,
      extra: r ? { label: "Delete rule", onClick: () => remove(r) } : null,
      onChange(_f, v, set) {
        set.show("domains", v.block === "sites");
        set.show("devices", v.targets === "devices");
        set.show("networks", v.targets === "networks");
        set.show("days", v.schedule === "times");
        set.show("start", v.schedule === "times");
        set.show("stop", v.schedule === "times");
        set.hint("devices", deviceOpts.length ? "Matched by MAC address, so it keeps working if the IP changes. Phones with private (random) MAC addresses may change it per network." : "No devices seen yet.");
      },
    });
  }

  async function remove(r) {
    if (!(await confirmBox("Delete rule", `Delete "${r.name}"?`, "Delete"))) return;
    try {
      await applyChanges(deleteRuleCommands(st.cfg, r), `delete rule ${r.name}`);
      render();
    } catch (e) {
      alertBox("Failed", errorText(e));
    }
  }

  onSessionChange(() => {
    if (!root.hidden) render();
  });
  registerView("rules", {
    show: () => {
      render();
      timer = every(() => !document.querySelector(".dialog") && render(), 60000);
    },
    hide: () => clearInterval(timer),
  });
}
