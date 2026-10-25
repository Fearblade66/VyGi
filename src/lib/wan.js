// The router's internet side: which interface, its address, a Dynamic DNS
// name, and whether the internet can reach the router at all (CGNAT / a
// modem in front). Used to fill in VPN endpoints and warn on port forwards.
import { api } from "./api.js";
import { toArray, ipv4InCidr } from "./vyos.js";

const PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

/** First Dynamic DNS host name, as a full name. Pure. */
export function ddnsName(dynamic) {
  for (const e of Object.values(dynamic?.name || {})) {
    const host = toArray(e?.["host-name"])[0];
    if (!host || host.startsWith("@")) continue;
    if (e?.protocol === "duckdns" && !host.includes(".")) return `${host}.duckdns.org`;
    if (host.includes(".")) return host;
    if (e?.zone) return `${host}.${e.zone}`;
  }
  return "";
}

/** Why the internet can't reach this router directly, or null. Pure. */
export function wanProblem(ip) {
  if (!ip) return null;
  if (ipv4InCidr(ip, "100.64.0.0/10")) return { kind: "cgnat", text: `The router's internet address (${ip}) is a carrier-grade NAT address: your provider shares one public address between customers, so connections from the internet can't reach this router. Ask your provider for a public IPv4 address.` };
  if (PRIVATE.some((c) => ipv4InCidr(ip, c))) return { kind: "double", text: `The router's internet address (${ip}) is a private address, so another router (often the provider's modem) sits in front of it. Forward the same ports on that device to ${ip}, or put it in bridge mode.` };
  return null;
}

/** { wan, wanIp, ddns, endpoint } from the router; endpoint = best address for clients to use. */
export async function wanInfo() {
  const [routes, stats, dynamic] = await Promise.all([
    api.routes(4, "default").catch(() => []),
    api.interfaceStats().catch(() => ({})),
    api.getConfig(["service", "dns", "dynamic"]).catch(() => ({})),
  ]);
  const def = routes.find((r) => r.dst === "default");
  const wan = def?.dev || (def?.nexthops || [])[0]?.dev || "";
  const wanIp = (stats.addrs || []).find((a) => a.ifname === wan)?.addr_info?.find((x) => x.family === "inet")?.local || "";
  const ddns = ddnsName(dynamic);
  return { wan, wanIp, ddns, endpoint: ddns || (wanIp && !wanProblem(wanIp) ? wanIp : "") };
}
