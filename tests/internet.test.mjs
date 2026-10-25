import { test } from "node:test";
import assert from "node:assert/strict";
import { dnsState, dnsCommands } from "../src/lib/internet.js";
import { parseLbStatus } from "../src/lib/failover.js";
import { simulate } from "../src/lib/doctor.js";

const base = { service: { dns: { forwarding: { "allow-from": "192.168.1.0/24", "listen-address": "192.168.1.1", system: {} } } } };

test("dns: auto -> preset -> custom -> auto", () => {
  assert.deepEqual(dnsState(base), { forwarding: true, mode: "auto", servers: [] });
  const cf = simulate(base, dnsCommands(base, "cloudflare"));
  assert.equal(dnsState(cf).mode, "cloudflare");
  assert.ok(!("system" in cf.service.dns.forwarding));
  const cu = simulate(cf, dnsCommands(cf, "custom", "9.9.9.9 1.1.1.1"));
  assert.equal(dnsState(cu).mode, "custom");
  assert.deepEqual([...dnsState(cu).servers].sort(), ["1.1.1.1", "9.9.9.9"]);
  const back = simulate(cu, dnsCommands(cu, "auto"));
  assert.deepEqual(dnsState(back), { forwarding: true, mode: "auto", servers: [] });
  assert.throws(() => dnsCommands(base, "custom", "not-an-ip"), /IP addresses/);
  assert.throws(() => dnsCommands({}, "auto"), /forwarding is off/);
  assert.equal(dnsState({ service: { dns: { forwarding: { "allow-from": "x", system: {}, "name-server": { "1.1.1.1": {} } } } } }).mode, "mixed");
});

test("load balancing status", () => {
  const t = "sudo: x\nInterface: eth0\nStatus: active\nLast Status Change: x\nInterface Failures: 0\n\nInterface: eth3\nStatus: failed\nInterface Failures: 3\n";
  assert.deepEqual(parseLbStatus(t), [{ iface: "eth0", up: true, failures: 0 }, { iface: "eth3", up: false, failures: 3 }]);
});
