// Security check: common ways a home router ends up exposed, each with a
// plain explanation and, where it's safe, the commands that fix it.
// Pure: no API calls.
import { toArray, ipv4InCidr } from "./vyos.js";

export const WAN_BLOCK_DESC = "VyGi: block new connections from the internet";
const WAN_BLOCK_RULE = "9900"; // late, so the user's own allow rules (e.g. WireGuard) still run first
const DHCP6_RULE = "9890";

/** True if the rules (or default) already stop new connections from the internet port. */
export function wanBlocked(chain, wan) {
  if (!chain) return false;
  if (chain["default-action"] === "drop" || chain["default-action"] === "reject") return true;
  return Object.values(chain.rule || {}).some((r) => {
    if (!r || "disable" in r || !["drop", "reject"].includes(r.action)) return false;
    const inIf = r["inbound-interface"]?.name;
    const matchesWan = !inIf || inIf === wan;
    const onlyNew = !r.state || toArray(r.state).includes("new");
    const narrow = r.destination || r.source || r.protocol || r["inbound-interface"]?.group;
    return matchesWan && onlyNew && !narrow;
  });
}

/**
 * cfg: full config. ctx: { wan, wanCidr, mgmtHost, defaultPassword, user }.
 * Returns [{ id, level: "bad"|"warn", title, text, fix: [commands] | null, fixLabel, needs }].
 * needs: "password" when the fix needs a new password from the user.
 */
export function securityFindings(cfg, ctx) {
  const out = [];
  const fw = cfg?.firewall || {};

  if (ctx.defaultPassword) {
    out.push({
      id: "password", level: "bad", title: "The router still uses the default password",
      text: `The "${ctx.user}" login still has the password "vyos", which everyone knows. Anyone who can reach the router can log in and change anything.`,
      fix: null, needs: "password", fixLabel: "Change password",
    });
  }

  if (ctx.wan) {
    const open4 = !wanBlocked(fw.ipv4?.input?.filter, ctx.wan);
    const open6 = !wanBlocked(fw.ipv6?.input?.filter, ctx.wan);
    if (open4 || open6) {
      // Don't offer a fix that would cut VyGi off (connected through the internet port).
      const viaWan = ctx.mgmtHost && ctx.wanCidr && ipv4InCidr(ctx.mgmtHost, ctx.wanCidr);
      const cmds = [];
      for (const [fam, open] of [["ipv4", open4], ["ipv6", open6]]) {
        if (!open) continue;
        const b = ["firewall", fam, "input", "filter", "rule", WAN_BLOCK_RULE];
        if (fw[fam]?.input?.filter?.rule?.[WAN_BLOCK_RULE]) cmds.push({ op: "delete", path: b });
        if (fam === "ipv6") {
          // DHCPv6 replies (address / prefix from the provider) answer a multicast request,
          // so they look like new connections: let them in first.
          const d = ["firewall", "ipv6", "input", "filter", "rule", DHCP6_RULE];
          if (fw.ipv6?.input?.filter?.rule?.[DHCP6_RULE]) cmds.push({ op: "delete", path: d });
          cmds.push(
            { op: "set", path: [...d, "action"], value: "accept" },
            { op: "set", path: [...d, "inbound-interface", "name"], value: ctx.wan },
            { op: "set", path: [...d, "protocol"], value: "udp" },
            { op: "set", path: [...d, "destination", "port"], value: "546" },
            { op: "set", path: [...d, "description"], value: "VyGi: DHCPv6 from the provider" },
          );
        }
        cmds.push(
          { op: "set", path: [...b, "action"], value: "drop" },
          { op: "set", path: [...b, "inbound-interface", "name"], value: ctx.wan },
          { op: "set", path: [...b, "state"], value: "new" },
          { op: "set", path: [...b, "description"], value: WAN_BLOCK_DESC },
        );
      }
      out.push({
        id: "wan-input", level: "bad", title: "The router can be reached from the internet",
        text: `Nothing stops new connections from the internet (${ctx.wan}) to the router itself, so anyone can try to log in over SSH or the API.${open4 && !open6 ? "" : open6 && !open4 ? " (IPv6 only.)" : ""} The fix blocks new connections arriving on ${ctx.wan}; replies to your own traffic, port forwards and VPN ports you opened earlier keep working.`,
        fix: viaWan ? null : cmds, fixLabel: "Block it",
        ...(viaWan ? { text: `Nothing stops new connections from the internet (${ctx.wan}) to the router itself. VyGi is connected through ${ctx.wan}, so it won't block this for you: blocking it would cut VyGi off. Connect from your home network and fix it from there.` } : {}),
      });
    }
  }

  const fwd = cfg?.service?.dns?.forwarding;
  const openAllow = toArray(fwd?.["allow-from"]).filter((a) => a === "0.0.0.0/0" || a === "::/0");
  if (openAllow.length) {
    out.push({
      id: "dns-open", level: "warn", title: "The router answers DNS for anyone",
      text: "DNS forwarding allows every address (0.0.0.0/0). If the internet can reach it, your router can be abused in attacks on others. Only your own networks need it.",
      fix: openAllow.map((a) => ({ op: "delete", path: ["service", "dns", "forwarding", "allow-from", a] })), fixLabel: "Allow only my networks",
      ...(toArray(fwd["allow-from"]).length === openAllow.length ? { fix: null, text: "DNS forwarding allows every address (0.0.0.0/0) and no other network is listed, so removing it would stop DNS for your devices. Add your networks in Advanced → IP → DNS, then remove 0.0.0.0/0." } : {}),
    });
  }

  if (cfg?.system?.["config-management"]?.["commit-confirm"]?.action !== "reload") {
    out.push({
      id: "revert-reboot", level: "warn", title: "Safe Mode undoes changes by rebooting",
      text: "When a Safe Mode change isn't confirmed, the router reboots to undo it (the VyOS default). Reloading the previous settings is faster and doesn't drop everyone's connection.",
      fix: [{ op: "set", path: ["system", "config-management", "commit-confirm", "action"], value: "reload" }], fixLabel: "Reload instead",
    });
  }

  return out;
}
