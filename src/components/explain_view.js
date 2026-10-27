// Clients → a device → "What can it reach?": for the internet, each other
// network and the internet coming in, which rule decides and which only
// limit some traffic, with the page each rule comes from.
import { api, errorText } from "../lib/api.js";
import { h } from "../lib/dom.js";
import { modal, alertBox } from "../lib/dialog.js";
import { showView } from "../lib/views.js";
import { wanInfo } from "../lib/wan.js";
import { readNetworks } from "../lib/netplan.js";
import { ipv4InCidr } from "../lib/vyos.js";
import { explainDevice } from "../lib/explain.js";
import { ownerText } from "../lib/owner.js";
import { openOwner } from "./owned.js";
import { openFirewall } from "./firewall.js";

const close = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

function stepLabel(s) {
  if (s.owner) {
    return h("button.owner-badge", { title: s.owner.view ? `Made on the ${s.owner.feature} page: open it` : "Made by VyGi", on: { click: () => {
      close();
      openOwner(s.owner);
    } } }, ownerText(s.owner));
  }
  return h("button.owner-badge.manual", { title: "A rule made by hand: open it in Advanced → Filter Rules", on: { click: () => {
    close();
    showView("windows");
    openFirewall();
  } } }, `Rule ${s.number}${s.chain !== "forward" ? ` in ${s.chain}` : ""}${s.description ? `: ${s.description}` : ""}`);
}

function verdictRow(title, r) {
  const limited = r.verdict === "allowed" && r.partly.length;
  const pill = h(`span.pill.${r.verdict === "blocked" ? "bad" : limited ? "warn" : "ok"}`, r.verdict === "blocked" ? "Blocked" : limited ? "Allowed, with limits" : "Allowed");
  const lines = [];
  if (r.verdict === "blocked") {
    lines.push(h("div.why-line", r.by ? ["Blocked by ", stepLabel(r.by)] : "Blocked: no rule allows it and the firewall's default here is to drop."));
    for (const s of r.partlyAllowed || []) lines.push(h("div.why-line.limit", `Allowed ${s.reasons.join(", ") || "for some traffic"} by `, stepLabel(s)));
  } else {
    if (r.by) lines.push(h("div.why-line", "Allowed by ", stepLabel(r.by)));
    for (const s of r.partly) lines.push(h("div.why-line.limit", `Blocked ${s.reasons.join(", ") || "for some traffic"} by `, stepLabel(s)));
  }
  return h("div.why-row", h("div.why-head", h("b", title), h("span.grow"), pill), ...lines);
}

/** c: a client row { ip, mac, iface, label }. */
export async function openReach(c) {
  let cfg;
  let w;
  try {
    [cfg, w] = await Promise.all([api.getConfig([]).then((x) => x || {}), wanInfo()]);
  } catch (e) {
    return alertBox("What can it reach?", errorText(e));
  }
  const nets = readNetworks(cfg, w.wan);
  const iface = c.iface || nets.find((n) => ipv4InCidr(c.ip, n.network))?.iface || "";
  const r = explainDevice(cfg, { ip: c.ip, mac: c.mac, iface }, nets, w.wan);
  const body = h("div.why", { style: { width: "560px" } },
    h("p.hint", { style: { marginTop: 0 } }, `New connections from ${c.ip}${iface ? ` (${nets.find((n) => n.iface === iface)?.name || iface})` : ""}, rule by rule as the firewall checks them. Rules that depend on the site, port or time show as limits. Click a rule to change it where it was made.`),
    verdictRow("The internet", r.internet),
    ...r.networks.map((n) => verdictRow(`${n.net.name} network`, n)),
    h("div.why-row",
      h("div.why-head", h("b", "From the internet"), h("span.grow"), h(`span.pill.${r.forwards.length ? "warn" : "ok"}`, r.forwards.length ? `${r.forwards.length} port forward${r.forwards.length === 1 ? "" : "s"}` : "Not reachable")),
      r.forwards.length
        ? r.forwards.map((f) => h("div.why-line", `${f.protocol.toUpperCase()} ${f.port}${f.toPort && f.toPort !== f.port ? ` → ${f.toPort}` : ""}${f.from ? ` from ${f.from}` : " from anyone"}: `, stepLabel({ ...f, chain: "port forward" })))
        : h("div.why-line.hint", "No port forwards lead to this device.")),
  );
  await modal(`What can ${c.label || c.ip} reach?`, body, [{ label: "Close", value: "ok", primary: true }]);
}
