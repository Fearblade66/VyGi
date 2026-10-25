import { test } from "node:test";
import assert from "node:assert/strict";
import { readGroups, groupCommands, deleteGroupCommands, groupsOf, groupQueueCommands } from "../src/lib/devgroups.js";
import { parseRules, ruleCommands } from "../src/lib/trafficrules.js";
import { parseQueues } from "../src/lib/queues.js";
import { simulate, diagnose } from "../src/lib/doctor.js";

const A = "aa:aa:aa:aa:aa:01";
const B = "aa:aa:aa:aa:aa:02";
const C = "aa:aa:aa:aa:aa:03";

test("create, edit and read a group", () => {
  const { id, cmds } = groupCommands({}, { name: "Kids", macs: [A, B.toUpperCase()] });
  assert.equal(id, "1");
  let cfg = simulate({}, cmds);
  let [g] = readGroups(cfg);
  assert.deepEqual([g.name, g.gname, g.macs, g.limit], ["Kids", "VYGI-G1", [A, B], null]);
  cfg = simulate(cfg, groupCommands(cfg, { name: "Kids", macs: [B, C], limit: { downKbit: 10000, upKbit: null } }, g).cmds);
  [g] = readGroups(cfg);
  assert.deepEqual(g.macs.sort(), [B, C]);
  assert.deepEqual(g.limit, { downKbit: 10000, upKbit: null });
  assert.equal(groupsOf(readGroups(cfg), C.toUpperCase()).length, 1);
  assert.throws(() => groupCommands(cfg, { name: "kids", macs: [A] }), /already a group/);
  assert.throws(() => groupCommands(cfg, { name: "X", macs: [] }), /at least one/);
});

test("rules use groups and keep them", () => {
  let cfg = simulate({}, groupCommands({}, { name: "Kids", macs: [A] }).cmds);
  cfg = simulate(cfg, ruleCommands(cfg, { name: "Bedtime", block: "internet", targets: "group", group: "VYGI-G1", schedule: "always" }));
  const [r] = parseRules(cfg);
  assert.deepEqual(r.targets, { kind: "group", group: "VYGI-G1", macs: [], networks: [] });
  assert.equal(cfg.firewall.ipv6.forward.filter.rule[r.n6].source.group["mac-group"], "VYGI-G1");
  const g = readGroups(cfg)[0];
  assert.throws(() => deleteGroupCommands(cfg, g), /Bedtime/);
  // editing the rule doesn't delete the shared group
  const again = ruleCommands(cfg, { name: "Bedtime", block: "internet", targets: "group", group: "VYGI-G1", schedule: "always" }, r);
  assert.ok(!again.some((c) => c.op === "delete" && c.path.includes("VYGI-G1")));
  assert.throws(() => ruleCommands(cfg, { name: "x", block: "internet", targets: "group", group: "NOPE", schedule: "always" }), /device group/);
});

test("group speed limits: members with fixed IPs get a queue each", () => {
  const base = {
    service: { "dhcp-server": { "shared-network-name": { LAN: { subnet: { "192.168.1.0/24": { "static-mapping": { tablet: { mac: A, "ip-address": "192.168.1.50" }, laptop: { mac: B, "ip-address": "192.168.1.51" } } } } } } } },
  };
  const nets = [{ iface: "eth1", cidr: "192.168.1.0/24" }];
  let cfg = simulate(base, groupCommands(base, { name: "Kids", macs: [A, B, C], limit: { downKbit: 10000, upKbit: 2000 } }).cmds);
  let g = readGroups(cfg)[0];
  const { cmds, skipped } = groupQueueCommands(cfg, g, nets);
  assert.deepEqual(skipped, [C]);
  cfg = simulate(cfg, cmds);
  let rows = parseQueues(cfg.qos);
  assert.deepEqual(rows.map((r) => [r.ip, r.down, r.up, r.name]), [["192.168.1.50", "10000kbit", "2000kbit", "G1 Kids: tablet"], ["192.168.1.51", "10000kbit", "2000kbit", "G1 Kids: laptop"]]);
  // nothing to do when already in sync
  assert.deepEqual(groupQueueCommands(cfg, g, nets).cmds, []);
  // drop a member and the limit's upload part
  cfg = simulate(cfg, groupCommands(cfg, { name: "Kids", macs: [A], limit: { downKbit: 10000, upKbit: null } }, g).cmds);
  g = readGroups(cfg)[0];
  cfg = simulate(cfg, groupQueueCommands(cfg, g, nets).cmds);
  rows = parseQueues(cfg.qos);
  assert.deepEqual(rows.map((r) => [r.ip, r.down, r.up]), [["192.168.1.50", "10000kbit", ""]]);
  // no limit: all the group's queues go, and the qos tree with them
  cfg = simulate(cfg, groupCommands(cfg, { name: "Kids", macs: [A], limit: null }, g).cmds);
  g = readGroups(cfg)[0];
  cfg = simulate(cfg, groupQueueCommands(cfg, g, nets).cmds);
  assert.deepEqual(parseQueues(cfg.qos || {}), []);
});

test("an unused device group isn't a leftover", () => {
  const cfg = simulate({}, groupCommands({}, { name: "Kids", macs: [A] }).cmds);
  assert.ok(!diagnose(cfg, {}).some((f) => f.id.startsWith("leftover-group")));
});
