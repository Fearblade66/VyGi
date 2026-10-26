// Networks page, "Who can reach whom": a grid of which networks may start
// connections to which (from isolation), and the policies that make
// exceptions (UniFi's policy table).
import { errorText } from "../lib/api.js";
import { h } from "../lib/dom.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges } from "../lib/session.js";
import { icon } from "../lib/icons.js";
import { readGroups } from "../lib/devgroups.js";
import { readPolicies, policyCommands, checkPolicy, nextPolicyId, reach, describePorts } from "../lib/policies.js";
import { deviceList } from "./groups.js";
import { readMdns, mdnsCommands } from "../lib/mdns.js";

const PROTOCOLS = [
  { value: "any", label: "Everything" },
  { value: "tcp", label: "TCP" },
  { value: "udp", label: "UDP" },
  { value: "tcp_udp", label: "TCP and UDP" },
  { value: "icmp", label: "Ping (ICMP)" },
];

/** The section element. st: { cfg }, nets: readNetworks(), onChange re-renders the page. */
export function policySection(st, nets, onChange) {
  const policies = readPolicies(st.cfg);
  const groups = readGroups(st.cfg);
  const netName = (iface) => nets.find((n) => n.iface === iface)?.name || iface;
  const groupName = (g) => groups.find((x) => x.gname === g)?.name || g;
  // device names from the router's fixed IPs (DHCP static mappings)
  const fixed = new Map();
  for (const sn of Object.values(st.cfg?.service?.["dhcp-server"]?.["shared-network-name"] || {})) {
    for (const sub of Object.values(sn?.subnet || {})) {
      for (const [name, m] of Object.entries(sub?.["static-mapping"] || {})) {
        if (m?.["ip-address"]) fixed.set(m["ip-address"], name);
        if (m?.mac) fixed.set(String(m.mac).toLowerCase(), name);
      }
    }
  }
  const label = (end, devs = []) => ({
    net: () => netName(end.value),
    group: () => `group ${groupName(end.value)}`,
    device: () => devs.find((d) => d.mac === end.value || d.ip === end.value)?.label || fixed.get(end.value) || end.value,
    any: () => "anything",
  }[end.kind]());

  // ---- the grid
  const cell = (a, b) => {
    if (a === b) return h("td.reach.self", "–");
    const r = reach(a, b, policies);
    const ex = r.exceptions.filter((p) => (p.action === "allow") !== r.allowed);
    return h(`td.reach.${r.allowed ? "ok" : "no"}`, { title: ex.map((p) => `${p.action === "allow" ? "Allowed" : "Blocked"}: ${p.name} (${describePorts(p)})`).join("\n") },
      r.allowed ? "allowed" : "blocked", ex.length ? h("span.reach-ex", ` +${ex.length} exception${ex.length > 1 ? "s" : ""}`) : null);
  };
  const grid = nets.length
    ? h("div.reach-wrap", h("table.reach-grid",
        h("thead", h("tr", h("th", "From ↓  To →"), ...nets.map((n) => h("th", n.name)), h("th", "Internet"))),
        h("tbody", nets.map((a) => h("tr", h("th", a.name), ...nets.map((b) => cell(a, b)),
          h(`td.reach.${a.internet ? "ok" : "no"}`, a.internet ? "allowed" : "blocked"))))))
    : null;

  // ---- the list
  const list = policies.length
    ? h("div.policy-list", policies.map((p, i) => h(`div.policy-row${p.disabled ? ".off" : ""}`,
        h(`span.pill.${p.action === "allow" ? "ok" : "bad"}`, p.action === "allow" ? "allow" : "block"),
        h("div.grow",
          h("div.policy-name", p.name, p.disabled ? h("span.hint", " (off)") : null),
          h("div.hint", `${label(p.from)} → ${label(p.to)} · ${describePorts(p)}`)),
        h("button.icon-btn", { title: "Earlier (checked first)", disabled: i === 0, on: { click: () => save(move(policies, i, -1), "reorder network policies") } }, "▲"),
        h("button.icon-btn", { title: "Later", disabled: i === policies.length - 1, on: { click: () => save(move(policies, i, 1), "reorder network policies") } }, "▼"),
        h("button", { on: { click: () => edit(p) } }, "Edit"))))
    : h("div.hint", "No policies yet. Examples: let the IoT network reach the NAS for backups (TCP 445), or stop the Kids group from reaching the office network.");

  return h("section.card.policy-section",
    h("div.vpn-head",
      h("span.net-icon", icon("shield", 18)),
      h("div.grow",
        h("div.net-name", "Who can reach whom"),
        h("div.hint", "Which networks may start connections to which. Isolated networks are blocked from the others; policies make exceptions (allow) or extra blocks. Replies to allowed connections always get through.")),
      h("button", { on: { click: () => edit(null) } }, icon("plus", 14), "New policy")),
    grid, list);

  async function save(list2, what) {
    try {
      const cmds = policyCommands(st.cfg, list2);
      if (cmds.length) await applyChanges(cmds, what);
      onChange();
      return true;
    } catch (e) {
      if (!/^Cancelled/.test(e?.message || "")) alertBox("Network policies", errorText(e));
      return false;
    }
  }

  async function edit(p) {
    const devs = await deviceList();
    const ends = (to) => [
      ...nets.map((n) => ({ value: `net:${n.iface}`, label: `Network: ${n.name} (${n.cidr})` })),
      ...(to ? [] : groups.map((g) => ({ value: `group:${g.gname}`, label: `Group: ${g.name}` }))),
      ...devs.filter((d) => d.kind !== "vpn" && (to ? d.fixedIp && d.ip && !d.ip.includes(":") : d.mac))
        .map((d) => ({ value: `device:${to ? d.ip : d.mac}`, label: `Device: ${d.label} (${to ? d.ip : d.mac})` })),
    ];
    const enc = (e) => (e ? `${e.kind}:${e.value}` : "");
    const dec = (s) => ({ kind: s.split(":")[0], value: s.slice(s.indexOf(":") + 1) });
    let result = null;
    let removed = false;
    await formDialog(p ? `Policy: ${p.name}` : "New network policy", [
      { name: "name", label: "Name", value: p?.name || "", placeholder: "e.g. IoT to NAS backups" },
      { name: "action", label: "Action", type: "select", value: p?.action || "allow", options: [
        { value: "allow", label: "Allow (an exception to isolation)" },
        { value: "block", label: "Block" },
      ] },
      { name: "from", label: "From", type: "select", value: enc(p?.from), options: ends(false) },
      { name: "to", label: "To", type: "select", value: enc(p?.to), options: ends(true), hint: "Devices need a fixed IP to be a destination (Clients → Fix IP)." },
      { name: "protocol", label: "What", type: "select", value: p?.protocol || "any", options: PROTOCOLS },
      { name: "ports", label: "Ports", value: p?.ports || "", placeholder: "e.g. 445, or 80,443, or 8000-8100; empty = all", hint: "The destination port (the service on the other side)." },
      { name: "on", label: "Turned on", type: "checkbox", value: !p?.disabled },
    ], async (v) => {
      const next = checkPolicy({ id: p?.id || nextPolicyId(policies), name: v.name, action: v.action, from: dec(v.from), to: dec(v.to), protocol: v.protocol, ports: v.ports, disabled: !v.on });
      result = p ? policies.map((x) => (x.id === p.id ? next : x)) : [...policies, next];
      return true;
    }, {
      okLabel: p ? "Apply" : "Create",
      intro: "Policies are checked first, top to bottom; the first one that matches decides.",
      initChange: true,
      onChange(_f, v, set) {
        set.show("ports", ["tcp", "udp", "tcp_udp"].includes(v.protocol));
      },
      extra: p ? { label: "Delete policy", onClick: async () => {
        if (!(await confirmBox("Delete policy", `Delete "${p.name}"?`, "Delete"))) return false;
        removed = await save(policies.filter((x) => x.id !== p.id), `delete network policy ${p.name}`);
        return removed;
      } } : null,
    });
    if (result && !removed) await save(result, p ? `network policy ${result.find((x) => x.id === p.id)?.name}` : `new network policy ${result.at(-1).name}`);
  }
}

function move(list, i, d) {
  const out = [...list];
  [out[i], out[i + d]] = [out[i + d], out[i]];
  return out;
}

/** Device discovery across networks (mDNS repeater). */
export function mdnsSection(st, nets, onChange) {
  const m = readMdns(st.cfg);
  const name = (i) => nets.find((n) => n.iface === i)?.name || i;
  const opt = (n) => `${n.name} (${n.iface})`;
  async function choose() {
    let cmds = null;
    await formDialog("Device discovery across networks", [
      { name: "nets", label: "Networks", type: "multicheck", value: nets.filter((n) => m.ifaces.includes(n.iface)).map(opt), options: nets.map(opt), hint: "Choose two or more, or none to turn it off." },
    ], (v) => {
      cmds = mdnsCommands(st.cfg, nets.filter((n) => v.nets.includes(opt(n))).map((n) => n.iface));
      return true;
    }, { okLabel: "Apply", intro: "Phones and computers find Chromecasts, AirPlay speakers, printers and smart-home hubs by mDNS, which normally stays inside one network. The router repeats it between the networks you choose. An isolated network also gets an exception so its devices can announce themselves to the router." });
    if (!cmds) return;
    try {
      if (cmds.length) await applyChanges(cmds, "device discovery across networks");
    } catch (e) {
      if (!/^Cancelled/.test(e?.message || "")) alertBox("Device discovery", errorText(e));
    }
    onChange();
  }
  const isolated = nets.filter((n) => m.ifaces.includes(n.iface) && n.isolated);
  return h("section.card.policy-section",
    h("div.vpn-head",
      h("span.net-icon", icon("wifi", 18)),
      h("div.grow",
        h("div.net-name", "Device discovery across networks (mDNS)"),
        h("div.hint", m.on ? `On between ${m.ifaces.map(name).join(", ")}.` : "Off: Chromecast, AirPlay and printers are only found from their own network.",
          isolated.length ? ` To cast or print from another network to ${isolated.map((n) => n.name).join(", ")} (isolated), also add a policy above that allows it.` : "")),
      m.manual ? h("span.badge", { title: "Set up with options VyGi doesn't manage: change it in Advanced → Services (config)." }, "set up by hand")
        : h("button", { on: { click: choose } }, m.on ? "Change…" : "Turn on…")));
}

