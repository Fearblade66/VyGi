import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, diagnose, checkChange, touchesManual } from "../src/lib/doctor.js";

const env = { wan: "eth0", wanCidr: "203.0.113.0/24", mgmtHost: "192.168.1.1" };
const base = () => ({
  interfaces: { ethernet: { eth0: { address: "203.0.113.7/24" }, eth1: { address: "192.168.1.1/24" } } },
  service: {
    "dhcp-server": { "shared-network-name": { LAN: { subnet: { "192.168.1.0/24": { "subnet-id": "1", option: { "default-router": "192.168.1.1", "name-server": "192.168.1.1" }, range: { 0: { start: "192.168.1.100", stop: "192.168.1.200" } }, "static-mapping": { nas: { mac: "aa:bb:cc:dd:ee:ff", "ip-address": "192.168.1.5" } } } } } } },
    dns: { forwarding: { "allow-from": "192.168.1.0/24", "listen-address": "192.168.1.1" } },
  },
  nat: { source: { rule: { 100: { "outbound-interface": { name: "eth0" }, source: { address: "192.168.1.0/24" }, translation: { address: "masquerade" } } } } },
  firewall: { ipv4: { input: { filter: { "default-action": "drop", rule: { 10: { action: "accept", state: ["established", "related"] }, 20: { action: "accept", "inbound-interface": { name: "eth1" } } } } } } },
  system: { "config-management": { "commit-confirm": { action: "reload" } } },
});
const ids = (cfg) => diagnose(cfg, env).filter((f) => !f.security).map((f) => f.id).sort();

test("simulate applies set and delete, keeping lists", () => {
  const c = simulate(base(), [
    { op: "set", path: ["service", "dns", "forwarding", "allow-from"], value: "10.0.0.0/8" },
    { op: "set", path: ["system", "host-name"], value: "gw" },
    { op: "delete", path: ["nat", "source", "rule", "100"] },
    { op: "set", path: ["service", "ssh"] },
  ]);
  assert.deepEqual(c.service.dns.forwarding["allow-from"], ["192.168.1.0/24", "10.0.0.0/8"]);
  assert.equal(c.system["host-name"], "gw");
  assert.equal(c.nat.source.rule[100], undefined);
  assert.deepEqual(c.service.ssh, {});
});

test("a healthy config has no problems", () => {
  assert.deepEqual(ids(base()), []);
});

test("no NAT for a LAN: found, and the fix is a new VyGi rule (automatic)", () => {
  const c = base();
  delete c.nat;
  const f = diagnose(c, env).find((x) => x.id === "nat:eth1");
  assert.equal(f.level, "bad");
  assert.equal(f.manual, false);
  assert.ok(f.fix.some((x) => x.value === "VyGi net eth1: internet"));
});

test("DNS not answering where DHCP points devices", () => {
  const c = base();
  delete c.service.dns;
  const f = diagnose(c, env).find((x) => x.id === "dns:eth1");
  assert.deepEqual(f.fix.map((x) => x.path.at(-1)), ["allow-from", "listen-address", "system"]);
});

test("forward chain drops without allowing replies", () => {
  const c = base();
  c.firewall.ipv4.forward = { filter: { "default-action": "drop", rule: { 20: { action: "accept", "inbound-interface": { name: "eth1" } } } } };
  const f = diagnose(c, env).find((x) => x.id === "replies:ipv4:forward");
  assert.ok(f.fix.some((x) => x.path.join(" ") === "firewall ipv4 forward filter rule 5 state" && x.value === "established"));
});

test("DHCP problems, duplicate fixed addresses, overlapping networks", () => {
  const c = base();
  const s = c.service["dhcp-server"]["shared-network-name"].LAN.subnet["192.168.1.0/24"];
  s.range[0].start = "192.168.1.1";
  s["static-mapping"].cam = { mac: "11:22:33:44:55:66", "ip-address": "192.168.1.5" };
  c.interfaces.ethernet.eth2 = { address: "192.168.1.129/25" };
  const got = ids(c);
  for (const id of ["dhcp-gw:192.168.1.0/24", "dhcp-map-dup:192.168.1.5", "overlap:eth1:eth2"]) assert.ok(got.includes(id), `${id} in ${got}`);
});

test("port forwards: duplicate port, dynamic address, VPN port closed", () => {
  const c = base();
  c.nat.destination = { rule: { 10: { "inbound-interface": { name: "eth0" }, protocol: "tcp", destination: { port: "443" }, translation: { address: "192.168.1.150" } }, 20: { "inbound-interface": { name: "eth0" }, protocol: "tcp", destination: { port: "443" }, translation: { address: "192.168.1.5" } } } };
  c.interfaces.wireguard = { wg0: { address: "10.10.0.1/24", port: "51820", peer: { a: { "allowed-ips": "10.10.0.2/32" }, b: { "allowed-ips": "10.10.0.2/32" } } } };
  const got = ids(c);
  for (const id of ["dnat-dup:eth0/tcp/443", "dnat-dyn:10", "wg-port:wg0", "wg-dup:wg0:10.10.0.2/32"]) assert.ok(got.includes(id), `${id} in ${got}`);
  assert.ok(!got.includes("dnat-dyn:20")); // 192.168.1.5 is reserved
});

test("leftovers made by VyGi can be cleaned up", () => {
  const c = base();
  c.firewall.group = { "mac-group": { "VYGI-R7": { "mac-address": "aa:aa:aa:aa:aa:aa" }, KIDS: { "mac-address": "bb:bb:bb:bb:bb:bb" } } };
  c.firewall.ipv4.forward = { filter: { rule: { 3: { action: "drop", description: "VyGi net eth9: no internet" } } } };
  const got = ids(c);
  assert.ok(got.includes("leftover-group:mac-group:VYGI-R7"));
  assert.ok(!got.some((x) => x.includes("KIDS"))); // hand-made: not ours to remove
  assert.ok(got.includes("leftover-rule:ipv4:forward:3"));
});

test("ownership: fixes that change hand-made settings are manual", () => {
  const c = base();
  c.firewall.ipv4.forward = { filter: { rule: { 5: { action: "drop" }, 6: { action: "drop", description: "VyGi rule 1: x" } } } };
  assert.equal(touchesManual(c, { op: "set", path: ["firewall", "ipv4", "forward", "filter", "rule", "5", "action"], value: "accept" }), true);
  assert.equal(touchesManual(c, { op: "set", path: ["firewall", "ipv4", "forward", "filter", "rule", "6", "action"], value: "accept" }), false);
  assert.equal(touchesManual(c, { op: "set", path: ["firewall", "ipv4", "forward", "filter", "rule", "7", "action"], value: "accept" }), false); // new
  assert.equal(touchesManual(c, { op: "set", path: ["system", "config-management", "commit-confirm", "action"], value: "reboot" }), true);
  assert.equal(touchesManual(c, { op: "set", path: ["service", "dns", "forwarding", "allow-from"], value: "10.0.0.0/8" }), false);
});

test("checkChange: removing NAT is caught with an automatic fix; existing problems are ignored", () => {
  const c = base();
  c.interfaces.ethernet.eth2 = { address: "192.168.1.129/25" }; // an old problem
  const r = checkChange(c, [{ op: "delete", path: ["nat", "source", "rule", "100"] }], env);
  assert.deepEqual(r.extras.map((e) => e.finding.id), ["nat:eth1", "nat:eth2"]);
  assert.equal(r.warnings.length, 0);
  const forward = checkChange(c, [{ op: "set", path: ["nat", "destination", "rule", "10", "translation", "address"], value: "192.168.1.150" }, { op: "set", path: ["nat", "destination", "rule", "10", "destination", "port"], value: "80" }], env);
  assert.deepEqual(forward.warnings.map((w) => w.id), ["dnat-dyn:10"]);
  assert.deepEqual(checkChange(c, [{ op: "set", path: ["system", "host-name"], value: "gw" }], env), { extras: [], warnings: [] });
});

test("lockout: warns when VyGi's own address goes away", async () => {
  const { lockout, checkChange } = await import("../src/lib/doctor.js");
  const env = { mgmtHost: "192.168.88.6", mgmtIface: "eth0" };
  const fixed = { interfaces: { ethernet: { eth0: { address: ["192.168.88.6/24"] } } } };
  const dhcp = { interfaces: { ethernet: { eth0: { address: "dhcp" } } } };
  const del = [{ op: "delete", path: ["interfaces", "ethernet", "eth0", "address", "192.168.88.6/24"] }];
  assert.ok(checkChange(fixed, del, env).warnings.some((w) => w.id === "lockout:eth0"));
  assert.ok(lockout(fixed, { interfaces: { ethernet: { eth0: { address: "192.168.88.7/24" } } } }, env));
  assert.ok(lockout(fixed, { interfaces: { ethernet: { eth0: { address: ["192.168.88.6/24"], disable: {} } } } }, env));
  // DHCP -> the same address, fixed: fine; DHCP removed with nothing instead: not
  assert.equal(lockout(dhcp, fixed, env), null);
  assert.ok(lockout(dhcp, { interfaces: { ethernet: { eth0: {} } } }, env));
  // unrelated change, or VyGi reaches the router some other way
  assert.equal(lockout(fixed, fixed, env), null);
  assert.equal(lockout(fixed, {}, { mgmtHost: "vyos.lan" }), null);
});

test("lockout: removing VyGi's login or its key", async () => {
  const { lockout } = await import("../src/lib/doctor.js");
  const env = { user: "vygi", keyLogin: true };
  const withKey = { system: { login: { user: { vygi: { authentication: { "public-keys": { vygi: { key: "AAAA", type: "ssh-ed25519" } } } }, vyos: {} } } } };
  assert.match(lockout(withKey, { system: { login: { user: { vyos: {} } } } }, env).text, /removes the vygi login/);
  assert.match(lockout(withKey, { system: { login: { user: { vygi: { authentication: {} }, vyos: {} } } } }, env).text, /SSH key/);
  assert.equal(lockout(withKey, withKey, env), null);
  // removing someone else's login is fine
  assert.equal(lockout(withKey, { system: { login: { user: { vygi: withKey.system.login.user.vygi } } } }, env), null);
});

test("a port forward that takes every connection: Health Check and lockout", async () => {
  const { diagnose, lockout } = await import("../src/lib/doctor.js");
  const before = { interfaces: { ethernet: { eth0: { address: "172.17.0.2/16" } } } };
  const after = structuredClone(before);
  after.nat = { destination: { rule: { 999: { translation: { address: "10.20.1.50" } } } } };
  assert.ok(diagnose(after, {}).some((f) => f.id === "dnat-all:999"));
  assert.match(lockout(before, after, { mgmtHost: "172.17.0.2", mgmtIface: "eth0" })?.text || "", /every connection/);
  // a normal forward (port 25565 on the internet port) is fine
  after.nat.destination.rule[999] = { destination: { port: "25565" }, "inbound-interface": { name: "eth1" }, protocol: "tcp", translation: { address: "10.20.1.50" } };
  assert.equal(lockout(before, after, { mgmtHost: "172.17.0.2", mgmtIface: "eth0" }), null);
  assert.ok(!diagnose(after, {}).some((f) => f.id.startsWith("dnat-all")));
});
