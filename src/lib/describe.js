// A change (VyOS set/delete commands) in plain words for the preview before
// applying: "Add firewall rule 5 (Traffic Rules: Kids bedtime)", "Turn off
// port forward 3", "Remove the DHCP server for 10.0.3.0/24". Pure: no API calls.
import { ownerOf, ownerText } from "./owner.js";

const get = (node, path) => path.reduce((n, k) => (n == null ? undefined : n[k]), node);

// [pattern over the path, how many path parts name the object, label(parts, desc)]
const OBJECTS = [
  [["firewall", "*", "*", "filter", "rule", "*"], 6, (p) => `${p[1] === "ipv6" ? "IPv6 " : ""}firewall rule ${p[5]} (${p[2]})`],
  [["firewall", "*", "name", "*", "rule", "*"], 6, (p) => `firewall rule ${p[5]} in chain ${p[3]}`],
  [["firewall", "*", "*", "filter"], 4, (p) => `${p[1] === "ipv6" ? "IPv6 " : ""}firewall ${p[2]} chain`],
  [["firewall", "*", "name", "*"], 4, (p) => `firewall chain ${p[3]}`],
  [["firewall", "group", "*", "*"], 4, (p) => `${{ "address-group": "address list", "network-group": "network list", "mac-group": "device list", "domain-group": "site list", "port-group": "port list", "interface-group": "interface list" }[p[2]] || p[2]} ${p[3]}`],
  [["nat", "destination", "rule", "*"], 4, (p) => `port forward rule ${p[3]}`],
  [["nat", "source", "rule", "*"], 4, (p) => `internet sharing (NAT) rule ${p[3]}`],
  [["interfaces", "*", "*", "vif", "*"], 5, (p) => `network ${p[2]}.${p[4]}`],
  [["interfaces", "*", "*"], 3, (p) => `${p[1] === "wireguard" ? "VPN" : p[1] === "bridge" ? "bridge" : p[1] === "pppoe" ? "internet login" : "port"} ${p[2]}`],
  [["service", "dhcp-server", "shared-network-name", "*", "subnet", "*", "static-mapping", "*"], 8, (p) => `fixed IP for ${p[7]}`],
  [["service", "dhcp-server", "shared-network-name", "*", "subnet", "*"], 6, (p) => `DHCP server for ${p[5]}`],
  [["service", "dhcp-server", "shared-network-name", "*"], 4, (p) => `DHCP server ${p[3]}`],
  [["service", "dns", "forwarding"], 3, () => "DNS for devices"],
  [["service", "dns", "dynamic", "name", "*"], 5, (p) => `dynamic DNS ${p[4]}`],
  [["service", "router-advert", "interface", "*"], 4, (p) => `IPv6 addresses on ${p[3]}`],
  [["service", "mdns", "repeater"], 3, () => "device discovery (mDNS)"],
  [["service", "*"], 2, (p) => `service ${p[1]}`],
  [["protocols", "static", "route", "*"], 4, (p) => `route to ${p[3]}`],
  [["qos", "policy", "*", "*"], 4, (p) => `speed policy ${p[3]}`],
  [["qos", "interface", "*"], 3, (p) => `speed policy on ${p[2]}`],
  [["load-balancing", "wan"], 2, () => "backup internet"],
  [["container", "name", "*"], 3, (p) => `container ${p[2]}`],
  [["system", "name-server"], 2, () => "the router's DNS servers"],
  [["system", "host-name"], 2, () => "the router's name"],
  [["system", "*"], 2, (p) => `system ${p[1]}`],
  [["vpn", "*"], 2, (p) => `VPN ${p[1]}`],
];

function objectOf(path) {
  for (const [pat, n, label] of OBJECTS) {
    if (path.length < n) continue;
    if (pat.every((x, i) => x === "*" || x === path[i])) return { key: path.slice(0, n).join("\u0000"), path: path.slice(0, n), label: label(path) };
  }
  const n = Math.min(path.length, 3);
  return { key: path.slice(0, n).join("\u0000"), path: path.slice(0, n), label: path.slice(0, n).join(" ") };
}

/** "set firewall ... rule 5 action drop" -> the readable command line. */
export function commandLine(c) {
  const v = c.value != null ? ` '${c.value}'` : "";
  return `${c.op} ${c.path.join(" ")}${v}`;
}

/**
 * [{ verb: add|change|remove|on|off, label, owner, details: [] }] for `commands`
 * against the current config `cfg` (one entry per object, in first-seen order).
 */
export function describeChange(cfg, commands) {
  const objs = new Map();
  for (const c of commands || []) {
    const o = objectOf(c.path || []);
    if (!objs.has(o.key)) objs.set(o.key, { ...o, cmds: [] });
    objs.get(o.key).cmds.push(c);
  }
  const out = [];
  for (const o of objs.values()) {
    const before = get(cfg, o.path);
    const rest = (c) => c.path.slice(o.path.length);
    const wholeDelete = o.cmds.some((c) => c.op === "delete" && rest(c).length === 0);
    const descCmd = o.cmds.find((c) => c.op === "set" && rest(c).join(" ") === "description");
    const desc = descCmd?.value ?? (before && typeof before === "object" ? before.description : undefined);
    const owner = ownerOf(desc);
    const name = owner ? ownerText(owner) : desc && !String(desc).startsWith("VyGi") ? desc : "";
    let verb;
    if (wholeDelete && !o.cmds.some((c) => c.op === "set")) verb = "remove";
    else if (before === undefined) verb = "add";
    else if (o.cmds.length === 1 && rest(o.cmds[0]).join(" ") === "disable") verb = o.cmds[0].op === "set" ? "off" : "on";
    else verb = "change";
    const details = [];
    if (verb === "change") {
      const seen = new Set();
      for (const c of o.cmds) {
        const r = rest(c);
        if (!r.length || r[0] === "description") continue;
        const field = r.slice(0, 2).join(" ");
        if (seen.has(field)) continue;
        seen.add(field);
        if (r.join(" ") === "disable") details.push(c.op === "set" ? "turned off" : "turned on");
        else if (c.op === "delete") details.push(`${field}: removed`);
        else details.push(`${r.join(" ")}${c.value != null ? `: ${c.value}` : ""}`);
      }
    }
    out.push({ verb, label: o.label, name, details: details.slice(0, 6), more: Math.max(0, details.length - 6) });
  }
  return out;
}

/**
 * Whether to show a change before applying: "big" = it touches several
 * things (a new network, a policy that renumbers rules). Toggles and
 * single edits don't; removals are already confirmed by their page.
 */
export function wantsPreview(mode, commands) {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return commands.length > 8 || new Set(commands.map((c) => objectOf(c.path || []).key)).size > 2;
}
