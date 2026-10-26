import { test } from "node:test";
import assert from "node:assert/strict";
import { readInternet, internetCommands, retargetWan, describeInternet } from "../src/lib/wanconf.js";
import { simulate } from "../src/lib/doctor.js";

const lines = (cmds) => cmds.map((c) => `${c.op} ${c.path.join(" ")}${c.value != null ? ` ${c.value}` : ""}`);
const base = () => ({
  interfaces: { ethernet: { eth0: { address: "dhcp", description: "WAN" }, eth1: { address: "192.168.1.1/24" }, eth2: { address: "192.168.20.1/24" } } },
  nat: { source: { rule: { 100: { "outbound-interface": { name: "eth0" }, translation: { address: "masquerade" } } } } },
  firewall: { ipv4: { input: { filter: { rule: { 9900: { action: "drop", "inbound-interface": { name: "eth0" } } } } }, forward: { filter: { rule: { 5: { action: "drop", "outbound-interface": { name: "!eth0" } } } } } } },
  qos: { interface: { eth0: { egress: "VYGI-SMOOTH" } } },
  service: { dns: { dynamic: { name: { home: { address: { interface: "eth0" } } } } } },
});

test("reads DHCP, PPPoE over VLAN, and IPv6", () => {
  assert.deepEqual(
    (({ wan, port, vlan, mode, ipv6, manual }) => ({ wan, port, vlan, mode, ipv6, manual }))(readInternet(base(), "eth0")),
    { wan: "eth0", port: "eth0", vlan: "", mode: "dhcp", ipv6: false, manual: false });
  const cfg = base();
  cfg.interfaces.ethernet.eth0 = { vif: { 35: {} } };
  cfg.interfaces.pppoe = { pppoe0: { "source-interface": "eth0.35", authentication: { username: "u@isp", password: "x" }, "dhcpv6-options": { pd: { 0: { length: "56", interface: { eth1: { "sla-id": "1" } } } } } } };
  const c = readInternet(cfg, "pppoe0");
  assert.equal(describeInternet(c), "PPPoE on eth0, VLAN 35, IPv6 /56");
  assert.deepEqual([c.user, c.hasPassword, c.pdLans], ["u@isp", true, ["eth1"]]);
});

test("rules that name the internet interface follow it", () => {
  const l = lines(retargetWan(base(), "eth0", "pppoe0"));
  assert.ok(l.includes("set nat source rule 100 outbound-interface name pppoe0"));
  assert.ok(l.includes("set firewall ipv4 input filter rule 9900 inbound-interface name pppoe0"));
  assert.ok(l.includes("set firewall ipv4 forward filter rule 5 outbound-interface name !pppoe0"));
  assert.ok(l.includes("set qos interface pppoe0 egress VYGI-SMOOTH") && l.includes("delete qos interface eth0"));
  assert.ok(l.includes("set service dns dynamic name home address interface pppoe0"));
  assert.ok(!l.some((x) => x.includes("interfaces")));
});

test("DHCP to PPPoE over VLAN 35 with IPv6, then back", () => {
  const cfg = base();
  const cur = readInternet(cfg, "eth0");
  const { cmds, wan } = internetCommands(cfg, cur, { port: "eth0", vlan: "35", mode: "pppoe", user: "u@isp", password: "pw", ipv6: true, pdLength: "56", pdLans: ["eth1", "eth2"] }, ["eth1", "eth2"]);
  assert.equal(wan, "pppoe0");
  const l = lines(cmds);
  for (const want of [
    "delete interfaces ethernet eth0 address",
    "set interfaces ethernet eth0 vif 35",
    "set interfaces pppoe pppoe0 source-interface eth0.35",
    "set interfaces pppoe pppoe0 authentication password pw",
    "set interfaces pppoe pppoe0 dhcpv6-options pd 0 length 56",
    "set interfaces pppoe pppoe0 dhcpv6-options pd 0 interface eth2 sla-id 2",
    "set interfaces pppoe pppoe0 ipv6 address autoconf",
    "set service router-advert interface eth1 prefix ::/64",
    "set nat source rule 100 outbound-interface name pppoe0",
  ]) assert.ok(l.includes(want), `missing: ${want}\n${l.join("\n")}`);

  const after = simulate(cfg, cmds);
  const cur2 = readInternet(after, "pppoe0");
  assert.equal(describeInternet(cur2), "PPPoE on eth0, VLAN 35, IPv6 /56");
  // same settings again: nothing to do (password kept)
  assert.deepEqual(internetCommands(after, cur2, { port: "eth0", vlan: "35", mode: "pppoe", user: "u@isp", ipv6: true, pdLength: "56", pdLans: ["eth1", "eth2"] }, ["eth1", "eth2"]).cmds, []);

  const back = internetCommands(after, cur2, { port: "eth0", vlan: "", mode: "dhcp", ipv6: false }, ["eth1", "eth2"]);
  const b = lines(back.cmds);
  assert.equal(back.wan, "eth0");
  for (const want of ["delete interfaces pppoe pppoe0", "delete interfaces ethernet eth0 vif 35", "set interfaces ethernet eth0 address dhcp", "delete service router-advert interface eth1", "set nat source rule 100 outbound-interface name eth0"]) {
    assert.ok(b.includes(want), `missing: ${want}\n${b.join("\n")}`);
  }
});

test("fixed address and checks", () => {
  const cfg = base();
  const cur = readInternet(cfg, "eth0");
  const l = lines(internetCommands(cfg, cur, { port: "eth0", mode: "static", staticAddr: "203.0.113.10/24", gateway: "203.0.113.1", dns: "1.1.1.1 9.9.9.9" }).cmds);
  assert.ok(l.includes("set interfaces ethernet eth0 address 203.0.113.10/24") && l.includes("set protocols static route 0.0.0.0/0 next-hop 203.0.113.1") && l.includes("set system name-server 9.9.9.9"));
  assert.throws(() => internetCommands(cfg, cur, { port: "eth0", mode: "static", staticAddr: "203.0.113.10/24", gateway: "10.0.0.1", dns: "1.1.1.1" }), /Gateway/);
  assert.throws(() => internetCommands(cfg, cur, { port: "eth0", vlan: "5000", mode: "dhcp" }), /VLAN/);
  assert.throws(() => internetCommands(cfg, cur, { port: "eth0", mode: "pppoe", user: "u" }), /password/);
  assert.throws(() => internetCommands(cfg, cur, { port: "eth9", mode: "dhcp" }), /port/);
  assert.deepEqual(internetCommands(cfg, cur, { port: "eth0", mode: "dhcp" }).cmds, []);
});
