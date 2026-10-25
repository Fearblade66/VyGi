// Firewall > Address Lists (VyOS firewall groups) and Firewall > Connections (conntrack).
import { api, errorText } from "../lib/api.js";
import { h, setStatus, formatBytes, every } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { makeTable, filterBox } from "../lib/table.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges } from "../lib/session.js";
import { toArray, diffMulti } from "../lib/vyos.js";

const GROUP_TYPES = {
  "address-group": { label: "IPv4 addresses", leaf: "address", re: /^\d+\.\d+\.\d+\.\d+(-\d+\.\d+\.\d+\.\d+)?$/, hint: "192.0.2.5 or 192.0.2.10-192.0.2.20" },
  "network-group": { label: "IPv4 networks", leaf: "network", re: /^\d+\.\d+\.\d+\.\d+\/\d{1,2}$/, hint: "192.0.2.0/24" },
  "ipv6-address-group": { label: "IPv6 addresses", leaf: "address", re: /^[0-9a-fA-F:]+(-[0-9a-fA-F:]+)?$/, hint: "2001:db8::5" },
  "ipv6-network-group": { label: "IPv6 networks", leaf: "network", re: /^[0-9a-fA-F:]+\/\d{1,3}$/, hint: "2001:db8::/48" },
  "port-group": { label: "Ports", leaf: "port", re: /^(\d{1,5}(-\d{1,5})?|[a-z][a-z0-9-]*)$/, hint: "22, 8000-8080 or a name like http" },
  "mac-group": { label: "MAC addresses", leaf: "mac-address", re: /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/, hint: "aa:bb:cc:dd:ee:ff" },
};
const ROOT = ["firewall", "group"];

export function openAddressLists() {
  const win = openWindow({ key: "address-lists", title: "Firewall Address Lists", width: 760, height: 380 });
  if (!win.isNew) return;
  let groups = {};
  const table = makeTable(
    [
      { key: "name", label: "List", width: "150px" },
      { key: "typeLabel", label: "Type", width: "120px" },
      { key: "count", label: "Entries", width: "60px", className: "num" },
      { key: "entriesText", label: "Members" },
    ],
    { rowKey: (r) => `${r.type}|${r.name}`, onOpen: (r) => editGroup(r) },
  );
  win.body.append(
    h("div.win-toolbar",
      h("button.icon-add", { title: "New list", on: { click: () => editGroup(null) } }, "+"),
      h("button.icon-remove", { title: "Delete list", on: { click: removeGroup } }, "−"),
      h("button", { on: { click: () => { const r = table.selected(); r ? editGroup(r) : setStatus("Select a list first.", true); } } }, "Edit"),
      h("button", { on: { click: load } }, "⟳"),
      h("span.hint", "Use lists in firewall rules (Src./Dst. Address Group) to match many addresses at once."),
      h("span.grow"), filterBox(table)),
    table.wrap, table.count,
  );

  async function load() {
    try {
      groups = (await api.getConfig(ROOT)) || {};
    } catch (e) {
      return setStatus(errorText(e), true);
    }
    const rows = [];
    for (const [type, t] of Object.entries(GROUP_TYPES)) {
      for (const [name, g] of Object.entries(groups[type] || {})) {
        const entries = toArray(g?.[t.leaf]);
        rows.push({ type, name, typeLabel: t.label, entries, count: entries.length, entriesText: entries.join(", "), description: g?.description || "" });
      }
    }
    table.setRows(rows);
  }

  async function editGroup(r) {
    await formDialog(r ? `List <${r.name}>` : "New address list", [
      ...(r ? [] : [
        { name: "name", label: "Name", placeholder: "e.g. TRUSTED, BLOCKED" },
        { name: "type", label: "Type", type: "select", options: Object.entries(GROUP_TYPES).map(([value, t]) => ({ value, label: t.label })), value: "address-group" },
      ]),
      { name: "entries", label: "Members", type: "textarea", rows: 8, value: r ? r.entries.join("\n") : "", hint: "One per line." },
      { name: "description", label: "Comment", value: r?.description || "" },
    ], async (v) => {
      const type = r ? r.type : v.type;
      const name = r ? r.name : v.name.trim();
      const t = GROUP_TYPES[type];
      if (!/^[A-Za-z0-9._-]{1,31}$/.test(name)) throw new Error("Name: letters, digits, - _ . (max 31)");
      if (!r && groups[type]?.[name]) throw new Error(`${name} already exists`);
      const entries = v.entries.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
      for (const e of entries) if (!t.re.test(e)) throw new Error(`"${e}" is not valid here (${t.hint})`);
      const base = [...ROOT, type, name];
      const cmds = diffMulti(base, t.leaf, r ? r.entries : [], entries);
      if ((v.description || "") !== (r?.description || "")) {
        cmds.push(v.description.trim() ? { op: "set", path: [...base, "description"], value: v.description.trim() } : { op: "delete", path: [...base, "description"] });
      }
      if (!r && !cmds.length) cmds.push({ op: "set", path: base });
      if (!cmds.length) return true;
      await applyChanges(cmds, `list ${name}`);
      load();
      return true;
    }, { okLabel: "Apply" });
  }

  async function removeGroup() {
    const r = table.selected();
    if (!r) return setStatus("Select a list first.", true);
    if (!(await confirmBox("Delete list", `Delete ${r.name}? VyOS refuses if a firewall rule still uses it.`, "Delete"))) return;
    try {
      await applyChanges([{ op: "delete", path: [...ROOT, r.type, r.name] }], `delete list ${r.name}`);
    } catch (e) {
      alertBox("Apply failed", errorText(e));
    }
    load();
  }

  load();
}

export function openConnections() {
  const win = openWindow({ key: "connections", title: "Firewall Connections", width: 960, height: 420 });
  if (!win.isNew) return;
  const table = makeTable(
    [
      { key: "proto", label: "Protocol", width: "60px" },
      { key: "srcText", label: "Src. Address", width: "190px" },
      { key: "dstText", label: "Dst. Address", width: "190px" },
      { key: "natText", label: "Reply Dst. (NAT)", width: "140px" },
      { key: "state", label: "State", width: "100px" },
      { key: "timeout", label: "Timeout", width: "60px", className: "num" },
      { key: "traffic", label: "Traffic", className: "num" },
    ],
    { rowKey: (r) => r.key },
  );
  const summary = h("span.hint");
  const auto = h("input", { type: "checkbox", checked: true });
  win.body.append(
    h("div.win-toolbar", h("button", { on: { click: load } }, "⟳"), h("label", auto, " Auto refresh"), summary, h("span.grow"), filterBox(table)),
    table.wrap, table.count,
  );

  async function load() {
    let flows;
    try {
      flows = await api.connections();
    } catch (e) {
      return setStatus(errorText(e), true);
    }
    const counted = flows.some((f) => f.bytes > 0);
    table.setRows(flows.map((f, i) => ({
      ...f,
      key: `${f.proto}|${f.src}|${f.sport}|${f.dst}|${f.dport}|${i}`,
      srcText: f.sport ? `${f.src}:${f.sport}` : f.src,
      dstText: f.dport ? `${f.dst}:${f.dport}` : f.dst,
      natText: f.replySrc && f.replySrc !== f.dst ? f.replySrc : f.replyDst && f.replyDst !== f.src ? `→ ${f.replyDst}` : "",
      traffic: counted ? `${formatBytes(f.bytes)} / ${f.packets} pkts` : "",
    })));
    const bySrc = new Map();
    for (const f of flows) bySrc.set(f.src, (bySrc.get(f.src) || 0) + 1);
    const top = [...bySrc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([ip, n]) => `${ip} (${n})`).join(", ");
    summary.textContent = `${flows.length} connections${top ? ` · busiest: ${top}` : ""}${counted ? "" : " · byte counters off (net.netfilter.nf_conntrack_acct)"}`;
  }
  load();
  const timer = every(() => auto.checked && load(), 5000);
  win.onClose(() => clearInterval(timer));
}
