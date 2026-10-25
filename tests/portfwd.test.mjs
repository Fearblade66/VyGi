import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePorts, parseForwards, forwardCommands, deleteForwardCommands, toggleForwardCommands } from "../src/lib/portfwd.js";

const lines = (cmds) => cmds.map((c) => `${c.op} ${c.path.join(" ")}${c.value !== undefined ? ` ${c.value}` : ""}`);
const env = { wan: "eth0", lans: ["192.168.1.0/24"] };
const cfg = {
  nat: { destination: { rule: { 10: { "inbound-interface": { name: "eth0" }, protocol: "tcp", destination: { port: "2222" }, translation: { address: "192.168.1.9", port: "22" }, description: "hand made" } } } },
  firewall: { ipv4: { forward: { filter: { "default-action": "drop", rule: { 10: { action: "accept", state: ["established", "related"] } } } } } },
};
const mc = { name: "Minecraft", protocol: "tcp", outside: "25565", inside: "", ip: "192.168.1.20" };

test("parsePorts", () => {
  assert.deepEqual(parsePorts("443"), [443, 443]);
  assert.deepEqual(parsePorts(" 8000-8010 "), [8000, 8010]);
  assert.equal(parsePorts("0"), null);
  assert.equal(parsePorts("70000"), null);
  assert.equal(parsePorts("10-5"), null);
  assert.equal(parsePorts("80,443"), null);
});

test("new forward: DNAT rule plus forward accept when the chain drops", () => {
  assert.deepEqual(lines(forwardCommands(cfg, mc, env)), [
    "set nat destination rule 100 inbound-interface name eth0",
    "set nat destination rule 100 protocol tcp",
    "set nat destination rule 100 destination port 25565",
    "set nat destination rule 100 translation address 192.168.1.20",
    "set nat destination rule 100 description VyGi fwd 1: Minecraft",
    "set firewall ipv4 forward filter rule 900 action accept",
    "set firewall ipv4 forward filter rule 900 inbound-interface name eth0",
    "set firewall ipv4 forward filter rule 900 protocol tcp",
    "set firewall ipv4 forward filter rule 900 destination address 192.168.1.20",
    "set firewall ipv4 forward filter rule 900 destination port 25565",
    "set firewall ipv4 forward filter rule 900 description VyGi fwd 1: Minecraft",
  ]);
});

test("different inside port, source limit, reservation; no firewall rule when forward accepts", () => {
  const open = { nat: cfg.nat };
  const l = lines(forwardCommands(open, { ...mc, outside: "8443", inside: "443", from: "203.0.113.0/24", reserve: { network: "LAN", subnet: "192.168.1.0/24", mac: "aa:bb:cc:dd:ee:ff", name: "NAS box" } }, env));
  assert.ok(l.includes("set nat destination rule 100 translation port 443"));
  assert.ok(l.includes("set nat destination rule 100 source address 203.0.113.0/24"));
  assert.ok(!l.some((x) => x.includes("firewall")));
  assert.ok(l.includes("set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 static-mapping NAS-box mac aa:bb:cc:dd:ee:ff"));
  assert.ok(l.includes("set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 static-mapping NAS-box ip-address 192.168.1.20"));
});

test("round trip, edit, toggle, delete", () => {
  const c = structuredClone(cfg);
  c.nat.destination.rule[100] = { "inbound-interface": { name: "eth0" }, protocol: "tcp", destination: { port: "25565" }, translation: { address: "192.168.1.20" }, description: "VyGi fwd 1: Minecraft" };
  c.firewall.ipv4.forward.filter.rule[900] = { action: "accept", description: "VyGi fwd 1: Minecraft" };
  const fs = parseForwards(c);
  assert.deepEqual(fs.map((f) => [f.n, f.ours, f.name, f.inside]), [["10", false, "hand made", "22"], ["100", true, "Minecraft", "25565"]]);
  const f = fs[1];
  assert.equal(f.fw, "900");
  const edit = lines(forwardCommands(c, { ...mc, ip: "192.168.1.21", enabled: false }, env, f));
  assert.equal(edit[0], "delete nat destination rule 100");
  assert.equal(edit[1], "delete firewall ipv4 forward filter rule 900");
  assert.ok(edit.includes("set firewall ipv4 forward filter rule 900 destination address 192.168.1.21"));
  assert.ok(edit.includes("set nat destination rule 100 disable"));
  assert.ok(edit.includes("set firewall ipv4 forward filter rule 900 disable"));
  assert.deepEqual(lines(toggleForwardCommands(f, false)), ["set nat destination rule 100 disable", "set firewall ipv4 forward filter rule 900 disable"]);
  assert.deepEqual(lines(deleteForwardCommands(f)), ["delete nat destination rule 100", "delete firewall ipv4 forward filter rule 900"]);
  // a second forward gets the next id
  assert.ok(lines(forwardCommands(c, { ...mc, name: "Web", outside: "443" }, env)).includes("set nat destination rule 110 description VyGi fwd 2: Web"));
});

test("validation and clashes", () => {
  assert.throws(() => forwardCommands(cfg, { ...mc, name: "" }, env), /name/);
  assert.throws(() => forwardCommands(cfg, { ...mc, outside: "abc" }, env), /Outside port/);
  assert.throws(() => forwardCommands(cfg, { ...mc, outside: "8000-8010", inside: "80" }, env), /same size/);
  assert.throws(() => forwardCommands(cfg, { ...mc, ip: "10.9.9.9" }, env), /local networks/);
  assert.throws(() => forwardCommands(cfg, { ...mc, outside: "2200-2300" }, env), /already forwarded by "hand made"/);
  assert.doesNotThrow(() => forwardCommands(cfg, { ...mc, outside: "2222", protocol: "udp" }, env));
  assert.throws(() => forwardCommands(cfg, mc, { wan: "" }), /internet/);
});
