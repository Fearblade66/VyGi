// Security check: common ways a home router ends up exposed, each with a
// plain explanation and, where it's safe, the commands that fix it.
// Pure: no API calls.
import { toArray, ipv4InCidr, flattenInterfaces, parseIpv4Cidr } from "./vyos.js";

const PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

export const WAN_BLOCK_DESC = "VyGi: block new connections from the internet";
const WAN_BLOCK_RULE = "9900"; // late, so the user's own allow rules (e.g. WireGuard) still run first
const DHCP6_RULE = "9890";
export const WAN_FORWARD6_DESC = "VyGi: block new connections from the internet to your networks";

/** Does the router hand out IPv6 to devices (a prefix from the provider, or a LAN with IPv6)? Pure. */
export function usesIpv6(cfg, wan) {
  const ifs = flattenInterfaces(cfg?.interfaces);
  const wanCfg = ifs.get(wan)?.cfg;
  if (wanCfg?.["dhcpv6-options"]?.pd) return true;
  if (Object.keys(cfg?.service?.["router-advert"]?.interface || {}).length) return true;
  for (const [name, c] of ifs) {
    if (name === wan || c.type === "loopback") continue;
    if (toArray(c.cfg.address).some((a) => String(a).includes(":")) || c.cfg.ipv6?.address?.autoconf != null) return true;
  }
  return false;
}

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
 * cfg: full config. ctx: { wan, wanCidr, mgmtHost, defaultPassword, user, vygiAddr }.
 * vygiAddr: the address the router sees VyGi connecting from.
 * Returns [{ id, level: "bad"|"warn", title, text, fix: [commands] | null, fixLabel, needs }].
 * needs: "password" when the fix needs a new password from the user.
 */
export function securityFindings(cfg, ctx) {
  const out = [];
  const fw = cfg?.firewall || {};

  // ---- VyOS itself
  if (ctx.live) {
    out.push({
      id: "live", level: "bad", title: "VyOS isn't installed: it runs from the installer",
      text: "Nothing survives a restart: the router comes back with no addresses, no firewall and the factory password. On the router's console run \"install image\" (accept the defaults and keep the running config), then remove the installer ISO or USB stick and make the disk boot first.",
    });
  }
  if (/rolling/i.test(ctx.version || "")) {
    out.push({
      id: "rolling", level: "warn", title: "A nightly (rolling) VyOS build",
      text: `${ctx.version} is a nightly build: VyOS says it isn't meant for production, and a nightly can break things a release wouldn't. For the router your network depends on, use VyOS Stream (free, released every few months) from vyos.net/get/stream.`,
    });
  }

  // ---- logins with the factory password ("vyos")
  const weak = [...new Set([...(ctx.defaultPassword ? [ctx.user] : []), ...(ctx.defaultUsers || [])])];
  for (const u of weak) {
    const mine = u === ctx.user;
    out.push({
      id: mine ? "password" : `password:${u}`, level: "bad", title: mine ? "The router still uses the default password" : `The "${u}" login still has the default password`,
      text: `The "${u}" login still has the password "vyos", which everyone knows. Anyone who can reach the router can log in and change anything.${mine ? "" : " VyGi doesn't use this login, so it won't remember the new password: keep it somewhere safe."}`,
      fix: null, needs: "password", fixLabel: "Change password", ...(mine ? {} : { user: u }),
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

  // ---- IPv6: devices have public addresses, so without a forward rule the internet reaches them directly
  if (ctx.wan && usesIpv6(cfg, ctx.wan) && !wanBlocked(fw.ipv6?.forward?.filter, ctx.wan)) {
    const b = ["firewall", "ipv6", "forward", "filter", "rule", WAN_BLOCK_RULE];
    out.push({
      id: "wan-forward6", level: "bad", title: "Your devices can be reached from the internet over IPv6",
      text: `Over IPv4, NAT keeps the internet from starting connections to your devices. Over IPv6 every device has its own public address, and nothing stops new connections from ${ctx.wan} to them. The fix blocks new connections from the internet to your networks; your devices' own traffic and its replies keep working.`,
      fix: [
        ...(fw.ipv6?.forward?.filter?.rule?.[WAN_BLOCK_RULE] ? [{ op: "delete", path: b }] : []),
        { op: "set", path: [...b, "action"], value: "drop" },
        { op: "set", path: [...b, "inbound-interface", "name"], value: ctx.wan },
        { op: "set", path: [...b, "state"], value: "new" },
        { op: "set", path: [...b, "description"], value: WAN_FORWARD6_DESC },
      ],
      fixLabel: "Block it",
    });
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

  // ---- the router's HTTPS API (what VyGi uses) open to every address
  const https = cfg?.service?.https;
  if (https && !toArray(https["allow-client"]?.address).length) {
    const lans = [];
    for (const [name, c] of flattenInterfaces(cfg?.interfaces)) {
      if (name === ctx.wan || c.type === "loopback") continue;
      for (const a of toArray(c.cfg.address)) {
        const p = parseIpv4Cidr(a);
        if (p && PRIVATE.some((x) => ipv4InCidr(p.ip, x)) && !lans.includes(p.network)) lans.push(p.network);
      }
    }
    // VyGi's own address must stay allowed, or the fix locks VyGi out
    const me = ctx.vygiAddr && /^\d{1,3}(\.\d{1,3}){3}$/.test(ctx.vygiAddr) ? ctx.vygiAddr : null;
    const allow = [...lans];
    if (me && !lans.some((n) => ipv4InCidr(me, n))) allow.push(`${me}/32`);
    out.push({
      id: "api-open", level: "warn", title: "The router's API accepts every address",
      text: me
        ? `Any address that can reach the router can try API keys against it. The fix only lets in your own networks (${allow.join(", ")}), which includes VyGi at ${me}. If you also use VyGi from elsewhere (another network or a VPN), add that address afterwards. The API restarts, so VyGi pauses for about 30 seconds, and Safe Mode can't undo this change (a VyOS limit).`
        : "Any address that can reach the router can try API keys against it. VyGi couldn't tell which address it connects from, so it won't limit this for you (it could lock itself out). Set Advanced → Services → HTTPS → allow-client to your networks.",
      fix: me ? allow.map((a) => ({ op: "set", path: ["service", "https", "allow-client", "address"], value: a })) : null,
      fixLabel: "Allow only my networks",
    });
  }
  const shortKey = Object.entries(https?.api?.keys?.id || {}).find(([, k]) => String(k?.key || "").length < 16);
  if (shortKey) {
    out.push({
      id: "api-key-short", level: "warn", title: "A short API key",
      text: `The API key "${shortKey[0]}" has fewer than 16 characters, so it's easy to guess. Make a long random one in Advanced → Services → HTTPS (and update it in VyGi's connection settings).`,
    });
  }

  // ---- SSH without brute-force protection
  const ssh = cfg?.service?.ssh;
  if (ssh && !("dynamic-protection" in ssh) && !("disable-password-authentication" in ssh)) {
    out.push({
      id: "ssh-guess", level: "warn", title: "SSH allows unlimited password guesses",
      text: "Anyone who can reach SSH can keep trying passwords. Brute-force protection blocks an address for a while after repeated failed logins.",
      fix: [{ op: "set", path: ["service", "ssh", "dynamic-protection"] }], fixLabel: "Turn on protection",
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
