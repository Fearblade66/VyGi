// Port Forwarding (UniFi-style): open a port on the internet side and send it
// to one device. Each forward is a destination-NAT rule described
// "VyGi fwd <id>: <name>", plus a forward-chain accept rule with the same
// description when that chain drops by default. Pure: no API calls.
import { toArray, ipv4InCidr } from "./vyos.js";

const DNAT = ["nat", "destination", "rule"];
const FWD = ["firewall", "ipv4", "forward", "filter", "rule"];
const FW_PATH = (n) => [...FWD, String(n)];
const DESC_RE = /^VyGi fwd (\d+): (.*)$/;
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const SRC_RE = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/;
const PROTOCOLS = ["tcp", "udp", "tcp_udp"];

/** "443" or "8000-8010" -> [from, to] or null. */
export function parsePorts(text) {
  const m = String(text || "").trim().match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  if (a < 1 || b > 65535 || a > b) return null;
  return [a, b];
}

/** Port forwards from the full config (VyGi's and anyone else's). */
export function parseForwards(cfg) {
  const fw = cfg?.firewall?.ipv4?.forward?.filter?.rule || {};
  const out = [];
  for (const [n, r] of Object.entries(cfg?.nat?.destination?.rule || {})) {
    const m = String(r?.description || "").match(DESC_RE);
    const outside = String(r?.destination?.port || "");
    out.push({
      n,
      id: m ? m[1] : null,
      ours: !!m,
      name: m ? m[2] : r?.description || `Rule ${n}`,
      enabled: !("disable" in (r || {})),
      protocol: r?.protocol || "all",
      outside,
      inside: String(r?.translation?.port || outside),
      ip: r?.translation?.address || "",
      from: toArray(r?.source?.address)[0] || "",
      wan: r?.["inbound-interface"]?.name || "",
      fw: m ? Object.entries(fw).find(([, x]) => x?.description === r.description)?.[0] || null : null,
    });
  }
  return out.sort((a, b) => Number(a.n) - Number(b.n));
}

function freeNumber(used, from, to, step = 1) {
  for (let n = from; n <= to; n += step) if (!used.has(n)) return n;
  throw new Error(`No free rule numbers between ${from} and ${to}`);
}

/**
 * Commands to create or replace a forward.
 * spec: { name, protocol, outside, inside, ip, from, enabled, reserve: { network, subnet, mac, name } | null }
 * env: { wan, lans: [cidr] }
 */
export function forwardCommands(cfg, spec, env, existing = null) {
  const name = String(spec.name || "").trim().replace(/['"]/g, "");
  if (!name || name.length > 48) throw new Error("Give the forward a name (up to 48 characters)");
  if (!env.wan) throw new Error("Can't tell which interface is the internet (no default route)");
  if (!PROTOCOLS.includes(spec.protocol)) throw new Error("Choose TCP, UDP or both");
  const out = parsePorts(spec.outside);
  if (!out) throw new Error("Outside port: a number 1-65535 or a range like 8000-8010");
  const insideText = String(spec.inside || "").trim();
  const ins = insideText ? parsePorts(insideText) : out;
  if (!ins) throw new Error("Inside port: a number 1-65535 or a range like 8000-8010");
  if (ins[1] - ins[0] !== out[1] - out[0]) throw new Error("Inside and outside port ranges must be the same size");
  const ip = String(spec.ip || "").trim();
  if (!IP_RE.test(ip)) throw new Error("Choose the device (its IPv4 address)");
  if (env.lans?.length && !env.lans.some((c) => ipv4InCidr(ip, c))) throw new Error(`${ip} isn't on any of the router's local networks`);
  const from = String(spec.from || "").trim();
  if (from && !SRC_RE.test(from)) throw new Error("Allowed from: an address or network like 203.0.113.5 or 203.0.113.0/24, or empty for anyone");

  const portText = (p) => (p[0] === p[1] ? String(p[0]) : `${p[0]}-${p[1]}`);
  const outside = portText(out);
  const inside = portText(ins);
  // Same outside port on the same protocol would shadow one of them.
  const overlaps = (a, b) => a.protocol === "tcp_udp" || b === "tcp_udp" || a.protocol === b;
  for (const f of parseForwards(cfg)) {
    if (existing && f.n === existing.n) continue;
    const p = parsePorts(f.outside);
    if (!f.enabled || !p || (f.wan && f.wan !== env.wan) || (f.from && from)) continue;
    if (p[0] <= out[1] && out[0] <= p[1] && overlaps(f, spec.protocol)) throw new Error(`Outside port ${outside} is already forwarded by "${f.name}"`);
  }

  const cmds = [];
  const set = (path, value) => cmds.push(value === undefined ? { op: "set", path } : { op: "set", path, value });
  const del = (path) => cmds.push({ op: "delete", path });
  const nat = cfg?.nat?.destination?.rule || {};
  const fw = cfg?.firewall?.ipv4?.forward?.filter?.rule || {};
  const usedNat = new Set(Object.keys(nat).map(Number));
  const usedFw = new Set(Object.keys(fw).map(Number));

  let id;
  let n;
  if (existing) {
    id = existing.id;
    n = existing.n;
    del([...DNAT, n]);
    if (existing.fw) {
      del(FW_PATH(existing.fw));
      usedFw.delete(Number(existing.fw));
    }
  } else {
    const ids = new Set(parseForwards(cfg).filter((f) => f.ours).map((f) => Number(f.id)));
    id = String(freeNumber(ids, 1, 999));
    n = String(freeNumber(usedNat, 100, 9990, 10));
  }
  const description = `VyGi fwd ${id}: ${name}`;
  const r = [...DNAT, n];
  set([...r, "inbound-interface", "name"], env.wan);
  set([...r, "protocol"], spec.protocol);
  set([...r, "destination", "port"], outside);
  if (from) set([...r, "source", "address"], from);
  set([...r, "translation", "address"], ip);
  if (inside !== outside) set([...r, "translation", "port"], inside);
  set([...r, "description"], description);
  if (spec.enabled === false) set([...r, "disable"]);

  // The forward chain sees the translated (inside) address and port.
  if (cfg?.firewall?.ipv4?.forward?.filter?.["default-action"] === "drop") {
    const f = String(existing?.fw && !usedFw.has(Number(existing.fw)) ? existing.fw : freeNumber(usedFw, 900, 999));
    const b = FW_PATH(f);
    set([...b, "action"], "accept");
    set([...b, "inbound-interface", "name"], env.wan);
    set([...b, "protocol"], spec.protocol);
    set([...b, "destination", "address"], ip);
    set([...b, "destination", "port"], inside);
    if (from) set([...b, "source", "address"], from);
    set([...b, "description"], description);
    if (spec.enabled === false) set([...b, "disable"]);
  }

  // Keep the device on this address (DHCP reservation).
  if (spec.reserve) {
    const { network, subnet, mac, name: host } = spec.reserve;
    const hostName = String(host || "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || `fwd-${id}`;
    const base = ["service", "dhcp-server", "shared-network-name", network, "subnet", subnet, "static-mapping", hostName];
    set([...base, "mac"], mac);
    set([...base, "ip-address"], ip);
  }
  return cmds;
}


export function deleteForwardCommands(f) {
  return [{ op: "delete", path: [...DNAT, f.n] }, ...(f.fw ? [{ op: "delete", path: FW_PATH(f.fw) }] : [])];
}

export function toggleForwardCommands(f, enabled) {
  const op = enabled ? "delete" : "set";
  return [{ op, path: [...DNAT, f.n, "disable"] }, ...(f.fw ? [{ op, path: [...FW_PATH(f.fw), "disable"] }] : [])];
}

/** Well-known services, to fill the form. */
export const SERVICES = [
  { label: "Web server (HTTPS)", protocol: "tcp", port: "443" },
  { label: "Web server (HTTP)", protocol: "tcp", port: "80" },
  { label: "Minecraft", protocol: "tcp", port: "25565" },
  { label: "Plex", protocol: "tcp", port: "32400" },
  { label: "SSH", protocol: "tcp", port: "22" },
  { label: "WireGuard on a device", protocol: "udp", port: "51820" },
];
