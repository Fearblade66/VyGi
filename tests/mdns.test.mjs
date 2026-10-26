import { test } from "node:test";
import assert from "node:assert/strict";
import { readMdns, mdnsCommands, mdnsGaps } from "../src/lib/mdns.js";
import { simulate } from "../src/lib/doctor.js";

const lines = (cmds) => cmds.map((c) => `${c.op} ${c.path.join(" ")}${c.value != null ? ` ${c.value}` : ""}`);
const cfg0 = () => ({ firewall: { ipv4: { input: { filter: { rule: {
  10: { action: "accept", "inbound-interface": { name: "eth2" }, protocol: "udp", destination: { port: "67,68" }, description: "VyGi net eth2: DHCP" },
  11: { action: "drop", "inbound-interface": { name: "eth2" }, description: "VyGi net eth2: isolate router" },
  12: { action: "accept", description: "my rule" },
} } } } } });

test("repeat between networks; an isolated one gets an exception before its block", () => {
  const cmds = mdnsCommands(cfg0(), ["eth1", "eth2"]);
  const l = lines(cmds);
  assert.ok(l.includes("set service mdns repeater interface eth1") && l.includes("set service mdns repeater interface eth2"));
  assert.ok(l.includes("set firewall ipv4 input filter rule 11 destination port 5353"));
  assert.ok(l.includes("set firewall ipv4 input filter rule 13 action drop"), "block moved past the hand-made rule 12");
  const after = simulate(cfg0(), cmds);
  assert.deepEqual(readMdns(after), { on: true, ifaces: ["eth1", "eth2"], ipVersion: "", manual: false });
  assert.deepEqual(mdnsGaps(after), []);
  assert.deepEqual(mdnsCommands(after, ["eth1", "eth2"]), [], "nothing to do the second time");
  // off: repeater and exception go, the block stays
  const off = simulate(after, mdnsCommands(after, []));
  assert.equal(off.service?.mdns, undefined);
  assert.deepEqual(Object.values(off.firewall.ipv4.input.filter.rule).map((r) => r.description).sort(), ["VyGi net eth2: DHCP", "VyGi net eth2: isolate router", "my rule"]);
});

test("gaps and checks", () => {
  const cfg = cfg0();
  cfg.service = { mdns: { repeater: { interface: ["eth1", "eth2"] } } };
  assert.deepEqual(mdnsGaps(cfg), ["eth2"]);
  assert.throws(() => mdnsCommands(cfg0(), ["eth1"]), /two networks/);
  cfg.service.mdns.repeater["allow-service"] = "_googlecast._tcp";
  assert.equal(readMdns(cfg).manual, true);
});

test("a network without IPv6 makes the repeater IPv4 only", () => {
  const cfg = { interfaces: { ethernet: { eth1: { address: "10.0.1.1/24" }, eth2: { address: "10.0.2.1/24", ipv6: { address: { "no-default-link-local": {} } } } } } };
  const l = lines(mdnsCommands(cfg, ["eth1", "eth2"]));
  assert.ok(l.includes("set service mdns repeater ip-version ipv4"));
  assert.equal(readMdns(simulate(cfg, mdnsCommands(cfg, ["eth1", "eth2"]))).manual, false);
  delete cfg.interfaces.ethernet.eth2.ipv6;
  assert.ok(!lines(mdnsCommands(cfg, ["eth1", "eth2"])).some((x) => x.includes("ip-version")));
});
