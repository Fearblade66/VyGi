import { test } from "node:test";
import assert from "node:assert/strict";
import { readIds, idsCommands, blockCommands, unblockCommands, IMAGE } from "../src/lib/ids.js";
import { simulate } from "../src/lib/doctor.js";

const lines = (cmds) => cmds.map((c) => `${c.op} ${c.path.join(" ")}${c.value != null ? ` ${c.value}` : ""}`);

test("container on chosen ports, then a port change, then off", () => {
  const on = idsCommands({}, ["eth0", "eth1.20"]);
  const l = lines(on);
  assert.ok(l.includes(`set container name vygi-ids image ${IMAGE}`));
  assert.ok(l.includes("set container name vygi-ids arguments -i eth0 -i eth1.20 --set stats.enabled=no"));
  assert.ok(l.includes("set container name vygi-ids command suricata"));
  assert.ok(l.includes("set container name vygi-ids memory 1024") && l.includes("set container name vygi-ids allow-host-networks"));
  const cfg = simulate({}, on);
  assert.deepEqual(readIds(cfg).ifaces, ["eth0", "eth1.20"]);
  assert.deepEqual(idsCommands(cfg, ["eth0", "eth1.20"]), []);
  assert.deepEqual(lines(idsCommands(cfg, ["eth0"])), ["set container name vygi-ids arguments -i eth0 --set stats.enabled=no"]);
  assert.deepEqual(lines(idsCommands(cfg, [])), ["delete container name vygi-ids"]);
  assert.throws(() => idsCommands({}, ["eth0; rm -rf /"]), /Bad interface/);
});

test("blocking an internet address sets up the group and drop rules once", () => {
  const cmds = blockCommands({}, "45.33.12.9");
  const l = lines(cmds);
  assert.ok(l.includes("set firewall group address-group VYGI-IDS-BLOCK address 45.33.12.9"));
  assert.ok(l.includes("set firewall ipv4 input filter rule 1 source group address-group VYGI-IDS-BLOCK"));
  assert.ok(l.includes("set firewall ipv4 forward filter rule 1 action drop"));
  const cfg = simulate({}, cmds);
  assert.deepEqual((({ blockRules, blocked }) => ({ blockRules, blocked }))(readIds(cfg)), { blockRules: true, blocked: ["45.33.12.9"] });
  const more = lines(blockCommands(cfg, "203.0.113.9"));
  assert.deepEqual(more, ["set firewall group address-group VYGI-IDS-BLOCK address 203.0.113.9"]);
  assert.deepEqual(blockCommands(cfg, "45.33.12.9"), []);
  assert.throws(() => blockCommands(cfg, "192.168.1.5"), /local address/);
  assert.deepEqual(lines(unblockCommands("45.33.12.9")), ["delete firewall group address-group VYGI-IDS-BLOCK address 45.33.12.9"]);
});
