// The console commands that make a fresh VyOS reachable for VyGi. Pure.
import { parseIpv4Cidr, ipv4InCidr } from "./vyos.js";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** The console commands for a router at `cidr` (e.g. 192.168.1.2/24) behind gateway `gw` on `port`. Pure. */
export function consoleCommands({ cidr, gw, port }) {
  const c = parseIpv4Cidr(cidr);
  if (!c || c.bits < 8 || c.bits > 30) return { error: "Router address: like 192.168.1.2/24 (the address, a slash, and the network size)" };
  if (!IPV4.test(gw || "") || !ipv4InCidr(gw, c.network)) return { error: `Gateway: your main router's address, inside ${c.network}` };
  if (gw === c.ip) return { error: "The gateway is your main router: it can't have the router's own address" };
  if (!/^(eth|enp|ens|eno)[a-z0-9]{0,12}$/.test(port || "")) return { error: "Port: the network port's name on VyOS, usually eth0" };
  return {
    ip: c.ip,
    text: [
      "configure",
      `set interfaces ethernet ${port} address ${cidr}`,
      `set protocols static route 0.0.0.0/0 next-hop ${gw}`,
      `set system name-server ${gw}`,
      "set service ssh",
      "commit",
      "save",
      "exit",
    ].join("\n"),
  };
}
