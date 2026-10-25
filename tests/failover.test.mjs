import { test } from "node:test";
import assert from "node:assert/strict";
import { failoverStatus, failoverOn, failoverOff, failoverLines, backupCandidates } from "../src/lib/failover.js";
import { simulate } from "../src/lib/doctor.js";

const base = {
  interfaces: { ethernet: { eth0: { address: "dhcp" }, eth1: { address: "192.168.1.1/24" }, eth2: {}, eth3: { address: "dhcp" } } },
};

test("backup candidates: free or DHCP ports other than the main line", () => {
  assert.deepEqual(backupCandidates(base, "eth0"), ["eth2", "eth3"]);
});

test("failover on and off round trip", () => {
  const cmds = failoverOn(base, { wan: "eth0", backup: "eth2", mode: "dhcp" });
  const lines = cmds.map((c) => `${c.op} ${c.path.join(" ")}${c.value ? ` ${c.value}` : ""}`);
  assert.ok(lines.includes("set interfaces ethernet eth2 address dhcp"));
  assert.ok(lines.includes("set load-balancing wan interface-health eth0 nexthop dhcp"));
  assert.ok(lines.includes("set load-balancing wan rule 10 interface eth0 weight 10"));
  assert.ok(lines.includes("set load-balancing wan rule 3 destination address 192.168.0.0/16"));
  assert.ok(lines.includes("set firewall ipv4 input filter rule 9901 inbound-interface name eth2"));
  const on = simulate(base, cmds);
  assert.equal(failoverStatus(on), "on");
  assert.deepEqual(failoverLines(on), { main: "eth0", backup: "eth2" });
  const off = simulate(on, failoverOff(on));
  assert.equal(failoverStatus(off), "off");
  assert.equal(off.interfaces.ethernet.eth2.address, undefined);
  assert.equal(off.firewall?.ipv4?.input?.filter?.rule?.["9901"], undefined);
});

test("static main line needs its gateway; hand-made load balancing is left alone", () => {
  const st = { interfaces: { ethernet: { eth0: { address: "203.0.113.2/24" }, eth2: {} } } };
  assert.throws(() => failoverOn(st, { wan: "eth0", backup: "eth2", mode: "dhcp" }), /gateway/);
  const cmds = failoverOn(st, { wan: "eth0", wanGateway: "203.0.113.1", backup: "eth2", mode: "static", cidr: "192.168.8.2/24", gateway: "192.168.8.1" });
  assert.ok(cmds.some((c) => c.path.join(" ") === "load-balancing wan interface-health eth2 nexthop" && c.value === "192.168.8.1"));
  const manual = { ...base, "load-balancing": { wan: { rule: { 5: { failover: {} } } } } };
  assert.equal(failoverStatus(manual), "manual");
  assert.throws(() => failoverOn(manual, { wan: "eth0", backup: "eth2" }), /by hand/);
  assert.deepEqual(failoverOff(manual), []);
});
