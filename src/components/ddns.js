// IP > Dynamic DNS: keep a host name pointed at the router's changing public IP.
import { api, errorText } from "../lib/api.js";
import { h, setStatus } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { makeTable } from "../lib/table.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges } from "../lib/session.js";
import { flattenInterfaces } from "../lib/vyos.js";
import { BASE, PROVIDERS, needs, parseDdns, ddnsCommands, parseStatus } from "../lib/ddns.js";

const providerLabel = (p) => PROVIDERS.find(([v]) => v === p)?.[1] || p;

export function openDdns() {
  const win = openWindow({ key: "ddns", title: "Dynamic DNS", width: 820, height: 380 });
  if (!win.isNew) return;
  let rows = [];
  const table = makeTable(
    [
      { key: "name", label: "Name", width: "110px" },
      { key: "providerText", label: "Provider", width: "130px" },
      { key: "hostsText", label: "Host name", width: "200px" },
      { key: "sourceText", label: "IP from", width: "110px" },
      { key: "ipText", label: "Registered IP", width: "120px" },
      { key: "statusText", label: "Last update" },
    ],
    { rowKey: (r) => r.name, onOpen: (r) => edit(r) },
  );
  win.body.append(
    h("div.win-toolbar",
      h("button.icon-add", { title: "New Dynamic DNS entry", on: { click: () => edit(null) } }, "+"),
      h("button.icon-remove", { title: "Delete", on: { click: remove } }, "−"),
      h("button", { on: { click: () => { const r = table.selected(); r ? edit(r) : setStatus("Select an entry first.", true); } } }, "Edit"),
      h("button", { title: "Send an update to the provider now", on: { click: updateNow } }, "Update now"),
      h("button", { on: { click: load } }, "⟳"),
      h("span.hint", "Keeps a name like home.example.com pointing at your changing public IP (VyOS runs ddclient).")),
    table.wrap, table.count,
  );

  async function load() {
    let cfg;
    let status = [];
    try {
      cfg = await api.getConfig(BASE);
      status = parseStatus(await api.ddnsStatus().catch(() => null));
    } catch (e) {
      return setStatus(errorText(e), true);
    }
    rows = parseDdns(cfg);
    const byHost = new Map(status.map((s) => [s.host, s]));
    table.setRows(rows.map((r) => {
      const st = r.hosts.map((x) => byHost.get(x)).filter(Boolean);
      return {
        ...r,
        providerText: providerLabel(r.protocol),
        hostsText: r.hosts.join(", "),
        sourceText: r.source === "web" ? "web lookup" : r.iface,
        ipText: [...new Set(st.map((s) => s.ip).filter(Boolean))].join(", "),
        statusText: st.length ? st.map((s) => `${s.status || "?"}${s.updated ? ` at ${s.updated}` : ""}`).join("; ") : "not updated yet",
      };
    }));
  }

  async function interfaces() {
    const [cfg, routes] = await Promise.all([api.getConfig(["interfaces"]).catch(() => ({})), api.routes(4, "default").catch(() => [])]);
    const names = [...flattenInterfaces(cfg).keys()].filter((n) => n !== "lo");
    const def = routes.find((r) => r.dst === "default");
    const wan = def?.dev || (def?.nexthops || [])[0]?.dev || "";
    return { names: [...new Set([...(wan ? [wan] : []), ...names])], wan };
  }

  async function edit(r) {
    const old = r ? rows.find((x) => x.name === r.name) : null;
    const { names, wan } = await interfaces();
    const n0 = needs(old?.protocol || "cloudflare");
    await formDialog(old ? `Dynamic DNS: ${old.name}` : "New Dynamic DNS", [
      { name: "name", label: "Name", value: old?.name || "home", hint: "Just a label for this entry." },
      { name: "protocol", label: "Provider", type: "select", value: old?.protocol || "cloudflare", options: PROVIDERS.map(([value, label]) => ({ value, label })), hint: n0.hint },
      { name: "hosts", label: "Host name", value: old?.hosts.join(" ") || "", placeholder: "home.example.com", hint: "Several? Separate them with spaces." },
      { name: "username", label: "Username", value: old?.username || "" },
      { name: "password", label: old ? "Password / token" : "Password / token", type: "password", value: "", placeholder: old?.hasPassword ? "unchanged" : "" },
      { name: "zone", label: "Zone", value: old?.zone || "", placeholder: "example.com" },
      { name: "server", label: "Server", value: old?.server || "", placeholder: "optional, provider's update host" },
      { name: "source", label: "Public IP from", type: "select", value: old?.source || "interface", options: [{ value: "interface", label: "the router's internet interface" }, { value: "web", label: "a web lookup (router is behind another router)" }] },
      { name: "iface", label: "Interface", type: "select", value: old?.iface || wan || names[0] || "", options: names },
      { name: "url", label: "Lookup URL", value: old?.url || "https://api.ipify.org", hint: "Any https page that returns just your public IP." },
      { name: "ipVersion", label: "IP version", type: "select", value: old?.ipVersion || "ipv4", options: [{ value: "ipv4", label: "IPv4" }, { value: "ipv6", label: "IPv6" }, { value: "both", label: "IPv4 and IPv6" }] },
    ], async (v) => {
      await applyChanges(ddnsCommands(v, old), `dynamic DNS ${v.name}`);
      load();
      return true;
    }, {
      okLabel: "Apply",
      initChange: true,
      onChange(_field, v, set) {
        const n = needs(v.protocol);
        set.hint("protocol", n.hint);
        set.show("username", n.username);
        set.show("zone", n.zone !== "no");
        set.show("iface", v.source !== "web");
        set.show("url", v.source === "web");
      },
    });
  }

  async function remove() {
    const r = table.selected();
    if (!r) return setStatus("Select an entry first.", true);
    if (!(await confirmBox("Delete", `Stop updating ${r.hostsText}?`, "Delete"))) return;
    try {
      await applyChanges([{ op: "delete", path: [...BASE, r.name] }], `remove dynamic DNS ${r.name}`);
      load();
    } catch (e) {
      alertBox("Failed", errorText(e));
    }
  }

  async function updateNow() {
    try {
      await api.ddnsUpdateNow();
      setStatus("Dynamic DNS update sent. The status shows the result in a few seconds.");
      setTimeout(load, 5000);
    } catch (e) {
      alertBox("Update failed", errorText(e));
    }
  }

  load();
}
