// Simple switches: plain on/off options that each manage a set of VyOS
// settings. A switch is "on", "off", or "manual" when the same thing was set
// up by hand (Advanced, the CLI): then VyGi shows it but leaves it alone.
// Pure: status and commands from the config; dialogs live in simple_view.js.
import { toArray } from "./vyos.js";
import { securityFindings, WAN_BLOCK_DESC } from "./secure.js";

export const SMOOTH_POLICY = "VYGI-SMOOTH";
const ACCT = ["system", "sysctl", "parameter", "net.netfilter.nf_conntrack_acct"];

// ---- keep the internet out of the router

export function protectStatus(cfg, env) {
  const open = securityFindings(cfg, env).some((f) => f.id === "wan-input");
  if (open) return "off";
  const ours = ["ipv4", "ipv6"].some((fam) => Object.values(cfg?.firewall?.[fam]?.input?.filter?.rule || {}).some((r) => r?.description === WAN_BLOCK_DESC));
  return ours ? "on" : "manual";
}

export function protectOn(cfg, env) {
  return securityFindings(cfg, env).find((f) => f.id === "wan-input")?.fix || null;
}

export function protectOff(cfg) {
  const cmds = [];
  for (const fam of ["ipv4", "ipv6"]) {
    for (const [n, r] of Object.entries(cfg?.firewall?.[fam]?.input?.filter?.rule || {})) {
      if (r?.description === WAN_BLOCK_DESC || r?.description === "VyGi: DHCPv6 from the provider") cmds.push({ op: "delete", path: ["firewall", fam, "input", "filter", "rule", n] });
    }
  }
  return cmds;
}

// ---- count data per device (connection accounting)

export function countingStatus(cfg) {
  return String(cfg?.system?.sysctl?.parameter?.["net.netfilter.nf_conntrack_acct"]?.value) === "1" ? "on" : "off";
}
export const countingOn = () => [{ op: "set", path: [...ACCT, "value"], value: "1" }];
export const countingOff = () => [{ op: "delete", path: ACCT }];

// ---- smooth gaming and video calls (CAKE on the internet port's upload)

export function smoothStatus(cfg, wan) {
  const egress = cfg?.qos?.interface?.[wan]?.egress;
  if (!egress) return "off";
  return egress === SMOOTH_POLICY ? "on" : "manual";
}

/** Upload speed in Mbit/s -> commands. Shapes a little below the line's speed so the queue stays in the router. */
export function smoothOn(cfg, wan, uploadMbit) {
  const mbit = Math.floor(Number(uploadMbit) * 0.9);
  if (!wan) throw new Error("Can't tell which port is the internet");
  if (!Number.isFinite(mbit) || mbit < 1) throw new Error("Enter your upload speed in Mbit/s (run the speed test on the Dashboard if you're not sure)");
  if (cfg?.qos?.interface?.[wan]?.egress && cfg.qos.interface[wan].egress !== SMOOTH_POLICY) {
    throw new Error(`${wan} already has a traffic policy (${cfg.qos.interface[wan].egress}) set up by hand`);
  }
  const p = ["qos", "policy", "cake", SMOOTH_POLICY];
  return [
    ...(cfg?.qos?.policy?.cake?.[SMOOTH_POLICY] ? [{ op: "delete", path: p }] : []),
    { op: "set", path: [...p, "bandwidth"], value: `${mbit}mbit` },
    { op: "set", path: [...p, "description"], value: "VyGi: smooth gaming and video calls" },
    { op: "set", path: ["qos", "interface", wan, "egress"], value: SMOOTH_POLICY },
  ];
}

/** Removes VyGi's shaping; deletes whole qos nodes when nothing else is in them, so no empty ones stay. */
export function smoothOff(cfg) {
  const qos = cfg?.qos || {};
  const ifaces = Object.entries(qos.interface || {}).filter(([, c]) => c?.egress === SMOOTH_POLICY && Object.keys(c).length === 1).map(([i]) => i);
  const othersIf = Object.keys(qos.interface || {}).some((i) => !ifaces.includes(i));
  const othersPol = Object.entries(qos.policy || {}).some(([t, ps]) => Object.keys(ps || {}).some((n) => !(t === "cake" && n === SMOOTH_POLICY)));
  const othersTop = Object.keys(qos).some((k) => k !== "interface" && k !== "policy");
  if (qos.policy?.cake?.[SMOOTH_POLICY] && !othersIf && !othersPol && !othersTop) return [{ op: "delete", path: ["qos"] }];
  const cmds = [];
  for (const [i, c] of Object.entries(qos.interface || {})) {
    if (c?.egress !== SMOOTH_POLICY) continue;
    cmds.push({ op: "delete", path: ifaces.includes(i) ? ["qos", "interface", i] : ["qos", "interface", i, "egress"] });
  }
  if (qos.policy?.cake?.[SMOOTH_POLICY]) {
    const lone = Object.keys(qos.policy.cake).length === 1;
    cmds.push({ op: "delete", path: lone && Object.keys(qos.policy).length === 1 ? ["qos", "policy"] : lone ? ["qos", "policy", "cake"] : ["qos", "policy", "cake", SMOOTH_POLICY] });
  }
  return cmds;
}

export function smoothBandwidth(cfg) {
  return cfg?.qos?.policy?.cake?.[SMOOTH_POLICY]?.bandwidth || "";
}

// ---- remote access (WireGuard VPN)

const VPN_DESC = "WireGuard VPN"; // set by Quick Setup
const ourVpns = (cfg) => Object.entries(cfg?.interfaces?.wireguard || {}).filter(([, c]) => c?.description === VPN_DESC).map(([i]) => i);

/** "on" when Quick Setup made a VPN, "manual" when only hand-made ones exist. */
export function vpnStatus(cfg) {
  if (ourVpns(cfg).length) return "on";
  return Object.keys(cfg?.interfaces?.wireguard || {}).length ? "manual" : "off";
}

/** Removes the VPNs Quick Setup made: the interfaces and the rules it added. Hand-made ones stay. */
export function vpnOff(cfg) {
  const cmds = [];
  for (const iface of ourVpns(cfg)) {
    cmds.push({ op: "delete", path: ["interfaces", "wireguard", iface] });
    const mine = (d) => d === `WireGuard ${iface}` || d === `WireGuard ${iface} to internet` || d === `VyGi: WireGuard ${iface}`;
    for (const [n, r] of Object.entries(cfg?.firewall?.ipv4?.input?.filter?.rule || {})) if (mine(String(r?.description || ""))) cmds.push({ op: "delete", path: ["firewall", "ipv4", "input", "filter", "rule", n] });
    for (const [n, r] of Object.entries(cfg?.nat?.source?.rule || {})) if (mine(String(r?.description || ""))) cmds.push({ op: "delete", path: ["nat", "source", "rule", n] });
  }
  return cmds;
}

// ---- guest network

/** The guest network, if any: { net, ours } (ours = made by VyGi, so it can be removed). */
export function guestNetwork(nets, cfg) {
  const net = nets.find((n) => /guest/i.test(n.name));
  if (!net) return null;
  const ours = Object.values(cfg?.firewall?.ipv4?.forward?.filter?.rule || {}).some((r) => String(r?.description || "").startsWith(`VyGi net ${net.iface}:`));
  return { net, ours };
}

// ---- ad blocking (Technitium)

export const BLOCKLISTS = [
  "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
];

/** settings: Technitium's settings/get response, or null when no DNS server is linked. */
export function adblockStatus(settings) {
  if (!settings) return "unavailable";
  return settings.enableBlocking && toArray(settings.blockListUrls).length ? "on" : "off";
}
