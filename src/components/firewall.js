// Firewall: rule table per chain (forward / input / output / custom), default action.
import { h, clear, setStatus } from "../lib/dom.js";
import { api, errorText } from "../lib/api.js";
import { openWindow } from "../lib/mdi.js";
import { confirmBox, alertBox, formDialog } from "../lib/dialog.js";
import { applyChanges } from "../lib/session.js";
import { ruleEditor } from "../lib/rules.js";
import { openConfigTree } from "./config_tree.js";

const BASE_CHAINS = ["forward", "input", "output"];
const CHAIN_HELP = {
  forward: "Traffic passing THROUGH the router (LAN ⇄ internet).",
  input: "Traffic TO the router itself (SSH, web UI, DNS, ping to the router).",
  output: "Traffic FROM the router itself.",
};

function fieldsFor(chain) {
  const custom = !BASE_CHAINS.includes(chain);
  const inbound = custom || chain !== "output";
  const outbound = custom || chain !== "input";
  return [
    { name: "action", label: "Action", path: ["action"], type: "select", options: ["accept", "drop", "reject", "jump", "return", "continue"] },
    { name: "jump", label: "Jump target", path: ["jump-target"], placeholder: "custom chain name, only for action jump" },
    { name: "protocol", label: "Protocol", path: ["protocol"], type: "select", options: ["", "tcp", "udp", "tcp_udp", "icmp", "ipv6-icmp", "gre", "esp", "all"] },
    { name: "srcAddr", label: "Src. Address", path: ["source", "address"], placeholder: "192.0.2.0/24, 10.0.0.1-10.0.0.9, or !addr to negate" },
    { name: "srcPort", label: "Src. Port", path: ["source", "port"], placeholder: "e.g. 1024-65535" },
    { name: "srcGroup", label: "Src. Address Group", path: ["source", "group", "address-group"], placeholder: "group name (Groups… button)" },
    { name: "dstAddr", label: "Dst. Address", path: ["destination", "address"] },
    { name: "dstPort", label: "Dst. Port", path: ["destination", "port"], placeholder: "e.g. 22 or 80,443 or 8000-8080" },
    { name: "dstGroup", label: "Dst. Address Group", path: ["destination", "group", "address-group"] },
    ...(inbound ? [{ name: "inIf", label: "In. Interface", path: ["inbound-interface", "name"], placeholder: "eth0, or wildcard like eth*" }] : []),
    ...(outbound ? [{ name: "outIf", label: "Out. Interface", path: ["outbound-interface", "name"] }] : []),
    { name: "state", label: "Conn. State", path: ["state"], type: "multicheck", options: ["established", "related", "new", "invalid"] },
    { name: "log", label: "Log", path: ["log"], type: "flag" },
    { name: "description", label: "Comment", path: ["description"] },
  ];
}

const COLUMNS = [
  { key: "action", label: "Action", width: "62px", path: ["action"] },
  { key: "proto", label: "Proto", width: "58px", path: ["protocol"] },
  { key: "src", label: "Src. Address", width: "130px", value: (c) => c.source?.address || (c.source?.group?.["address-group"] ? `@${c.source.group["address-group"]}` : "") },
  { key: "sport", label: "Src. Port", width: "70px", path: ["source", "port"] },
  { key: "dst", label: "Dst. Address", width: "130px", value: (c) => c.destination?.address || (c.destination?.group?.["address-group"] ? `@${c.destination.group["address-group"]}` : "") },
  { key: "dport", label: "Dst. Port", width: "80px", path: ["destination", "port"] },
  { key: "in", label: "In. Iface", width: "70px", path: ["inbound-interface", "name"] },
  { key: "out", label: "Out. Iface", width: "70px", path: ["outbound-interface", "name"] },
  { key: "state", label: "State", width: "120px", path: ["state"] },
  { key: "log", label: "Log", width: "34px", value: (c) => (c.log ? "yes" : "") },
  { key: "desc", label: "Comment", path: ["description"] },
];

export function openFirewall() {
  const win = openWindow({ key: "firewall", title: "Firewall", width: 1120, height: 460 });
  if (!win.isNew) return;

  const family = h("select", h("option", { value: "ipv4" }, "IPv4"), h("option", { value: "ipv6" }, "IPv6"));
  const chain = h("select");
  const defaultAction = h("select");
  const help = h("span.hint");
  const top = h(
    "div.win-toolbar",
    family,
    h("span", "Chain:"), chain,
    h("span", "Default action:"), defaultAction,
    h("button", { title: "Create a custom chain (used with action jump)", on: { click: newChain } }, "New chain…"),
    h("button", { title: "Address / network / port groups", on: { click: () => openConfigTree(["firewall", "group"], "Firewall Groups") } }, "Groups…"),
    help,
  );
  const page = h("div.tab-page.active");
  win.body.append(top, page);

  const base = () => (BASE_CHAINS.includes(chain.value) ? ["firewall", family.value, chain.value, "filter"] : ["firewall", family.value, "name", chain.value]);

  const editor = ruleEditor({
    page,
    what: "rule",
    title: "Firewall Rule",
    getBase: base,
    columns: COLUMNS,
    getFields: () => fieldsFor(chain.value),
    newDefaults: { action: "accept" },
    validate(v) {
      if (v.action === "jump" && !v.jump.trim()) throw new Error("Action jump needs a jump target");
      if (v.action !== "jump" && v.jump.trim()) throw new Error("Jump target is only used with action jump");
      if ((v.srcPort.trim() || v.dstPort.trim()) && !["tcp", "udp", "tcp_udp"].includes(v.protocol)) throw new Error("Ports need protocol tcp, udp or tcp_udp");
    },
    onNode(node) {
      const isBase = BASE_CHAINS.includes(chain.value);
      const options = isBase ? ["accept", "drop"] : ["drop", "reject", "return", "accept", "continue"];
      clear(defaultAction);
      const current = node["default-action"] || (isBase ? "accept" : "drop");
      for (const o of options) defaultAction.append(h("option", { value: o, selected: o === current }, o));
      defaultAction.dataset.current = current;
    },
  });

  async function loadChains() {
    const keep = chain.value;
    clear(chain);
    for (const c of BASE_CHAINS) chain.append(h("option", { value: c }, c));
    try {
      const custom = Object.keys((await api.getConfig(["firewall", family.value, "name"])) || {});
      for (const c of custom) chain.append(h("option", { value: c }, `${c} (custom)`));
    } catch {
      /* no custom chains */
    }
    chain.value = [...chain.options].some((o) => o.value === keep) ? keep : "forward";
    help.textContent = CHAIN_HELP[chain.value] || "Custom chain: runs only when another rule jumps to it.";
  }

  async function reload() {
    help.textContent = CHAIN_HELP[chain.value] || "Custom chain: runs only when another rule jumps to it.";
    await editor.load();
  }

  family.addEventListener("change", async () => {
    await loadChains();
    reload();
  });
  chain.addEventListener("change", reload);

  defaultAction.addEventListener("change", async () => {
    const to = defaultAction.value;
    const from = defaultAction.dataset.current;
    if (to === from) return;
    let warn = `Set default action of ${family.value} ${chain.value} to "${to}"?`;
    if (to === "drop" && chain.value === "input") {
      warn += "\n\nWARNING: with input = drop, anything not explicitly accepted (SSH, HTTPS API, DNS, DHCP to the router) is blocked. " +
        "Make sure you have rules accepting established/related traffic and your management access BEFORE doing this.";
    } else if (to === "drop" && chain.value === "forward") {
      warn += "\n\nAll traffic through the router that is not accepted by a rule will be blocked (including replies, unless you accept established/related).";
    }
    warn += document.getElementById("safe-mode").checked ? "\n\nSafe Mode is ON." : "\n\nSafe Mode is OFF — consider turning it on first.";
    if (!(await confirmBox("Default action", warn, "Apply"))) {
      defaultAction.value = from;
      return;
    }
    try {
      await applyChanges([{ op: "set", path: [...base(), "default-action"], value: to }], `default-action ${to}`);
    } catch (e) {
      alertBox("Apply failed", errorText(e));
    }
    reload();
  });

  async function newChain() {
    await formDialog("New custom chain", [
      { name: "name", label: "Name", placeholder: "e.g. LAN-IN" },
      { name: "action", label: "Default action", type: "select", options: ["drop", "reject", "return", "accept"], value: "drop" },
    ], async (v) => {
      const name = v.name.trim();
      if (!/^[A-Za-z0-9._-]{1,28}$/.test(name)) throw new Error("Use letters, digits, - _ . (max 28 chars)");
      await applyChanges([{ op: "set", path: ["firewall", family.value, "name", name, "default-action"], value: v.action }], `chain ${name}`);
      await loadChains();
      chain.value = name;
      reload();
      return true;
    }, { okLabel: "Create" });
  }

  loadChains().then(reload).catch((e) => setStatus(errorText(e), true));
}
