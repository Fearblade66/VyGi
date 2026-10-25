import { test } from "node:test";
import assert from "node:assert/strict";
import { protectStatus, protectOn, protectOff, smoothStatus, smoothOn, smoothOff, adblockStatus } from "../src/lib/switches.js";
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

test("ad blocking status", () => {
  assert.equal(adblockStatus(null), "unavailable");
  assert.equal(adblockStatus({ enableBlocking: true, blockListUrls: ["x"] }), "on");
  assert.equal(adblockStatus({ enableBlocking: true, blockListUrls: [] }), "off");
});
