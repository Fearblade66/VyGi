// Quick Set: Winbox-style one-page home router setup (WAN, LAN, DHCP, DNS, NAT, firewall).
// Builds one batch of set/delete commands, shows them, and applies them under Safe Mode.
import { api, errorText } from "../lib/api.js";
import { h, setStatus } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { modal, alertBox } from "../lib/dialog.js";
import { applyChanges, session } from "../lib/session.js";
import { toArray, tagKeys, parseIpv4Cidr, ipv4InCidr } from "../lib/vyos.js";
import { maskSecrets } from "../lib/changes.js";

const ipNum = (ip) => ip.split(".").reduce((a, b) => a * 256 + Number(b), 0);
const numIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");

/** Suggested DHCP pool for a router address: .100-.200 on a /24, else the upper half. */
export function suggestPool(routerCidr) {
  const c = parseIpv4Cidr(routerCidr);
  if (!c) return { start: "", stop: "" };
  const first = ipNum(c.first);
  const last = ipNum(c.last);
  if (last - first >= 250) return { start: numIp(first + 99), stop: numIp(first + 199) };
  const mid = first + Math.ceil((last - first) / 2);
  return { start: numIp(mid), stop: numIp(last) };
}

/** Reads the current state Quick Set needs (pure data, no DOM). */
export function readState(cfg, links) {
  const eth = cfg.interfaces?.ethernet || {};
  const kernelEth = (links || []).filter((l) => l.link_type === "ether" && /^eth\d+$/.test(l.ifname)).map((l) => l.ifname);
  const ports = [...new Set([...Object.keys(eth), ...kernelEth])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const pppoe = cfg.interfaces?.pppoe || {};
  const pppoeName = Object.keys(pppoe)[0];
  const dhcpPort = ports.find((p) => toArray(eth[p]?.address).includes("dhcp"));
  const wan = (pppoeName && pppoe[pppoeName]["source-interface"]) || dhcpPort || ports[0] || "eth0";
  const staticWan = toArray(eth[wan]?.address).find((a) => parseIpv4Cidr(a));
  const mode = pppoeName ? "pppoe" : staticWan ? "static" : "dhcp";
  const bridge = cfg.interfaces?.bridge?.br0;
  const bridgeMembers = Object.keys(bridge?.member?.interface || {});
  const lanPorts = bridgeMembers.length ? bridgeMembers : ports.filter((p) => p !== wan).slice(0, 1);
  const lanIf = bridgeMembers.length ? "br0" : lanPorts[0];
  const lanAddr = toArray((lanIf === "br0" ? bridge : eth[lanIf])?.address).find((a) => parseIpv4Cidr(a)) || "192.168.1.1/24";
  return {
    ports, wan, mode,
    staticAddr: staticWan || "",
    gateway: cfg.protocols?.static?.route?.["0.0.0.0/0"] ? tagKeys(cfg.protocols.static.route["0.0.0.0/0"]["next-hop"])[0] || "" : "",
    dns: toArray(cfg.system?.["name-server"]).join(" "),
    pppoeUser: pppoeName ? pppoe[pppoeName].authentication?.username || "" : "",
    lanPorts, lanAddr,
  };
}

/**
 * Builds the command list. `cfg` is the whole current config; `v` the form values:
 * { wan, mode, staticAddr, gateway, dns, pppoeUser, pppoePass, lanPorts[], lanAddr,
 *   dhcp, poolStart, poolStop, dnsFwd, nat, firewall }
 * Throws Error with a user-facing message on invalid input.
 */
export function quickSetCommands(cfg, v) {
  const cmds = [];
  const set = (path, value) => cmds.push(value === undefined ? { op: "set", path } : { op: "set", path, value: String(value) });
  const del = (path) => cmds.push({ op: "delete", path });
  const eth = cfg.interfaces?.ethernet || {};

  if (!v.wan) throw new Error("Pick the internet (WAN) port");
  if (!v.lanPorts.length) throw new Error("Pick at least one LAN port");
  if (v.lanPorts.includes(v.wan)) throw new Error("The WAN port can't also be a LAN port");
  const lan = parseIpv4Cidr(v.lanAddr);
  if (!lan || lan.bits > 30 || lan.bits < 16) throw new Error("Router LAN address must look like 192.168.1.1/24");
  if (lan.ip === lan.network.split("/")[0]) throw new Error("The router address can't be the network address");

  // ---- WAN
  const wanPath = ["interfaces", "ethernet", v.wan];
  const wanAddrs = toArray(eth[v.wan]?.address);
  let outIf = v.wan;
  if (v.mode === "dhcp") {
    if (!(wanAddrs.length === 1 && wanAddrs[0] === "dhcp")) {
      if (wanAddrs.length) del([...wanPath, "address"]);
      set([...wanPath, "address"], "dhcp");
    }
  } else if (v.mode === "static") {
    const w = parseIpv4Cidr(v.staticAddr);
    if (!w) throw new Error("WAN address must look like 203.0.113.10/24");
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(v.gateway.trim()) || !ipv4InCidr(v.gateway.trim(), w.network)) throw new Error("Gateway must be an address inside the WAN subnet");
    if (!(wanAddrs.length === 1 && wanAddrs[0] === v.staticAddr.trim())) {
      if (wanAddrs.length) del([...wanPath, "address"]);
      set([...wanPath, "address"], v.staticAddr.trim());
    }
    const route = cfg.protocols?.static?.route?.["0.0.0.0/0"];
    if (route && !(tagKeys(route["next-hop"]).length === 1 && tagKeys(route["next-hop"])[0] === v.gateway.trim())) del(["protocols", "static", "route", "0.0.0.0/0"]);
    if (!route || tagKeys(route["next-hop"])[0] !== v.gateway.trim()) set(["protocols", "static", "route", "0.0.0.0/0", "next-hop", v.gateway.trim()]);
    const dns = v.dns.split(/[\s,]+/).filter(Boolean);
    for (const d of dns) if (!/^[\d.]+$/.test(d)) throw new Error(`Bad DNS server ${d}`);
    const curDns = toArray(cfg.system?.["name-server"]);
    for (const d of curDns) if (!dns.includes(d)) del(["system", "name-server", d]);
    for (const d of dns) if (!curDns.includes(d)) set(["system", "name-server"], d);
  } else if (v.mode === "pppoe") {
    if (!v.pppoeUser.trim()) throw new Error("PPPoE needs a username");
    if (wanAddrs.length) del([...wanPath, "address"]);
    const p = ["interfaces", "pppoe", "pppoe0"];
    set([...p, "source-interface"], v.wan);
    set([...p, "authentication", "username"], v.pppoeUser.trim());
    if (v.pppoePass) set([...p, "authentication", "password"], v.pppoePass);
    else if (!cfg.interfaces?.pppoe?.pppoe0?.authentication?.password) throw new Error("PPPoE needs a password");
    set([...p, "ip", "adjust-mss"], "clamp-mss-to-pmtu");
    outIf = "pppoe0";
  } else throw new Error("Unknown WAN mode");

  // ---- LAN
  let lanIf;
  if (v.lanPorts.length > 1) {
    lanIf = "br0";
    const br = ["interfaces", "bridge", "br0"];
    const members = Object.keys(cfg.interfaces?.bridge?.br0?.member?.interface || {});
    for (const m of members) if (!v.lanPorts.includes(m)) del([...br, "member", "interface", m]);
    for (const m of v.lanPorts) {
      if (toArray(eth[m]?.address).length) del(["interfaces", "ethernet", m, "address"]);
      if (!members.includes(m)) set([...br, "member", "interface", m]);
    }
    const cur = toArray(cfg.interfaces?.bridge?.br0?.address);
    if (!(cur.length === 1 && cur[0] === v.lanAddr.trim())) {
      if (cur.length) del([...br, "address"]);
      set([...br, "address"], v.lanAddr.trim());
    }
  } else {
    lanIf = v.lanPorts[0];
    const cur = toArray(eth[lanIf]?.address);
    if (!(cur.length === 1 && cur[0] === v.lanAddr.trim())) {
      if (cur.length) del(["interfaces", "ethernet", lanIf, "address"]);
      set(["interfaces", "ethernet", lanIf, "address"], v.lanAddr.trim());
    }
  }

  // ---- DHCP server (replaces any server already serving this subnet)
  if (v.dhcp) {
    const start = v.poolStart.trim();
    const stop = v.poolStop.trim();
    if (!ipv4InCidr(start, lan.network) || !ipv4InCidr(stop, lan.network) || ipNum(start) > ipNum(stop)) throw new Error(`DHCP pool must be inside ${lan.network}, start before end`);
    if (ipNum(start) <= ipNum(lan.ip) && ipNum(lan.ip) <= ipNum(stop)) throw new Error("The DHCP pool must not include the router's own address");
    const nets = cfg.service?.["dhcp-server"]?.["shared-network-name"] || {};
    let subnetId = null;
    const ids = [];
    for (const [name, n] of Object.entries(nets)) {
      for (const [cidr, s] of Object.entries(n?.subnet || {})) {
        ids.push(Number(s?.["subnet-id"]));
        if (cidr === lan.network || name === "LAN") {
          if (cidr === lan.network) subnetId = s?.["subnet-id"];
          if (!cmds.some((c) => c.op === "delete" && c.path.join(" ") === `service dhcp-server shared-network-name ${name}`)) del(["service", "dhcp-server", "shared-network-name", name]);
        }
      }
    }
    const id = subnetId || String(Math.max(0, ...ids.filter(Number.isFinite)) + 1);
    const b = ["service", "dhcp-server", "shared-network-name", "LAN", "subnet", lan.network];
    set([...b, "subnet-id"], id);
    set([...b, "option", "default-router"], lan.ip);
    set([...b, "option", "name-server"], v.dnsFwd ? lan.ip : "1.1.1.1");
    set([...b, "lease"], "86400");
    set([...b, "range", "0", "start"], start);
    set([...b, "range", "0", "stop"], stop);
  }

  // ---- DNS forwarding (router answers DNS for the LAN)
  if (v.dnsFwd) {
    const f = cfg.service?.dns?.forwarding || {};
    const d = ["service", "dns", "forwarding"];
    if (!toArray(f["allow-from"]).includes(lan.network)) set([...d, "allow-from"], lan.network);
    if (!toArray(f["listen-address"]).includes(lan.ip)) set([...d, "listen-address"], lan.ip);
    if (!Object.keys(f).length || (!f["name-server"] && f.system === undefined)) set([...d, "system"]);
  }

  // ---- NAT masquerade
  if (v.nat) {
    const rules = cfg.nat?.source?.rule || {};
    const exists = Object.values(rules).some((r) => r?.translation?.address === "masquerade" && r?.["outbound-interface"]?.name === outIf);
    if (!exists) {
      let n = 100;
      while (rules[String(n)]) n += 10;
      const r = ["nat", "source", "rule", String(n)];
      set([...r, "outbound-interface", "name"], outIf);
      set([...r, "source", "address"], lan.network);
      set([...r, "translation", "address"], "masquerade");
      set([...r, "description"], "Quick Set: LAN to internet");
    }
  }

  // ---- Basic firewall (replaces the IPv4 input and forward chains)
  if (v.firewall) {
    const fw = cfg.firewall?.ipv4 || {};
    if (fw.input?.filter) del(["firewall", "ipv4", "input", "filter"]);
    if (fw.forward?.filter) del(["firewall", "ipv4", "forward", "filter"]);
    const rule = (chain, n, parts) => {
      const base = ["firewall", "ipv4", chain, "filter", "rule", String(n)];
      for (const [k, val] of parts) set([...base, ...k], val);
    };
    const input = "input";
    set(["firewall", "ipv4", input, "filter", "default-action"], "drop");
    rule(input, 10, [[["action"], "accept"], [["state"], "established"], [["state"], "related"], [["description"], "replies"]]);
    rule(input, 20, [[["action"], "drop"], [["state"], "invalid"]]);
    rule(input, 30, [[["action"], "accept"], [["inbound-interface", "name"], "lo"]]);
    rule(input, 40, [[["action"], "accept"], [["inbound-interface", "name"], lanIf], [["description"], "LAN may reach the router"]]);
    rule(input, 50, [[["action"], "accept"], [["protocol"], "icmp"]]);
    const wgPorts = Object.values(cfg.interfaces?.wireguard || {}).map((w) => w?.port).filter(Boolean);
    wgPorts.forEach((p, i) => rule(input, 60 + i, [[["action"], "accept"], [["protocol"], "udp"], [["destination", "port"], p], [["description"], "WireGuard"]]));
    const fwd = "forward";
    set(["firewall", "ipv4", fwd, "filter", "default-action"], "drop");
    rule(fwd, 10, [[["action"], "accept"], [["state"], "established"], [["state"], "related"]]);
    rule(fwd, 20, [[["action"], "drop"], [["state"], "invalid"]]);
    rule(fwd, 30, [[["action"], "accept"], [["inbound-interface", "name"], lanIf], [["description"], "LAN to anywhere"]]);
    if (Object.keys(cfg.interfaces?.wireguard || {}).length) rule(fwd, 40, [[["action"], "accept"], [["inbound-interface", "name"], "wg*"], [["description"], "VPN clients"]]);
  }
  return { cmds, lanIf, outIf };
}

export function toSetLines(cmds) {
  const q = (s) => (/^[A-Za-z0-9._\/:@*-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);
  return cmds.map((c) => maskSecrets(`${c.op} ${[...c.path, ...(c.value !== undefined ? [c.value] : [])].map(q).join(" ")}`)).join("\n");
}

export async function openQuickSet() {
  const win = openWindow({ key: "quickset", title: "Quick Set", width: 900, height: 560 });
  if (!win.isNew) return;
  let cfg;
  let st;
  try {
    const [c, stats] = await Promise.all([api.getConfig([]), api.interfaceStats()]);
    cfg = c || {};
    st = readState(cfg, stats.links);
  } catch (e) {
    win.close();
    return alertBox("Quick Set", errorText(e));
  }
  if (st.ports.length < 2) {
    win.close();
    return alertBox("Quick Set", `Quick Set needs at least two Ethernet ports (one internet, one LAN). This router has: ${st.ports.join(", ") || "none"}.`);
  }

  const inp = (value = "", attrs = {}) => h("input", { type: "text", value, ...attrs });
  const sel = (options, value) => h("select", options.map((o) => h("option", { value: o.value ?? o, selected: (o.value ?? o) === value }, o.label ?? o)));
  const chk = (checked) => h("input", { type: "checkbox", checked });
  const pool = suggestPool(st.lanAddr);
  const f = {
    wan: sel(st.ports, st.wan),
    mode: sel([{ value: "dhcp", label: "Automatic (DHCP)" }, { value: "static", label: "Static IP" }, { value: "pppoe", label: "PPPoE (DSL/fiber login)" }], st.mode),
    staticAddr: inp(st.staticAddr, { placeholder: "203.0.113.10/24" }),
    gateway: inp(st.gateway, { placeholder: "203.0.113.1" }),
    dns: inp(st.dns || "1.1.1.1 9.9.9.9"),
    pppoeUser: inp(st.pppoeUser),
    pppoePass: h("input", { type: "password", placeholder: st.pppoeUser ? "unchanged" : "" }),
    lanAddr: inp(st.lanAddr),
    dhcp: chk(true),
    poolStart: inp(pool.start),
    poolStop: inp(pool.stop),
    dnsFwd: chk(true),
    nat: chk(true),
    firewall: chk(false),
  };
  const lanBoxes = h("div");
  const renderLan = () => {
    const keep = new Set([...lanBoxes.querySelectorAll("input:checked")].map((c) => c.value));
    lanBoxes.textContent = "";
    for (const p of st.ports.filter((x) => x !== f.wan.value)) {
      const checked = keep.size ? keep.has(p) : st.lanPorts.includes(p);
      lanBoxes.append(h("label", { style: { marginRight: "12px" } }, h("input", { type: "checkbox", value: p, checked }), " ", p));
    }
  };
  renderLan();
  f.wan.addEventListener("change", renderLan);
  f.lanAddr.addEventListener("change", () => {
    const p = suggestPool(f.lanAddr.value);
    f.poolStart.value = p.start;
    f.poolStop.value = p.stop;
  });

  const row = (label, el, hint) => [h("label", label), el, hint ? h("span") : null, hint ? h("span.hint", hint) : null];
  const staticRows = h("div.form", { style: { display: "contents" } }, ...row("WAN address", f.staticAddr), ...row("Gateway", f.gateway), ...row("DNS servers", f.dns));
  const pppoeRows = h("div.form", { style: { display: "contents" } }, ...row("Username", f.pppoeUser), ...row("Password", f.pppoePass));
  const showMode = () => {
    staticRows.hidden = f.mode.value !== "static";
    pppoeRows.hidden = f.mode.value !== "pppoe";
    for (const el of staticRows.children) el.hidden = staticRows.hidden;
    for (const el of pppoeRows.children) el.hidden = pppoeRows.hidden;
  };
  f.mode.addEventListener("change", showMode);

  const errBox = h("div.err-box", { hidden: true });
  const grid = h("div.qs-grid",
    h("div.qs-box", h("h4", "Internet"), h("div.form", ...row("Port", f.wan), ...row("Connection", f.mode), staticRows, pppoeRows)),
    h("div.qs-box", h("h4", "Local network"), h("div.form",
      h("label", "LAN ports"), lanBoxes, h("span"), h("span.hint", "More than one port makes a bridge (br0)."),
      ...row("Router address", f.lanAddr, "The router's address on your LAN, with prefix."))),
    h("div.qs-box", h("h4", "Addresses for devices"), h("div.form",
      h("span"), h("label", { style: { textAlign: "left" } }, f.dhcp, " Hand out addresses (DHCP server)"),
      ...row("Pool start", f.poolStart), ...row("Pool end", f.poolStop),
      h("span"), h("label", { style: { textAlign: "left" } }, f.dnsFwd, " Router answers DNS for devices"))),
    h("div.qs-box", h("h4", "Security"), h("div.form",
      h("span"), h("label", { style: { textAlign: "left" } }, f.nat, " Share the internet connection (NAT)"),
      h("span"), h("label", { style: { textAlign: "left" } }, f.firewall, " Basic firewall"),
      h("span"), h("span.hint", "Blocks everything from the internet except replies; LAN may reach the router and the internet. Replaces existing IPv4 input/forward rules."))),
  );
  win.body.style.overflow = "auto";
  win.body.append(
    h("div.win-toolbar",
      h("button", { style: { fontWeight: "bold" }, on: { click: () => go() } }, "Review & Apply…"),
      h("span.hint", "Nothing changes until you confirm the list of commands. Keep Safe Mode on.")),
    errBox, grid,
  );
  showMode();

  function values() {
    return {
      wan: f.wan.value, mode: f.mode.value, staticAddr: f.staticAddr.value, gateway: f.gateway.value, dns: f.dns.value,
      pppoeUser: f.pppoeUser.value, pppoePass: f.pppoePass.value,
      lanPorts: [...lanBoxes.querySelectorAll("input:checked")].map((c) => c.value),
      lanAddr: f.lanAddr.value, dhcp: f.dhcp.checked, poolStart: f.poolStart.value, poolStop: f.poolStop.value,
      dnsFwd: f.dnsFwd.checked, nat: f.nat.checked, firewall: f.firewall.checked,
    };
  }

  async function go() {
    errBox.hidden = true;
    let res;
    const v = values();
    try {
      res = quickSetCommands(cfg, v);
    } catch (e) {
      errBox.textContent = e.message;
      errBox.hidden = false;
      return;
    }
    if (!res.cmds.length) return setStatus("Quick Set: nothing to change.");
    const host = session.info?.profile.host || "";
    const viaLan = ipv4InCidr(host, parseIpv4Cidr(v.lanAddr)?.network || "0.0.0.0/32") || host === parseIpv4Cidr(v.lanAddr)?.ip;
    const risks = [];
    if (!viaLan) risks.push(`You are connected through ${host}, which is not on the new LAN. Changing ports/addresses${v.firewall ? " or enabling the firewall" : ""} can cut you off.`);
    if (!document.getElementById("safe-mode").checked) risks.push("Safe Mode is OFF. Turn it on so a mistake reverts by itself.");
    const body = h("div", { style: { width: "620px" } },
      risks.length ? h("div.warn-box", risks.map((r) => h("div", "• ", r))) : null,
      h("div.hint", `${res.cmds.length} commands, applied as one commit:`),
      h("pre.out", { style: { maxHeight: "320px" } }, toSetLines(res.cmds)));
    const ok = await modal("Quick Set — review", body, [{ label: "Cancel", value: "cancel" }, { label: "Apply", value: "apply", primary: true }]);
    if (ok !== "apply") return;
    try {
      await applyChanges(res.cmds, "Quick Set");
      const lanIp = parseIpv4Cidr(v.lanAddr)?.ip;
      alertBox("Quick Set applied", `Done. ${document.getElementById("safe-mode").checked ? "Check that you still have access, then press Confirm in the toolbar, then Save." : "Press Save to keep it after a reboot."}${lanIp && lanIp !== host ? `\n\nDevices on the LAN reach the router at ${lanIp}.` : ""}`);
    } catch (e) {
      alertBox("Quick Set failed", errorText(e));
    }
  }
}
