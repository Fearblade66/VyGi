import { test } from "node:test";
import assert from "node:assert/strict";
import { routerDefaults, routerPlan } from "../src/lib/makerouter.js";
import { simulate } from "../src/lib/doctor.js";

const line = (c) => `${c.op} ${c.path.join(" ")}${c.value !== undefined ? ` ${c.value}` : ""}`;

// a fresh VyOS: internet by DHCP on eth0, VyGi on eth1 (192.168.88.6 behind the old router)
const fresh = () => ({
  interfaces: { ethernet: { eth0: { address: "dhcp" }, eth1: { address: "192.168.88.6/24" }, eth2: {} } },
  service: { ssh: {}, https: { api: {} } },
});

test("defaults: internet keeps its port, home network is the one VyGi uses", () => {
  const d = routerDefaults(fresh(), { wan: "eth0", mgmtIface: "eth1" });
  assert.equal(d.internet.port, "eth0");
  assert.equal(d.internet.mode, "dhcp");
  assert.equal(d.lan, "eth1");
  assert.deepEqual(d.newPorts, ["eth2"]);
  assert.equal(d.cidr, "192.168.1.1/24");
});

test("existing network gets DHCP, DNS, NAT and the internet side is blocked", () => {
  const cfg = fresh();
  const { cmds, notes } = routerPlan(cfg, { port: "eth0", vlan: "", mode: "dhcp", lan: "eth1" }, { wan: "eth0", mgmtHost: "192.168.88.6", mgmtIface: "eth1" });
  const text = cmds.map(line).join("\n");
  assert.match(text, /dhcp-server shared-network-name HOME subnet 192\.168\.88\.0\/24 range 0 start 192\.168\.88\.100/);
  assert.match(text, /dns forwarding listen-address 192\.168\.88\.6/);
  assert.match(text, /nat source rule \d+ outbound-interface name eth0/);
  assert.match(text, /firewall ipv4 input filter rule \d+ inbound-interface name eth0/);
  assert.match(text, /ssh dynamic-protection/);
  assert.ok(!cmds.some((c) => c.path.join(" ").startsWith("interfaces ethernet eth1 address")), "VyGi's own address stays");
  assert.deepEqual(notes, []);
  // running it again on the result changes nothing big
  const again = routerPlan(simulate(cfg, cmds), { port: "eth0", vlan: "", mode: "dhcp", lan: "eth1" }, { wan: "eth0", mgmtHost: "192.168.88.6", mgmtIface: "eth1" });
  assert.deepEqual(again.cmds, [], again.cmds.map(line).join("\n"));
});

test("new home network on a free port; PPPoE internet", () => {
  const { cmds } = routerPlan(fresh(), { port: "eth0", mode: "pppoe", user: "me@isp", password: "pw", lan: "new", newPorts: ["eth2"], cidr: "192.168.1.1/24", poolStart: "192.168.1.100", poolStop: "192.168.1.200" }, { wan: "eth0", mgmtHost: "192.168.88.6", mgmtIface: "eth1" });
  const text = cmds.map(line).join("\n");
  assert.match(text, /interfaces pppoe pppoe0 authentication username me@isp/);
  assert.match(text, /interfaces ethernet eth2 address 192\.168\.1\.1\/24/);
  assert.match(text, /nat source rule \d+ outbound-interface name pppoe0/);
});

test("VyGi connected through the internet port: not blocked, explained", () => {
  const cfg = { interfaces: { ethernet: { eth0: { address: "192.168.88.6/24" }, eth1: {} } }, protocols: { static: { route: { "0.0.0.0/0": { "next-hop": { "192.168.88.1": {} } } } } }, system: { "name-server": "192.168.88.1" } };
  const ctx = { wan: "eth0", mgmtHost: "192.168.88.6", mgmtIface: "eth0" };
  const d = routerDefaults(cfg, ctx);
  assert.equal(d.internet.mode, "static");
  assert.equal(d.lan, "new");
  const { cmds, notes } = routerPlan(cfg, { ...d.internet, lan: "new", newPorts: ["eth1"], cidr: d.cidr, poolStart: d.pool.start, poolStop: d.pool.stop }, ctx);
  assert.ok(!cmds.some((c) => c.path.join(" ").includes("input filter") && c.path.includes("eth0") === false && c.value === "eth0"), cmds.map(line).join("\n"));
  assert.ok(!cmds.some((c) => c.path[1] === "ipv4" && c.path[2] === "input" && c.value === "drop"));
  assert.match(notes.join(" "), /stays reachable from eth0/);
});

test("the same port can't be internet and home", () => {
  assert.throws(() => routerPlan(fresh(), { port: "eth1", mode: "dhcp", lan: "eth1" }, {}), /both/);
});

test("keep the current connection: no internet commands", () => {
  const cfg = fresh();
  const { cmds } = routerPlan(cfg, { port: "eth0", mode: "keep", lan: "new", newPorts: ["eth2"], cidr: "192.168.1.1/24", poolStart: "192.168.1.100", poolStop: "192.168.1.200" }, { wan: "eth0", mgmtHost: "192.168.88.6", mgmtIface: "eth1" });
  assert.ok(!cmds.some((c) => c.path.join(" ").startsWith("interfaces ethernet eth0")));
  assert.ok(cmds.some((c) => c.path.join(" ") === "interfaces ethernet eth2 address"));
  assert.throws(() => routerPlan(cfg, { port: "eth2", mode: "keep", lan: "eth1" }, { wan: "eth0" }), /only works/);
});

test("a new network doesn't reuse an existing name", () => {
  const cfg = fresh();
  cfg.interfaces.ethernet.eth1.description = "Home";
  const { cmds } = routerPlan(cfg, { port: "eth0", mode: "keep", lan: "new", newPorts: ["eth2"], cidr: "192.168.1.1/24", poolStart: "192.168.1.100", poolStop: "192.168.1.200" }, { wan: "eth0", mgmtHost: "192.168.88.6", mgmtIface: "eth1" });
  assert.ok(cmds.some((c) => c.path.join(" ") === "interfaces ethernet eth2 description" && c.value === "Home 2"));
});
