// IP > DNS: router's own resolvers, DNS forwarding (serve DNS to the LAN), static host names.
import { api, errorText } from "../lib/api.js";
import { h, setStatus } from "../lib/dom.js";
import { openWindow, tabs } from "../lib/mdi.js";
import { makeTable, filterBox } from "../lib/table.js";
import { formDialog, alertBox, confirmBox } from "../lib/dialog.js";
import { applyChanges } from "../lib/session.js";
import { toArray, tagKeys, has, diffMulti, diffSingle } from "../lib/vyos.js";

const FWD = ["service", "dns", "forwarding"];
const HOSTS = ["system", "static-host-mapping", "host-name"];
const IP_RE = /^[0-9a-fA-F:.]+$/;
const PREFIX_RE = /^[0-9a-fA-F:.]+\/\d{1,3}$/;

const words = (s) => s.split(/[\s,]+/).filter(Boolean);

export function openDns() {
  const win = openWindow({ key: "dns", title: "DNS", width: 720, height: 460 });
  if (!win.isNew) return;
  const loaders = {};
  const t = tabs(["Settings", "Static"], (name) => loaders[name]?.());
  win.body.append(t.el);

  // ---------------- Settings ----------------
  const form = h("div.form", { style: { padding: "10px", overflow: "auto" } });
  const status = h("span.hint");
  const inputs = {
    system: h("input", { type: "text" }),
    upstream: h("input", { type: "text" }),
    useSystem: h("input", { type: "checkbox" }),
    allowFrom: h("input", { type: "text" }),
    listen: h("input", { type: "text" }),
    cache: h("input", { type: "text" }),
    dnssec: h("select", ["", "off", "process-no-validate", "process", "log-fail", "validate"].map((o) => h("option", { value: o }, o || "(default)"))),
  };
  const row = (label, el, hint) => (hint ? [h("label", label), el, h("span"), h("span.hint", hint)] : [h("label", label), el]);
  form.append(
    ...row("Router's DNS servers", inputs.system, "What the router itself uses (system name-server). Space-separated."),
    h("div.full", { style: { borderTop: "1px solid var(--border)", margin: "6px 0" } }),
    h("div.full", h("b", "DNS forwarding (answer DNS for your network)"), " ", status),
    ...row("Allow requests from", inputs.allowFrom, "Networks allowed to ask, e.g. 192.168.1.0/24. Empty = forwarding off."),
    ...row("Listen on", inputs.listen, "Router addresses to answer on, e.g. 192.168.1.1"),
    ...row("Upstream servers", inputs.upstream, "e.g. 1.1.1.1 9.9.9.9. Leave empty to use the router's DNS servers (tick below)."),
    h("span"), h("label", { style: { textAlign: "left" } }, inputs.useSystem, " Also forward to the router's DNS servers"),
    ...row("Cache size", inputs.cache, "Entries (default 10000)."),
    ...row("DNSSEC", inputs.dnssec),
  );
  t.pages.Settings.append(
    h(
      "div.win-toolbar",
      h("button", { style: { fontWeight: "bold" }, on: { click: applySettings } }, "Apply"),
      h("button", { on: { click: () => loaders.Settings() } }, "Reload"),
      h("button", { title: "Remove all DNS forwarding settings", on: { click: disableForwarding } }, "Turn off forwarding"),
    ),
    form,
  );

  let before = null;
  loaders.Settings = async () => {
    try {
      const [sys, fwd] = await Promise.all([api.getConfig(["system", "name-server"]).catch(() => null), api.getConfig(FWD).catch(() => ({}))]);
      before = {
        system: Array.isArray(sys) || typeof sys === "string" ? toArray(sys) : [],
        upstream: tagKeys(fwd["name-server"]),
        useSystem: has(fwd, "system"),
        allowFrom: toArray(fwd["allow-from"]),
        listen: toArray(fwd["listen-address"]),
        cache: fwd["cache-size"] || "",
        dnssec: fwd.dnssec || "",
        configured: Object.keys(fwd || {}).length > 0,
      };
      inputs.system.value = before.system.join(" ");
      inputs.upstream.value = before.upstream.join(" ");
      inputs.useSystem.checked = before.useSystem;
      inputs.allowFrom.value = before.allowFrom.join(" ");
      inputs.listen.value = before.listen.join(" ");
      inputs.cache.value = before.cache;
      inputs.dnssec.value = before.dnssec;
      status.textContent = before.configured ? "(on)" : "(off)";
    } catch (e) {
      setStatus(errorText(e), true);
    }
  };

  async function applySettings() {
    if (!before) return;
    const v = {
      system: words(inputs.system.value),
      upstream: words(inputs.upstream.value),
      allowFrom: words(inputs.allowFrom.value),
      listen: words(inputs.listen.value),
    };
    try {
      for (const ip of [...v.system, ...v.upstream, ...v.listen]) if (!IP_RE.test(ip)) throw new Error(`"${ip}" is not an IP address`);
      for (const p of v.allowFrom) if (!PREFIX_RE.test(p)) throw new Error(`"${p}" must be a network like 192.168.1.0/24`);
      if (inputs.cache.value.trim() && !/^\d+$/.test(inputs.cache.value.trim())) throw new Error("Cache size must be a number");
      const enabling = v.allowFrom.length > 0;
      if (enabling && !v.listen.length) throw new Error("Set at least one Listen on address");
      if (enabling && !v.upstream.length && !inputs.useSystem.checked) throw new Error("Give upstream servers or tick 'forward to the router's DNS servers'");
    } catch (e) {
      return alertBox("DNS", e.message);
    }

    const cmds = [...diffMulti(["system"], "name-server", before.system, v.system)];
    if (!v.allowFrom.length) {
      if (before.configured) cmds.push({ op: "delete", path: FWD });
    } else {
      // name-server is a tag node: each server is its own node.
      for (const s of before.upstream) if (!v.upstream.includes(s)) cmds.push({ op: "delete", path: [...FWD, "name-server", s] });
      for (const s of v.upstream) if (!before.upstream.includes(s)) cmds.push({ op: "set", path: [...FWD, "name-server", s] });
      if (inputs.useSystem.checked !== before.useSystem) cmds.push({ op: inputs.useSystem.checked ? "set" : "delete", path: [...FWD, "system"] });
      cmds.push(...diffMulti(FWD, "allow-from", before.allowFrom, v.allowFrom));
      cmds.push(...diffMulti(FWD, "listen-address", before.listen, v.listen));
      cmds.push(...diffSingle(FWD, "cache-size", before.cache, inputs.cache.value));
      cmds.push(...diffSingle(FWD, "dnssec", before.dnssec, inputs.dnssec.value));
    }
    if (!cmds.length) return setStatus("No changes.");
    try {
      await applyChanges(cmds, "DNS settings");
    } catch (e) {
      alertBox("Apply failed", errorText(e));
    }
    loaders.Settings();
  }

  async function disableForwarding() {
    if (!before?.configured) return setStatus("DNS forwarding is already off.");
    if (!(await confirmBox("DNS forwarding", "Turn off DNS forwarding? Devices that use the router as their DNS server will stop resolving names.", "Turn off"))) return;
    try {
      await applyChanges([{ op: "delete", path: FWD }], "DNS forwarding off");
    } catch (e) {
      alertBox("Apply failed", errorText(e));
    }
    loaders.Settings();
  }

  // ---------------- Static ----------------
  const hosts = makeTable(
    [
      { key: "name", label: "Name", width: "200px" },
      { key: "addresses", label: "Address", width: "200px" },
      { key: "aliases", label: "Aliases" },
    ],
    { rowKey: (r) => r.name, onOpen: (r) => editHost(r) },
  );
  t.pages.Static.append(
    h(
      "div.win-toolbar",
      h("button.icon-add", { on: { click: () => editHost(null) } }, "+"),
      h("button.icon-remove", { on: { click: removeHost } }, "−"),
      h("button", { on: { click: () => loaders.Static() } }, "⟳"),
      h("span.hint", "Names the router (and its DNS forwarding) resolves locally."),
      h("span.grow"),
      filterBox(hosts),
    ),
    hosts.wrap,
    hosts.count,
  );
  loaders.Static = async () => {
    try {
      const cfg = (await api.getConfig(HOSTS)) || {};
      hosts.setRows(
        Object.entries(cfg).map(([name, c]) => ({
          name,
          inet: toArray(c?.inet),
          alias: toArray(c?.alias),
          addresses: toArray(c?.inet).join(", "),
          aliases: toArray(c?.alias).join(", "),
        })),
      );
    } catch (e) {
      setStatus(errorText(e), true);
    }
  };

  async function editHost(r) {
    await formDialog(r ? `Static DNS <${r.name}>` : "New static DNS entry", [
      ...(r ? [] : [{ name: "name", label: "Name", placeholder: "nas.home.lan" }]),
      { name: "inet", label: "Address", value: r ? r.inet.join(" ") : "", placeholder: "192.168.1.20" },
      { name: "alias", label: "Aliases", value: r ? r.alias.join(" ") : "", placeholder: "optional, space-separated" },
    ], async (v) => {
      const name = r ? r.name : v.name.trim();
      if (!/^[A-Za-z0-9.-]{1,253}$/.test(name)) throw new Error("Name: letters, digits, dots and hyphens");
      const inet = words(v.inet);
      const alias = words(v.alias);
      if (!inet.length) throw new Error("Give at least one address");
      for (const ip of inet) if (!IP_RE.test(ip)) throw new Error(`"${ip}" is not an IP address`);
      for (const a of alias) if (!/^[A-Za-z0-9.-]{1,253}$/.test(a)) throw new Error(`Bad alias ${a}`);
      const base = [...HOSTS, name];
      const cmds = [...diffMulti(base, "inet", r ? r.inet : [], inet), ...diffMulti(base, "alias", r ? r.alias : [], alias)];
      if (!cmds.length) return true;
      await applyChanges(cmds, `static host ${name}`);
      loaders.Static();
      return true;
    }, { okLabel: "Apply" });
  }

  async function removeHost() {
    const r = hosts.selected();
    if (!r) return setStatus("Select an entry first.", true);
    if (!(await confirmBox("Remove", `Remove static DNS entry ${r.name}?`, "Remove"))) return;
    try {
      await applyChanges([{ op: "delete", path: [...HOSTS, r.name] }], `remove host ${r.name}`);
    } catch (e) {
      alertBox("Apply failed", errorText(e));
    }
    loaders.Static();
  }

  t.select("Settings");
}
