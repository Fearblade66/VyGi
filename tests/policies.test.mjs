import { test } from "node:test";
import assert from "node:assert/strict";
import { readPolicies, policyCommands, checkPolicy, reach, misplacedPolicies, nextPolicyId } from "../src/lib/policies.js";
import { simulate } from "../src/lib/doctor.js";

const lines = (cmds) => cmds.map((c) => `${c.op} ${c.path.join(" ")}${c.value != null ? ` ${c.value}` : ""}`);
const cfg0 = () => ({
  firewall: { ipv4: { forward: { filter: { rule: {
    1: { action: "drop", "inbound-interface": { name: "eth2" }, destination: { group: { "network-group": "VYGI-LOCAL" } }, state: "new", description: "VyGi net eth2: isolate (out)" },
    2: { action: "drop", "outbound-interface": { name: "eth2" }, source: { group: { "network-group": "VYGI-LOCAL" } }, state: "new", description: "VyGi net eth2: isolate (in)" },
    5: { action: "accept", description: "my own rule" },
    900: { action: "accept", description: "VyGi net eth1: internet" },
  } } } } },
});
const nasPolicy = { id: "1", name: "IoT to NAS", action: "allow", from: { kind: "net", value: "eth2" }, to: { kind: "device", value: "192.168.1.20" }, protocol: "tcp", ports: "445" };

test("a new allow policy goes first; VyGi rules move after it, hand-made rules stay", () => {
  const cmds = policyCommands(cfg0(), [checkPolicy(nasPolicy)]);
  const l = lines(cmds);
  assert.ok(l.includes("set firewall ipv4 forward filter rule 1 action accept"));
  assert.ok(l.includes("set firewall ipv4 forward filter rule 1 destination port 445"));
  assert.ok(l.includes("set firewall ipv4 forward filter rule 2 description VyGi net eth2: isolate (out)"));
  assert.ok(l.includes("set firewall ipv4 forward filter rule 3 description VyGi net eth2: isolate (in)"));
  assert.ok(!l.some((x) => / rule 5 /.test(x) || / rule 900 /.test(x)), "hand-made and late rules untouched");
  assert.ok(!l.some((x) => x.includes("ipv6")), "to a device: IPv4 only");

  const after = simulate(cfg0(), cmds);
  const ps = readPolicies(after);
  assert.equal(ps.length, 1);
  assert.deepEqual([ps[0].name, ps[0].action, ps[0].from, ps[0].to, ps[0].ports], ["IoT to NAS", "allow", { kind: "net", value: "eth2" }, { kind: "device", value: "192.168.1.20" }, "445"]);
  // applying the same list again changes nothing
  assert.deepEqual(policyCommands(after, ps), []);
  assert.deepEqual(misplacedPolicies(after), []);

  // removing it packs the other rules back down
  const back = simulate(after, policyCommands(after, []));
  assert.deepEqual(Object.keys(back.firewall.ipv4.forward.filter.rule).sort((a, b) => a - b), ["1", "2", "5", "900"]);
});

test("network-to-network policies cover IPv6 too; grid and order checks", () => {
  const p = checkPolicy({ id: "2", name: "Kids no NAS", action: "block", from: { kind: "group", value: "VYGI-G1" }, to: { kind: "net", value: "eth1" }, protocol: "any", ports: "" });
  const l = lines(policyCommands(cfg0(), [p]));
  assert.ok(l.includes("set firewall ipv6 forward filter rule 1 source group mac-group VYGI-G1"));
  assert.ok(l.includes("set firewall ipv4 forward filter rule 1 state new"));
  const nets = { lan: { iface: "eth1", isolated: false }, iot: { iface: "eth2", isolated: true } };
  const pol = [{ ...nasPolicy, to: { kind: "net", value: "eth1" } }];
  assert.deepEqual([reach(nets.iot, nets.lan, pol).allowed, reach(nets.iot, nets.lan, pol).exceptions.length], [false, 1]);
  assert.equal(reach(nets.lan, nets.lan, []).allowed, true);
  // a policy to one device counts as an exception for that device's network
  assert.equal(reach({ ...nets.iot }, { iface: "eth1", network: "192.168.1.0/24", isolated: false }, [nasPolicy]).exceptions.length, 1);
  // an allow placed after an isolation rule is reported
  const bad = cfg0();
  bad.firewall.ipv4.forward.filter.rule[7] = { action: "accept", description: "VyGi policy 3: late" };
  assert.deepEqual(misplacedPolicies(bad), ["late"]);
  assert.equal(nextPolicyId([{ id: "1" }, { id: "4" }]), "5");
});

test("policy checks", () => {
  assert.throws(() => checkPolicy({ ...nasPolicy, name: "" }), /name/);
  assert.throws(() => checkPolicy({ ...nasPolicy, protocol: "any" }), /Ports need/);
  assert.throws(() => checkPolicy({ ...nasPolicy, ports: "70000" }), /Bad port/);
  assert.throws(() => checkPolicy({ ...nasPolicy, to: { kind: "device", value: "" } }), /fixed IPv4/);
  assert.throws(() => checkPolicy({ ...nasPolicy, from: { kind: "net", value: "eth2" }, to: { kind: "net", value: "eth2" } }), /same network/);
  assert.equal(checkPolicy({ ...nasPolicy, ports: " 80, 443 " }).ports, "80,443");
});
