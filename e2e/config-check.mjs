// Does this VyOS version accept what VyGi writes? Builds the settings each
// simple page makes (networks, traffic rules, port forwards, policies, mDNS,
// region blocking, PPPoE + IPv6, a VPN client, …) with VyGi's own code,
// commits them to a real router one after another, and reads them back with
// VyGi's readers. VyOS changes its config syntax now and then; this catches
// it before users do. CI runs it against the newest nightly and an older one.
//
// Each step starts from the last step that worked: it's saved after success,
// and a failed commit (VyOS can leave part of it behind) is undone by
// loading the saved config.
//
// Usage: node e2e/config-check.mjs <router-ip> [api-key]
// SKIP=vlan,vpn skips steps whose name contains those words (sandboxes
// without VLAN support or IPv6 in the kernel).
// The router: e2e/vyos-image (build-image.sh, run-router.sh). It's changed!
import https from "node:https";
import { randomBytes } from "node:crypto";
import { networkCommands, readNetworks, deleteNetworkCommands } from "../src/lib/netplan.js";
import { groupCommands, readGroups } from "../src/lib/devgroups.js";
import { ruleCommands, parseRules, deleteRuleCommands, toggleCommands } from "../src/lib/trafficrules.js";
import { forwardCommands, parseForwards, deleteForwardCommands } from "../src/lib/portfwd.js";
import { policyCommands, checkPolicy, readPolicies } from "../src/lib/policies.js";
import { mdnsCommands, readMdns } from "../src/lib/mdns.js";
import { regionCommands, parseRegions } from "../src/lib/regions.js";
import { protectOn, smoothOn } from "../src/lib/switches.js";
import { readInternet, internetCommands } from "../src/lib/wanconf.js";
import { addClientCommands, readClients } from "../src/lib/vpnclient.js";
import { logBlocksCommands } from "../src/lib/flows.js";
import { blockSetupCommands, blockCommands, readIds } from "../src/lib/ids.js";
import { describeChange } from "../src/lib/describe.js";

const [ip, key = "vygi-test-key"] = process.argv.slice(2);
if (!ip) {
  console.error("usage: node e2e/config-check.mjs <router-ip> [api-key]");
  process.exit(2);
}
// the test router's certificate is self-signed
const agent = new https.Agent({ rejectUnauthorized: false });

function post(endpoint, data) {
  const body = new URLSearchParams({ key, data: JSON.stringify(data) }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({ host: ip, port: 443, path: endpoint, method: "POST", agent, timeout: 180_000, headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(body);
  });
}

const config = async () => (await post("/retrieve", { op: "showConfig", path: [] })).data || {};
const version = async () => {
  const r = await post("/show", { op: "show", path: ["version"] });
  return String(r.data || "").match(/Version:\s*(\S+)/)?.[1] || "?";
};

let failed = 0;
// Docker may hand out the ports in any order: the one with the address we
// reach the router on is management, the others become two LANs and the WAN.
const ifaces = String((await post("/show", { op: "show", path: ["interfaces"] })).data || "")
  .split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => /^eth\d+$/.test(p[0]));
const mgmtPort = ifaces.find((p) => p[1]?.startsWith(`${ip}/`))?.[0];
const [LAN1, LAN2, WAN] = ifaces.map((p) => p[0]).filter((n) => n !== mgmtPort).sort();
if (!mgmtPort || !WAN) {
  console.error(`Need 4 ethernet ports (management + 3); found: ${ifaces.map((p) => p.join(" ")).join(" | ")}`);
  process.exit(2);
}
const env = { wan: WAN, mgmtHost: "", lans: ["10.20.1.0/24", "10.20.2.0/24"] };

const skip = (process.env.SKIP || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const restore = () => post("/config-file", { op: "load", file: "/config/config.boot" });

/** One step: build commands from the current config, commit, then check with a reader. */
async function step(name, build, check) {
  if (skip.some((w) => name.toLowerCase().includes(w))) {
    console.log(`skip ${name}`);
    return;
  }
  let cmds;
  const before = await config();
  try {
    cmds = build(before);
    if (cmds && !Array.isArray(cmds)) cmds = cmds.cmds;
  } catch (e) {
    console.log(`FAIL ${name}: VyGi refused to build it: ${e.message}`);
    failed++;
    return;
  }
  if (!cmds?.length) {
    console.log(`FAIL ${name}: no commands`);
    failed++;
    return;
  }
  describeChange(before, cmds); // the preview must not choke on it either
  const r = await post("/configure", cmds);
  if (!r.success) {
    const why = String(r.error).split("\n").filter((l) => l.trim() && !/perl: warning|LANG|LC_ALL|LANGUAGE|are supported and installed|^\s+File |^\s{4}/.test(l));
    console.log(`FAIL ${name}: VyOS refused the commit\n  ${why.slice(-12).join("\n  ")}`);
    for (const c of cmds.slice(0, 40)) console.log(`    ${c.op} ${c.path.join(" ")}${c.value != null ? ` '${c.value}'` : ""}`);
    failed++;
    const back = await restore();
    if (!back.success) console.log(`  (couldn't load the saved config back: ${String(back.error).slice(0, 200)})`);
    return;
  }
  const after = await config();
  const problem = check ? check(after) : null;
  if (problem) {
    console.log(`FAIL ${name}: committed, but reading it back: ${problem}`);
    failed++;
    return;
  }
  await post("/config-file", { op: "save" });
  console.log(`ok   ${name} (${cmds.length} commands)`);
}

const wgKey = () => randomBytes(32).toString("base64");

console.log(`VyOS ${await version()} at ${ip} (management ${mgmtPort}; LANs ${LAN1}, ${LAN2}; internet ${WAN})`);
env.mgmtHost = ip;
await post("/config-file", { op: "save" });

await step("network: Home with DHCP", (c) => networkCommands(c, { name: "Home", mode: "port", port: LAN1, cidr: "10.20.1.1/24", dhcp: true, poolStart: "10.20.1.100", poolStop: "10.20.1.200", dnsMode: "router", internet: true, isolate: false }, env),
  (c) => (readNetworks(c, WAN).some((n) => n.name === "Home" && n.dhcp) ? null : "Home network with DHCP not found"));
await step("network: IoT, isolated", (c) => networkCommands(c, { name: "IoT", mode: "port", port: LAN2, cidr: "10.20.2.1/24", dhcp: true, poolStart: "10.20.2.100", poolStop: "10.20.2.200", dnsMode: "router", internet: true, isolate: true }, env),
  (c) => (readNetworks(c, WAN).find((n) => n.name === "IoT")?.isolated ? null : "IoT isn't isolated"));
await step("network: Guest VLAN 30", (c) => networkCommands(c, { name: "Guest", mode: "vlan", parent: LAN1, vlan: "30", cidr: "10.20.30.1/24", dhcp: true, poolStart: "10.20.30.100", poolStop: "10.20.30.200", dnsMode: "router", internet: true, isolate: true }, env),
  (c) => (readNetworks(c, WAN).some((n) => n.iface === `${LAN1}.30`) ? null : "eth1.30 not found"));
await step("device group: Kids", (c) => groupCommands(c, { name: "Kids", macs: ["66:9a:59:c1:e6:d7", "3a:5f:c1:9e:00:42"] }),
  (c) => (readGroups(c).some((g) => g.name === "Kids") ? null : "group Kids not found"));
await step("traffic rule: bedtime schedule for Kids", (c) => ruleCommands(c, { name: "Bedtime", block: "internet", targets: "group", group: readGroups(c).find((g) => g.name === "Kids").gname, schedule: "times", days: [0, 1, 2, 3, 4], start: "21:30", stop: "07:00", enabled: true }),
  (c) => (parseRules(c).some((r) => r.name === "Bedtime" && r.schedule.kind === "times") ? null : "rule Bedtime not found"));
await step("traffic rule: block sites for everyone", (c) => ruleCommands(c, { name: "No TikTok", block: "sites", domains: "tiktok.com snapchat.com", targets: "all", schedule: "always", enabled: true }),
  (c) => (parseRules(c).some((r) => r.name === "No TikTok") ? null : "rule No TikTok not found"));
await step("traffic rule: pause and resume", (c) => toggleCommands(parseRules(c).find((r) => r.name === "Bedtime"), false));
await step("port forward: Plex", (c) => forwardCommands(c, { name: "Plex", protocol: "tcp", outside: "32400", inside: "", ip: "10.20.1.20" }, env),
  (c) => (parseForwards(c).some((f) => f.name === "Plex") ? null : "forward Plex not found"));
await step("network access: IoT may reach the NAS on TCP 445", (c) => policyCommands(c, [...readPolicies(c), checkPolicy({ id: "1", name: "IoT to NAS", action: "allow", from: { kind: "net", value: LAN2 }, to: { kind: "device", value: "10.20.1.20" }, protocol: "tcp", ports: "445" })]),
  (c) => (readPolicies(c).some((p) => p.name === "IoT to NAS") ? null : "policy not found"));
await step("device discovery (mDNS) between Home and IoT", (c) => mdnsCommands(c, [LAN1, LAN2]),
  (c) => (readMdns(c).on ? null : "mDNS repeater not on"));
await step("log blocked connections (Flows)", (c) => logBlocksCommands(c));
await step("region blocking: KP", (c) => regionCommands(c, ["kp"]),
  (c) => (parseRegions(c).countries.includes("kp") ? null : "country not found"));
await step("block the internet from reaching the router", (c) => protectOn(c, { wan: WAN, wanCidr: "", mgmtHost: ip, user: "vyos" }));
await step("Smart Queues (CAKE) on the internet port", (c) => smoothOn(c, WAN, 100));
await step("intrusion detection: block an attacker", (c) => [...blockSetupCommands(c), ...blockCommands(c, "198.51.100.66")],
  (c) => (readIds(c).blocked.includes("198.51.100.66") ? null : "address not in the block list"));
await step("VPN client (WireGuard provider)", (c) => addClientCommands(c, { name: "Provider", killSwitch: true, conf: `[Interface]\nPrivateKey = ${wgKey()}\nAddress = 10.64.12.34/32\nDNS = 10.64.0.1\n\n[Peer]\nPublicKey = ${wgKey()}\nAllowedIPs = 0.0.0.0/0\nEndpoint = 203.0.113.10:51820\n` }),
  (c) => (readClients(c).length ? null : "VPN client not found"));
await step("internet: PPPoE on VLAN 35 with IPv6 prefix delegation", (c) => internetCommands(c, readInternet(c, WAN), { port: WAN, vlan: "35", mode: "pppoe", user: "test@isp", password: "secret", ipv6: true, pdLength: "56", pdLans: [LAN1, LAN2] }, [LAN1, LAN2]),
  (c) => (readInternet(c).mode === "pppoe" ? null : "PPPoE not read back"));
await step("remove the port forward", (c) => deleteForwardCommands(parseForwards(c).find((f) => f.name === "Plex")),
  (c) => (parseForwards(c).length ? "forward still there" : null));
await step("remove a traffic rule", (c) => deleteRuleCommands(c, parseRules(c).find((r) => r.name === "No TikTok")),
  (c) => (parseRules(c).some((r) => r.name === "No TikTok") ? "rule still there" : null));
await step("remove the Guest VLAN network", (c) => deleteNetworkCommands(c, readNetworks(c, WAN).find((n) => n.name === "Guest"), env),
  (c) => (readNetworks(c, WAN).some((n) => n.name === "Guest") ? "network still there" : null));

console.log(failed ? `\n${failed} step(s) failed` : "\nall steps ok");
process.exit(failed ? 1 : 0);
