import { test } from "node:test";
import assert from "node:assert/strict";
import { protectStatus, protectOn, protectOff, countingStatus, smoothStatus, smoothOn, smoothOff, vpnStatus, vpnOff, guestNetwork, adblockStatus } from "../src/lib/switches.js";
import { simulate } from "../src/lib/doctor.js";

const env = { wan: "eth0", wanCidr: "203.0.113.0/24", mgmtHost: "192.168.1.1" };

test("protect: off, VyGi on, hand-made", () => {
  assert.equal(protectStatus({}, env), "off");
  const on = simulate({}, protectOn({}, env));
  assert.equal(protectStatus(on, env), "on");
  assert.equal(protectOff(on).length, 3); // ipv4 + ipv6 + DHCPv6 exception
  const manual = { firewall: { ipv4: { input: { filter: { "default-action": "drop" } } }, ipv6: { input: { filter: { "default-action": "drop" } } } } };
  assert.equal(protectStatus(manual, env), "manual");
  assert.deepEqual(protectOff(manual), []);
});

test("counting", () => {
  assert.equal(countingStatus({}), "off");
  assert.equal(countingStatus({ system: { sysctl: { parameter: { "net.netfilter.nf_conntrack_acct": { value: "1" } } } } }), "on");
});

test("smooth: CAKE below the upload speed, never over a hand-made policy", () => {
  const cmds = smoothOn({}, "eth0", 100);
  assert.ok(cmds.some((c) => c.path.join(" ") === "qos policy cake VYGI-SMOOTH bandwidth" && c.value === "90mbit"));
  const on = simulate({}, cmds);
  assert.equal(smoothStatus(on, "eth0"), "on");
  assert.deepEqual(smoothOff(on).map((c) => c.path.join(" ")), ["qos"]);
  // other shaping stays: only VyGi's parts go, without leaving empty nodes
  const mixed = simulate(on, [{ op: "set", path: ["qos", "policy", "shaper", "MINE", "bandwidth"], value: "10mbit" }, { op: "set", path: ["qos", "interface", "eth1", "egress"], value: "MINE" }]);
  assert.deepEqual(smoothOff(mixed).map((c) => c.path.join(" ")), ["qos interface eth0", "qos policy cake"]);
  const manual = { qos: { interface: { eth0: { egress: "MY-SHAPER" } } } };
  assert.equal(smoothStatus(manual, "eth0"), "manual");
  assert.throws(() => smoothOn(manual, "eth0", 100), /set up by hand/);
  assert.throws(() => smoothOn({}, "eth0", 0), /upload speed/);
});

test("vpn removal only takes VyGi's rules", () => {
  const cfg = {
    interfaces: { wireguard: { wg0: { port: "51820", description: "WireGuard VPN" }, wg1: { port: "51821" } } },
    firewall: { ipv4: { input: { filter: { rule: { 10: { description: "WireGuard wg0" }, 20: { description: "my ssh" } } } } } },
    nat: { source: { rule: { 100: { description: "WireGuard wg0 to internet" }, 110: { description: "LAN" } } } },
  };
  assert.deepEqual(vpnOff(cfg).map((c) => c.path.join(" ")), ["interfaces wireguard wg0", "firewall ipv4 input filter rule 10", "nat source rule 100"]);
  assert.equal(vpnStatus(cfg), "on");
  assert.equal(vpnStatus({ interfaces: { wireguard: { wg1: {} } } }), "manual");
  assert.equal(vpnStatus({}), "off");
});

test("guest network and ad blocking status", () => {
  const nets = [{ iface: "eth1.30", name: "Guest" }, { iface: "eth1", name: "LAN" }];
  assert.deepEqual(guestNetwork(nets, { firewall: { ipv4: { forward: { filter: { rule: { 1: { description: "VyGi net eth1.30: isolate (out)" } } } } } } }).ours, true);
  assert.equal(guestNetwork(nets, {}).ours, false);
  assert.equal(guestNetwork([{ iface: "eth1", name: "LAN" }], {}), null);
  assert.equal(adblockStatus(null), "unavailable");
  assert.equal(adblockStatus({ enableBlocking: true, blockListUrls: ["x"] }), "on");
  assert.equal(adblockStatus({ enableBlocking: true, blockListUrls: [] }), "off");
});
