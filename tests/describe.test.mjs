import { test } from "node:test";
import assert from "node:assert/strict";
import { describeChange, wantsPreview, commandLine } from "../src/lib/describe.js";

const cfg = {
  firewall: { ipv4: { forward: { filter: { rule: { 1: { action: "reject", description: "VyGi rule 1: Bedtime" }, 7: { action: "accept", description: "my ssh" } } } } }, group: { "mac-group": { "VYGI-BLOCKED": { "mac-address": "aa:aa:aa:aa:aa:01" } } } },
  nat: { destination: { rule: { 100: { description: "VyGi fwd 1: Plex" } } } },
};
const F = ["firewall", "ipv4", "forward", "filter", "rule"];

test("describeChange: add, change, on/off, remove, with owners", () => {
  const d = describeChange(cfg, [
    { op: "set", path: [...F, "5", "action"], value: "drop" },
    { op: "set", path: [...F, "5", "description"], value: "VyGi rule 5: No games" },
    { op: "set", path: [...F, "1", "disable"] },
    { op: "set", path: [...F, "7", "action"], value: "drop" },
    { op: "delete", path: ["nat", "destination", "rule", "100"] },
    { op: "delete", path: ["firewall", "group", "mac-group", "VYGI-BLOCKED", "mac-address"], value: "aa:aa:aa:aa:aa:01" },
  ]);
  assert.deepEqual(d.map((x) => [x.verb, x.label, x.name]), [
    ["add", "firewall rule 5 (forward)", "Traffic Rules: No games"],
    ["off", "firewall rule 1 (forward)", "Traffic Rules: Bedtime"],
    ["change", "firewall rule 7 (forward)", "my ssh"],
    ["remove", "port forward rule 100", "Port Forwarding: Plex"],
    ["change", "device list VYGI-BLOCKED", ""],
  ]);
  assert.deepEqual(d[2].details, ["action: drop"]);
  assert.deepEqual(d[4].details, ["mac-address: removed"]);
});

test("describeChange: networks and DHCP", () => {
  const d = describeChange({}, [
    { op: "set", path: ["interfaces", "ethernet", "eth1", "vif", "20", "address"], value: "10.0.20.1/24" },
    { op: "set", path: ["interfaces", "ethernet", "eth1", "vif", "20", "description"], value: "IoT" },
    { op: "set", path: ["service", "dhcp-server", "shared-network-name", "IOT", "subnet", "10.0.20.0/24", "range", "0", "start"], value: "10.0.20.100" },
  ]);
  assert.deepEqual(d.map((x) => [x.verb, x.label, x.name]), [["add", "network eth1.20", "IoT"], ["add", "DHCP server for 10.0.20.0/24", ""]]);
});

test("wantsPreview: toggles, single edits and removals don't, changes to several things do", () => {
  const toggle = [{ op: "set", path: [...F, "1", "disable"] }];
  const unblock = [{ op: "delete", path: ["firewall", "group", "mac-group", "VYGI-BLOCKED", "mac-address"], value: "aa" }];
  const remove = [{ op: "delete", path: ["nat", "destination", "rule", "100"] }];
  const big = Array.from({ length: 9 }, (_, i) => ({ op: "set", path: [...F, String(i), "action"], value: "drop" }));
  assert.equal(wantsPreview("big", toggle), false);
  assert.equal(wantsPreview("big", unblock), false);
  assert.equal(wantsPreview("big", remove), false);
  assert.equal(wantsPreview("big", [...toggle, ...remove, ...unblock]), true);
  assert.equal(wantsPreview("big", big), true);
  assert.equal(wantsPreview("always", toggle), true);
  assert.equal(wantsPreview("never", remove), false);
  assert.equal(commandLine({ op: "set", path: ["system", "host-name"], value: "gw" }), "set system host-name 'gw'");
});
