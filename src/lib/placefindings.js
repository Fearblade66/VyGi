// Which Health Check findings are about which item on the simple pages, so a
// problem shows on the network, port forward or VPN it concerns. Pure: finding
// ids name their object (nat:eth3, dnat-dyn:100, wg-port:wg0...).

/**
 * kind: "network" (item { iface, network }), "forward" ({ n }), "vpn" ({ iface }),
 * "internet" (no item). Returns the matching findings, worst first.
 */
export function findingsFor(findings, kind, item = {}) {
  const match = (id) => {
    const [type, a = "", b = ""] = id.split(":");
    switch (kind) {
      case "network":
        return (["nat", "dns"].includes(type) && a === item.iface)
          || (type === "overlap" && (a === item.iface || b === item.iface))
          || (["dhcp-range", "dhcp-gw"].includes(type) && id.slice(type.length + 1) === item.network);
      case "forward":
        return ["dnat-nointernet", "dnat-dyn", "dnat-all"].includes(type) && a === String(item.n);
      case "vpn":
        return ["wg-port", "wg-dup"].includes(type) && a === item.iface;
      case "internet":
        return type === "security" && ["wan-input", "wan-forward6", "dns-open"].includes(a);
      default:
        return false;
    }
  };
  const ORDER = { bad: 0, warn: 1, info: 2 };
  return (findings || []).filter((f) => f?.id && match(f.id)).sort((x, y) => (ORDER[x.level] ?? 3) - (ORDER[y.level] ?? 3));
}
