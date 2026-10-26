// Settings > Security, "Intrusion detection": Suricata on the router, its
// recent alerts, and blocking attackers (by hand, or automatically for 24 h
// through the 24/7 server).
import { api, errorText } from "../lib/api.js";
import { h, clear, toast } from "../lib/dom.js";
import { formDialog, confirmBox, alertBox, modal } from "../lib/dialog.js";
import { applyChanges } from "../lib/session.js";
import { isDesktop } from "../lib/platform.js";
import { makeTable } from "../lib/table.js";
import { readNetworks } from "../lib/netplan.js";
import { readIds, idsCommands, blockCommands, unblockCommands, blockSetupCommands, severityText } from "../lib/ids.js";

const PRIVATE = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: "short", timeStyle: "medium" });

/** The section's content (it loads itself). st: { cfg, wan }, reload re-renders Settings. */
export function idsSection(st, reload) {
  const ids = readIds(st.cfg);
  const body = h("div", h("div.hint", "Checking…"));
  const nets = readNetworks(st.cfg, st.wan);
  const choices = [...(st.wan ? [{ iface: st.wan, label: `Internet (${st.wan})` }] : []), ...nets.map((n) => ({ iface: n.iface, label: `${n.name} (${n.iface})` }))];

  if (ids.manual) {
    clear(body).append(h("div.hint", "A container named vygi-ids exists with another image; VyGi leaves it alone."));
    return body;
  }
  if (!ids.on) {
    clear(body).append(row("Off", "Watches traffic for known attacks, scans and infected devices with Suricata (free, open source; the engine behind most home-router intrusion detection) running on the router, and alerts you. Needs about 1 GB of free memory and disk on the router, and internet access for its rules.",
      h("button.primary", { on: { click: turnOn } }, "Turn on…")));
    return body;
  }
  load();
  return body;

  function row(title, hint, ctl) {
    return h("div.set-row", h("div.set-text", h("div.set-title", title), hint ? h("div.hint", hint) : null), ctl ? h("div.set-ctl", ctl) : null);
  }

  async function load() {
    let status;
    let alerts = [];
    try {
      [status, alerts] = await Promise.all([api.idsStatus(), api.idsAlerts(300).catch(() => [])]);
    } catch (e) {
      clear(body).append(h("div.err-box", errorText(e)));
      return;
    }
    const state = status.running
      ? `Running on ${ids.ifaces.join(", ")} · ${status.rules ? `${status.rules.toLocaleString()} rules, updated ${new Date(status.rulesAt).toLocaleDateString()}` : "no rules yet: press Update rules"}`
      : !status.image ? "The Suricata image isn't on the router (yet)." : `Not running${status.status ? ` (${status.status})` : ""}.`;
    const serious = alerts.filter((a) => a.priority <= 2);
    clear(body).append(
      row(status.running ? "On" : "Problem", state, h("span.set-inline",
        h("button", { on: { click: updateRules } }, "Update rules"),
        h("button", { on: { click: choosePorts } }, "Ports…"),
        h("button", { on: { click: turnOff } }, "Turn off"))),
      isDesktop ? "" : autoBlockRow(), // append() would print null
      blockedRow() || "",
      h("div.section-title", `Recent alerts${alerts.length ? ` (${serious.length} serious or suspicious of ${alerts.length})` : ""}`),
      alerts.length ? alertTable(alerts) : h("div.hint", status.running ? "No alerts yet." : ""));
  }

  function alertTable(alerts) {
    const t = makeTable([
      { key: "t", label: "Time", width: "140px", render: (a) => when(a.t) },
      { key: "priority", label: "Level", width: "92px", render: (a) => h(`span.pill.${a.priority === 1 ? "bad" : a.priority === 2 ? "warn" : "muted"}`, severityText(a.priority)) },
      { key: "msg", label: "What", render: (a) => h("span", { title: `${a.class} · rule ${a.sid}` }, a.msg) },
      { key: "src", label: "From", width: "130px" },
      { key: "dst", label: "To", width: "150px", render: (a) => `${a.dst}${a.dport ? `:${a.dport}` : ""}` },
      { key: "block", label: "", width: "80px", sort: false, render: (a) => (PRIVATE.test(a.src) || a.src.includes(":") || ids.blocked.includes(a.src) ? "" : h("button", { on: { click: () => block(a.src) } }, "Block")) },
    ], { rowKey: (a, i) => `${a.t}-${a.sid}-${i}` });
    t.setRows(alerts);
    t.wrap.classList.add("ids-alerts");
    return h("div", t.wrap, t.count);
  }

  function autoBlockRow() {
    const sw = h("input", { type: "checkbox", disabled: true });
    const el = row("Block attackers automatically", "When a serious attack comes from an internet address, the VyGi server blocks that address for 24 hours (needs 24/7 watching). Local devices are never blocked.", h("label.switch", sw));
    api.watchGet().then((wg) => {
      const r = wg.router || {};
      sw.checked = !!r.kinds?.["ids-block"];
      sw.disabled = !r.enabled;
      if (!r.enabled) el.querySelector(".hint").append(" Turn on 24/7 watching (System tab) first.");
      sw.addEventListener("change", async () => {
        try {
          if (sw.checked) {
            const setup = blockSetupCommands(st.cfg);
            if (setup.length) await applyChanges(setup, "intrusion detection: block rules");
          }
          await api.watchSet({ ...r, kinds: { ...(r.kinds || {}), "ids-block": sw.checked } });
        } catch (e) {
          sw.checked = !sw.checked;
          if (!/^Cancelled/.test(e?.message || "")) alertBox("Intrusion detection", errorText(e));
        }
      });
    }).catch(() => el.remove());
    return el;
  }

  function blockedRow() {
    if (!ids.blocked.length) return null;
    return row("Blocked addresses", ids.blocked.join(", "), h("button", { on: { click: async () => {
      const r = await modal("Blocked addresses", h("div", { style: { width: "420px" } },
        h("div.hint", "Internet addresses blocked after an attack. Automatic blocks end by themselves after 24 hours."),
        h("div.policy-list", ids.blocked.map((ip) => h("div.policy-row", h("span.grow", ip), h("button", { on: { click: async () => {
          try {
            await applyChanges(unblockCommands(ip), `unblock ${ip}`);
            reload();
          } catch (e) {
            if (!/^Cancelled/.test(e?.message || "")) alertBox("Unblock", errorText(e));
          }
        } } }, "Unblock"))))), [{ label: "Close", value: "ok", primary: true }]);
      return r;
    } } }, "Manage…"));
  }

  async function block(ip) {
    if (!(await confirmBox("Block address", `Block ${ip}? Nothing from that address reaches the router or your network until you unblock it.`, "Block"))) return;
    try {
      await applyChanges(blockCommands(st.cfg, ip), `block ${ip} (intrusion detection)`);
      reload();
    } catch (e) {
      if (!/^Cancelled/.test(e?.message || "")) alertBox("Block", errorText(e));
    }
  }

  async function pick(title, current) {
    let picked = null;
    await formDialog(title, [
      { name: "ifaces", label: "Watch", type: "multicheck", value: choices.filter((c) => current.includes(c.iface)).map((c) => c.label), options: choices.map((c) => c.label), hint: "The internet port catches attacks from outside; your networks catch infected devices calling out. Each port costs some CPU." },
    ], (v) => {
      picked = choices.filter((c) => v.ifaces.includes(c.label)).map((c) => c.iface);
      if (!picked.length) throw new Error("Choose at least one");
      return true;
    }, { okLabel: "Apply" });
    return picked;
  }

  async function turnOn() {
    const ifaces = await pick("Turn on intrusion detection", choices.map((c) => c.iface));
    if (!ifaces) return;
    const t = toast("Downloading Suricata to the router (a few hundred MB; can take several minutes)…", { timeout: 15 * 60_000 });
    try {
      await api.idsPrepare();
      t?.remove();
      await applyChanges(idsCommands(st.cfg, ifaces), "intrusion detection on");
      toast("Downloading the rules (Emerging Threats Open)…", { timeout: 5 * 60_000 });
      await api.idsUpdateRules().catch((e) => alertBox("Intrusion detection", `Suricata is running, but the rules couldn't be downloaded yet: ${errorText(e)}. Press Update rules later.`));
      toast("Intrusion detection is on.");
    } catch (e) {
      t?.remove();
      if (!/^Cancelled/.test(e?.message || "")) alertBox("Intrusion detection", errorText(e));
    }
    reload();
  }

  async function choosePorts() {
    const ifaces = await pick("Intrusion detection: ports", ids.ifaces);
    if (!ifaces) return;
    try {
      const cmds = idsCommands(st.cfg, ifaces);
      if (cmds.length) await applyChanges(cmds, "intrusion detection ports");
    } catch (e) {
      if (!/^Cancelled/.test(e?.message || "")) alertBox("Intrusion detection", errorText(e));
    }
    reload();
  }

  async function updateRules() {
    toast("Downloading the newest rules…", { timeout: 5 * 60_000 });
    try {
      await api.idsUpdateRules();
      toast("Rules updated; Suricata restarted with them.");
    } catch (e) {
      alertBox("Intrusion detection", errorText(e));
    }
    load();
  }

  async function turnOff() {
    if (!(await confirmBox("Turn off intrusion detection?", "Suricata stops and its container is removed. Its logs and rules stay on the router (/config/vygi-ids) in case you turn it on again.", "Turn off"))) return;
    try {
      await applyChanges(idsCommands(st.cfg, []), "intrusion detection off");
    } catch (e) {
      if (!/^Cancelled/.test(e?.message || "")) alertBox("Intrusion detection", errorText(e));
    }
    reload();
  }
}
