// Internet settings: which DNS servers the router forwards your devices'
// lookups to (UniFi's "DNS server: Auto / custom"). Pure.
import { toArray } from "./vyos.js";

const FWD = ["service", "dns", "forwarding"];

export const DNS_PRESETS = {
  cloudflare: { label: "Cloudflare (1.1.1.1)", servers: ["1.1.1.1", "1.0.0.1"] },
  quad9: { label: "Quad9 (9.9.9.9, blocks known bad sites)", servers: ["9.9.9.9", "149.112.112.112"] },
  google: { label: "Google (8.8.8.8)", servers: ["8.8.8.8", "8.8.4.4"] },
};

/**
 * { forwarding, mode: "auto"|preset|"custom"|"mixed", servers }.
 * forwarding false: the router doesn't answer DNS for the network.
 * "mixed": the provider's servers plus others (made by hand).
 */
export function dnsState(cfg) {
  const fwd = cfg?.service?.dns?.forwarding;
  if (!fwd || !toArray(fwd["allow-from"]).length) return { forwarding: false, mode: "auto", servers: [] };
  const servers = Object.keys(fwd["name-server"] || {});
  const system = "system" in fwd;
  if (!servers.length) return { forwarding: true, mode: "auto", servers };
  if (system) return { forwarding: true, mode: "mixed", servers };
  const preset = Object.entries(DNS_PRESETS).find(([, p]) => p.servers.length === servers.length && p.servers.every((s) => servers.includes(s)));
  return { forwarding: true, mode: preset ? preset[0] : "custom", servers };
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const validIp = (s) => (IPV4.test(s) && s.split(".").every((n) => Number(n) <= 255)) || (/^[0-9a-f:]+$/i.test(s) && s.includes(":"));

/** Commands to switch to `mode` ("auto", a preset, or "custom" with `custom` = "1.2.3.4 5.6.7.8"). */
export function dnsCommands(cfg, mode, custom = "") {
  const st = dnsState(cfg);
  if (!st.forwarding) throw new Error("The router doesn't answer DNS for your network (DNS forwarding is off)");
  let want;
  if (mode === "auto") want = [];
  else if (DNS_PRESETS[mode]) want = DNS_PRESETS[mode].servers;
  else {
    want = String(custom).split(/[\s,]+/).filter(Boolean);
    if (!want.length || want.some((s) => !validIp(s))) throw new Error("DNS servers: IP addresses separated by spaces, e.g. 1.1.1.1 9.9.9.9");
  }
  const cmds = [];
  for (const s of st.servers) if (!want.includes(s)) cmds.push({ op: "delete", path: [...FWD, "name-server", s] });
  for (const s of want) if (!st.servers.includes(s)) cmds.push({ op: "set", path: [...FWD, "name-server", s] });
  const system = "system" in (cfg.service.dns.forwarding || {});
  if (!want.length && !system) cmds.push({ op: "set", path: [...FWD, "system"] });
  if (want.length && system) cmds.push({ op: "delete", path: [...FWD, "system"] });
  return cmds;
}
