import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRules, ruleCommands, deleteRuleCommands, toggleCommands, describeSchedule, activeNow } from "../src/lib/trafficrules.js";

const lines = (cmds) => cmds.map((c) => `${c.op} ${c.path.join(" ")}${c.value !== undefined ? ` ${c.value}` : ""}`);
const base = { firewall: { ipv4: { forward: { filter: { "default-action": "accept", rule: { 1: { action: "drop", description: "VyGi: blocked clients" }, 10: { action: "accept" } } } } } } };
const bedtime = { name: "Kids bedtime", block: "internet", targets: "devices", macs: ["AA:BB:CC:DD:EE:01", "aa:bb:cc:dd:ee:02"], schedule: "times", days: [0, 1, 2, 3, 4], start: "22:00", stop: "07:00" };

test("device bedtime rule: mac-group, early rule number, schedule, reject", () => {
  const l = lines(ruleCommands(base, bedtime));
  assert.deepEqual(l, [
    "set firewall group mac-group VYGI-R1 mac-address aa:bb:cc:dd:ee:01",
    "set firewall group mac-group VYGI-R1 mac-address aa:bb:cc:dd:ee:02",
    "set firewall ipv4 forward filter rule 2 source group mac-group VYGI-R1",
    "set firewall ipv4 forward filter rule 2 time starttime 22:00",
    "set firewall ipv4 forward filter rule 2 time stoptime 07:00",
    "set firewall ipv4 forward filter rule 2 time weekdays Sun,Mon,Tue,Wed,Thu",
    "set firewall ipv4 forward filter rule 2 action reject",
    "set firewall ipv4 forward filter rule 2 description VyGi rule 1: Kids bedtime",
  ]);
});

test("site block for a network, always; www added for bare domains", () => {
  const l = lines(ruleCommands(base, { name: "No TikTok", block: "sites", domains: "https://tiktok.com/foo, *.example.org m.facebook.com", targets: "networks", networks: ["192.168.30.0/24"], schedule: "always" }));
  assert.ok(l.includes("set firewall group domain-group VYGI-R1 address tiktok.com"));
  assert.ok(l.includes("set firewall group domain-group VYGI-R1 address www.tiktok.com"));
  assert.ok(l.includes("set firewall group domain-group VYGI-R1 address example.org"));
  assert.ok(l.includes("set firewall group domain-group VYGI-R1 address m.facebook.com"));
  assert.ok(!l.includes("set firewall group domain-group VYGI-R1 address www.m.facebook.com"));
  assert.ok(l.includes("set firewall ipv4 forward filter rule 2 source group network-group VYGI-R1"));
  assert.ok(!l.some((x) => x.includes(" time ")));
});

test("round trip, edit, toggle, delete", () => {
  const cfg = structuredClone(base);
  cfg.firewall.group = { "mac-group": { "VYGI-R1": { "mac-address": ["aa:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:02"] } } };
  cfg.firewall.ipv4.forward.filter.rule[2] = { action: "reject", description: "VyGi rule 1: Kids bedtime", disable: {}, source: { group: { "mac-group": "VYGI-R1" } }, time: { starttime: "22:00", stoptime: "07:00", weekdays: "Sun,Mon,Tue,Wed,Thu" } };
  const [r] = parseRules(cfg);
  assert.equal(r.name, "Kids bedtime");
  assert.equal(r.enabled, false);
  assert.deepEqual(r.targets.macs, ["aa:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:02"]);
  assert.deepEqual(r.schedule, { kind: "times", start: "22:00", stop: "07:00", days: [0, 1, 2, 3, 4] });
  assert.equal(describeSchedule(r.schedule), "Sun–Thu (school nights), 22:00–07:00");
  const edit = lines(ruleCommands(cfg, { ...bedtime, macs: ["aa:bb:cc:dd:ee:03"], schedule: "always" }, r));
  assert.equal(edit[0], "delete firewall ipv4 forward filter rule 2");
  assert.ok(edit.includes("delete firewall group mac-group VYGI-R1"));
  assert.ok(edit.includes("set firewall group mac-group VYGI-R1 mac-address aa:bb:cc:dd:ee:03"));
  assert.ok(edit.includes("set firewall ipv4 forward filter rule 2 description VyGi rule 1: Kids bedtime"));
  assert.deepEqual(lines(toggleCommands(r, true)), ["delete firewall ipv4 forward filter rule 2 disable"]);
  assert.deepEqual(lines(deleteRuleCommands(cfg, r)), ["delete firewall ipv4 forward filter rule 2", "delete firewall group mac-group VYGI-R1"]);
  // the next new rule gets the next id and number
  const next = lines(ruleCommands(cfg, bedtime));
  assert.ok(next.includes("set firewall ipv4 forward filter rule 3 description VyGi rule 2: Kids bedtime"));
});

test("activeNow handles overnight and day ranges", () => {
  const rule = { enabled: true, schedule: { kind: "times", start: "22:00", stop: "07:00", days: [0, 1, 2, 3, 4] } };
  const at = (day, h, m = 0) => new Date(2026, 9, 25 + day, h, m); // 2026-10-25 is a Sunday
  assert.equal(activeNow(rule, at(0, 23)), true);
  assert.equal(activeNow(rule, at(0, 6, 59)), true);
  assert.equal(activeNow(rule, at(0, 7)), false);
  assert.equal(activeNow(rule, at(5, 23)), false); // Friday
  const school = { enabled: true, schedule: { kind: "times", start: "08:00", stop: "15:00", days: [1, 2, 3, 4, 5] } };
  assert.equal(activeNow(school, at(1, 9)), true);
  assert.equal(activeNow(school, at(6, 9)), false);
  assert.equal(activeNow({ ...school, enabled: false }, at(1, 9)), false);
  assert.equal(activeNow({ enabled: true, schedule: { kind: "always" } }), true);
});

test("validation", () => {
  assert.throws(() => ruleCommands(base, { ...bedtime, name: "" }), /name/);
  assert.throws(() => ruleCommands(base, { ...bedtime, macs: [] }), /device/);
  assert.throws(() => ruleCommands(base, { ...bedtime, macs: ["nope"] }), /MAC/);
  assert.throws(() => ruleCommands(base, { ...bedtime, start: "25:00" }), /HH:MM/);
  assert.throws(() => ruleCommands(base, { ...bedtime, days: [] }), /day/);
  assert.throws(() => ruleCommands(base, { ...bedtime, targets: "all" }), /everyone/);
  assert.throws(() => ruleCommands(base, { ...bedtime, block: "sites", domains: "not a domain" }), /domain/);
});
