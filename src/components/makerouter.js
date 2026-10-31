// "Make it a router": one form for the internet port, a home network and the
// basic firewall, applied as one change (with the usual preview and Safe
// Mode). Opened from Set up this router, Network → Internet and the search bar.
import { api, errorText } from "../lib/api.js";
import { formDialog, alertBox, confirmBox } from "../lib/dialog.js";
import { applyChanges, isConnected } from "../lib/session.js";
import { routerContext } from "../lib/routerctx.js";
import { routerDefaults, routerPlan } from "../lib/makerouter.js";
import { suggestPool } from "../lib/netplan.js";
import { parseIpv4Cidr } from "../lib/vyos.js";

const TITLE = "Make it a router";

/** Resolves true when the change was applied. */
export async function openMakeRouter() {
  if (!isConnected()) {
    alertBox(TITLE, "Connect to a router first.");
    return false;
  }
  let cfg;
  let ctx;
  try {
    [cfg, ctx] = await Promise.all([api.getConfig([]).then((c) => c || {}), routerContext({ fresh: true })]);
  } catch (e) {
    alertBox(TITLE, errorText(e));
    return false;
  }
  const d = routerDefaults(cfg, ctx);
  const portLabel = (p) => `${p.name}${p.addrs.length ? ` (${p.addrs.join(", ")})` : p.bridge ? ` (in ${p.bridge})` : p.name === ctx.mgmtIface || (p.name === d.internet.port && ctx.wanIp) ? "" : " (free)"}${p.name === d.internet.port && ctx.wanIp ? " · internet now" : ""}${p.name === ctx.mgmtIface ? " · VyGi connects here" : ""}`;
  const free = d.ports.filter((p) => p.free && p.name !== d.internet.port && p.name !== ctx.mgmtIface).map((p) => p.name);
  const lanOptions = [
    ...d.nets.map((n) => ({ value: n.iface, label: `${n.name} · ${n.network} on ${n.iface}${n.iface === ctx.mgmtIface ? " (VyGi connects here)" : ""}` })),
    ...(free.length ? [{ value: "new", label: "A new network on free ports" }] : []),
  ];
  if (!lanOptions.length) {
    alertBox(TITLE, "Every port already has an address and none is a local network. Free a port in Advanced → Interfaces first.");
    return false;
  }
  const lan0 = lanOptions.some((o) => o.value === d.lan) ? d.lan : lanOptions[0].value;
  const inet = d.internet;
  const fields = [
    { name: "port", label: "Internet port", type: "select", value: inet.port, options: d.ports.map((p) => ({ value: p.name, label: portLabel(p) })), hint: "The port cabled to your modem or fibre box (ONT)." },
    { name: "mode", label: "How it connects", type: "select", value: ctx.wanIp ? "keep" : inet.mode, options: [
      ...(ctx.wanIp ? [{ value: "keep", label: `Keep the current connection (online, ${ctx.wanIp} on ${ctx.wan})` }] : []),
      { value: "dhcp", label: "Automatic (the modem gives an address)" },
      { value: "pppoe", label: "PPPoE (a username and password from your provider)" },
      { value: "static", label: "Fixed address (from your provider)" },
    ] },
    { name: "vlan", label: "VLAN tag", value: inet.vlan, placeholder: "usually empty", hint: "Only if your provider says so (some fibre providers use one, e.g. 35 or 10)." },
    { name: "user", label: "PPPoE username", value: inet.user },
    { name: "password", label: "PPPoE password", type: "password", value: "", placeholder: inet.hasPassword ? "unchanged" : "" },
    { name: "staticAddr", label: "Address", value: inet.staticAddr, placeholder: "203.0.113.10/24" },
    { name: "gateway", label: "Gateway", value: inet.gateway, placeholder: "203.0.113.1" },
    { name: "dns", label: "DNS servers", value: inet.dns, placeholder: "1.1.1.1 9.9.9.9" },
    { name: "lan", label: "Home network", type: "select", value: lan0, options: lanOptions, hint: "" },
    { name: "newPorts", label: "Ports", type: "multicheck", value: d.newPorts, options: free, hint: "Tick several to join them into one network: they then work like one switch." },
    { name: "cidr", label: "Router address", value: d.cidr, hint: "The router's address on the home network, with its size (/24 = 254 devices)." },
    { name: "poolStart", label: "Addresses from", value: d.pool.start },
    { name: "poolStop", label: "Addresses to", value: d.pool.stop },
  ];
  let plan = null;
  const r = await formDialog(TITLE, fields, async (v) => {
    plan = routerPlan(cfg, v, ctx);
    if (!plan.cmds.length) throw new Error("Nothing to change: this router is already set up like this.");
    return true;
  }, {
    intro: "Sets up the internet connection, a home network that hands out addresses, the router as the DNS server, NAT and a basic firewall, in one change. You see every change before it's applied, and Safe Mode undoes it if VyGi loses the router.",
    okLabel: "Review",
    initChange: true,
    onChange(field, v, set) {
      set.show("vlan", v.mode !== "keep");
      for (const f of ["user", "password"]) set.show(f, v.mode === "pppoe");
      for (const f of ["staticAddr", "gateway", "dns"]) set.show(f, v.mode === "static");
      const fresh = v.lan === "new";
      for (const f of ["newPorts", "cidr", "poolStart", "poolStop"]) set.show(f, fresh);
      const n = d.nets.find((x) => x.iface === v.lan);
      set.hint("lan", n
        ? n.dhcp ? "Keeps its address and its DHCP; adds what's missing (internet, DNS)." : `Keeps ${n.routerIp}; devices get addresses ${suggestPool(n.cidr).start}–${suggestPool(n.cidr).stop}.`
        : "");
      if (field === "cidr" && parseIpv4Cidr(v.cidr)) {
        const p = suggestPool(v.cidr);
        set("poolStart", p.start);
        set("poolStop", p.stop);
      }
    },
  });
  if (!r || !plan) return false;
  if (plan.notes.length && !(await confirmBox(TITLE, plan.notes.join("\n\n"), "Continue"))) return false;
  try {
    await applyChanges(plan.cmds, TITLE, { preview: true });
    return true;
  } catch (e) {
    if (!/^Cancelled/.test(e?.message || "")) alertBox(TITLE, errorText(e));
    return false;
  }
}
