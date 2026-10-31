import { test } from "node:test";
import assert from "node:assert/strict";
import { readQuarantine, quarantineCommands, approveCommands, revokeCommands, isQuarantined, KNOWN } from "../src/lib/quarantine.js";

const lines = (cmds) => cmds.map((c) => `${c.op} ${c.path.join(" ")}${c.value !== undefined ? ` ${c.value}` : ""}`);
const A = "aa:bb:cc:00:00:01";
const B = "aa:bb:cc:00:00:02";

test("turning on approves the known devices and drops the rest, IPv4 and IPv6", () => {
  const cfg = { firewall: { ipv4: { forward: { filter: { rule: { 1: { action: "drop" } } } } } } };
  const l = lines(quarantineCommands(cfg, ["eth2"], [A.toUpperCase(), A, "junk"]));
  assert.ok(l.includes(`set firewall group mac-group ${KNOWN} mac-address ${A}`));
  assert.equal(l.filter((x) => x.includes("mac-address")).length, 1);
  assert.ok(l.includes("set firewall ipv4 forward filter rule 2 source group mac-group !VYGI-KNOWN"));
  assert.ok(l.includes("set firewall ipv4 forward filter rule 2 inbound-interface name eth2"));
  assert.ok(l.includes("set firewall ipv6 forward filter rule 1 description VyGi quarantine (eth2)"));
});

test("refuses an empty approved list (everyone would be cut off)", () => {
  assert.throws(() => quarantineCommands({}, ["eth2"], []), /No devices to approve/);
});

const on = {
  firewall: {
    group: { "mac-group": { [KNOWN]: { "mac-address": [A, B] } } },
    ipv4: { forward: { filter: { rule: { 3: { description: "VyGi quarantine (eth2)" }, 4: { description: "VyGi quarantine (eth3.20)" } } } } },
    ipv6: { forward: { filter: { rule: { 1: { description: "VyGi quarantine (eth2)" } } } } },
  },
};

test("reads back, changes networks, turns off keeping approvals", () => {
  const q = readQuarantine(on);
  assert.deepEqual(q.ifaces, ["eth2", "eth3.20"]);
  assert.deepEqual(q.known, [A, B]);
  assert.ok(isQuarantined(q, "AA:BB:CC:00:00:09", "eth2"));
  assert.ok(!isQuarantined(q, A, "eth2"));
  assert.ok(!isQuarantined(q, "aa:bb:cc:00:00:09", "eth4"));
  assert.deepEqual(lines(quarantineCommands(on, ["eth2"])), ["delete firewall ipv4 forward filter rule 4"]);
  assert.deepEqual(lines(quarantineCommands(on, [])), [
    "delete firewall ipv4 forward filter rule 3", "delete firewall ipv4 forward filter rule 4", "delete firewall ipv6 forward filter rule 1",
  ]);
  const l = lines(quarantineCommands(on, ["eth2", "eth3.20", "eth4"]));
  assert.ok(l.includes("set firewall ipv6 forward filter rule 2 inbound-interface name eth3.20"));
  assert.ok(l.includes("set firewall ipv4 forward filter rule 1 inbound-interface name eth4"));
  assert.throws(() => quarantineCommands(on, ["eth2; reboot"]), /Bad interface/);
});

test("approve and revoke", () => {
  assert.deepEqual(lines(approveCommands(on, "AA:BB:CC:00:00:09")), [`set firewall group mac-group ${KNOWN} mac-address aa:bb:cc:00:00:09`]);
  assert.deepEqual(approveCommands(on, A), []);
  assert.throws(() => approveCommands(on, ""), /no MAC/);
  assert.deepEqual(lines(revokeCommands(on, B)), [`delete firewall group mac-group ${KNOWN} mac-address ${B}`]);
  const one = structuredClone(on);
  one.firewall.group["mac-group"][KNOWN]["mac-address"] = A;
  assert.throws(() => revokeCommands(one, A), /last approved/);
});
