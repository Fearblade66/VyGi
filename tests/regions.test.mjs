import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRegions, regionCommands, COUNTRY_CODES } from "../src/lib/regions.js";

const lines = (cmds) => cmds.map((c) => `${c.op} ${c.path.join(" ")}${c.value !== undefined ? ` ${c.value}` : ""}`);
const base = { firewall: { ipv4: { input: { filter: { rule: { 1: { action: "accept" } } } } } } };

test("blocks both directions in IPv4 and IPv6, early rule numbers", () => {
  const l = lines(regionCommands(base, ["KP", "ru", "kp"]));
  assert.ok(l.includes("set firewall ipv4 input filter rule 2 source geoip country-code kp"));
  assert.ok(l.includes("set firewall ipv4 input filter rule 2 source geoip country-code ru"));
  assert.ok(l.includes("set firewall ipv4 forward filter rule 1 source geoip country-code kp"));
  assert.ok(l.includes("set firewall ipv4 forward filter rule 2 destination geoip country-code ru"));
  assert.ok(l.includes("set firewall ipv6 forward filter rule 2 description VyGi region block (out)"));
  assert.ok(l.includes("set firewall ipv6 input filter rule 1 action drop"));
  assert.equal(l.filter((x) => x.endsWith("action drop")).length, 6);
});

test("round trip, change and turn off", () => {
  const cfg = structuredClone(base);
  cfg.firewall.ipv4.forward = { filter: { rule: { 1: { action: "drop", description: "VyGi region block (in)", source: { geoip: { "country-code": ["kp", "ru"] } } }, 2: { action: "drop", description: "VyGi region block (out)", destination: { geoip: { "country-code": "kp" } } } } } };
  const r = parseRegions(cfg);
  assert.deepEqual(r.countries, ["kp", "ru"]);
  assert.equal(r.rules.length, 2);
  assert.deepEqual(lines(regionCommands(cfg, [])), ["delete firewall ipv4 forward filter rule 1", "delete firewall ipv4 forward filter rule 2"]);
  const l = lines(regionCommands(cfg, ["cn"]));
  assert.ok(l.includes("set firewall ipv4 forward filter rule 1 source geoip country-code cn")); // reuses freed numbers
  assert.throws(() => regionCommands(cfg, ["xx"]), /Unknown country/);
  assert.equal(COUNTRY_CODES.length, 249);
});
