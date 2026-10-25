import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWgConf, addClientCommands, readClients, routeCommands, removeClientCommands, killSwitchCommands, tunnelState } from "../src/lib/vpnclient.js";
import { groupCommands } from "../src/lib/devgroups.js";
import { simulate } from "../src/lib/doctor.js";

const KEY1 = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=";
const KEY2 = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=";
const CONF = `# Mullvad se-sto-wg-001
[Interface]
PrivateKey = ${KEY1}
Address = 10.64.12.34/32,fc00:bbbb:bbbb:bb01::1:c22/128
DNS = 10.64.0.1

[Peer]
PublicKey = ${KEY2}
AllowedIPs = 0.0.0.0/0,::0/0
Endpoint = se-sto-wg-001.relays.mullvad.net:51820
`;

test("parse a provider's WireGuard config", () => {
  const w = parseWgConf(CONF);
  assert.deepEqual(w, { privateKey: KEY1, address: "10.64.12.34/32", dns: ["10.64.0.1"], publicKey: KEY2, presharedKey: "", host: "se-sto-wg-001.relays.mullvad.net", port: "51820" });
  assert.equal(parseWgConf(CONF.replace("se-sto-wg-001.relays.mullvad.net", "185.65.135.1")).host, "185.65.135.1");
  assert.throws(() => parseWgConf("hello"), /\[Interface\]/);
  assert.throws(() => parseWgConf(CONF.replace(KEY2, "nope")), /PublicKey/);
  assert.throws(() => parseWgConf(CONF.replace(/Endpoint.*/, "Endpoint = nowhere")), /host:port/);
});

test("add, route, read and remove a VPN client", () => {
  let cfg = { interfaces: { wireguard: { wg0: { description: "WireGuard VPN" } } }, nat: { source: { rule: { 100: { description: "LAN" } } } } };
  cfg = simulate(cfg, groupCommands(cfg, { name: "Kids", macs: ["aa:aa:aa:aa:aa:01"] }).cmds);
  const { iface, cmds } = addClientCommands(cfg, { name: "Mullvad", conf: CONF, killSwitch: true });
  assert.equal(iface, "wg10");
  assert.ok(cmds.some((c) => c.path.join(" ") === "interfaces wireguard wg10 peer provider host-name"));
  cfg = simulate(cfg, cmds);
  let [c] = readClients(cfg);
  assert.deepEqual([c.iface, c.name, c.table, c.host, c.killSwitch], ["wg10", "Mullvad", "150", "se-sto-wg-001.relays.mullvad.net", true]);
  assert.deepEqual(c.routes, { macs: [], groups: [], networks: [] });

  cfg = simulate(cfg, routeCommands(cfg, "wg10", { macs: ["AA:BB:CC:DD:EE:FF"], groups: ["VYGI-G1"], networks: ["192.168.30.0/24"] }, ["eth1", "eth1.30"]));
  [c] = readClients(cfg);
  assert.deepEqual(c.routes, { macs: ["aa:bb:cc:dd:ee:ff"], groups: ["VYGI-G1"], networks: ["192.168.30.0/24"] });
  const pol = cfg.policy.route["VYGI-VPN"];
  assert.equal(pol.rule["1"].set.table, "main");
  assert.deepEqual(pol.interface, ["eth1", "eth1.30"]);
  assert.equal(Object.keys(pol.rule).length, 4);

  cfg = simulate(cfg, killSwitchCommands(cfg, c, false));
  assert.equal(readClients(cfg)[0].killSwitch, false);

  // clearing all routes removes the policy
  cfg = simulate(cfg, routeCommands(cfg, "wg10", { macs: [], groups: [], networks: [] }, ["eth1"]));
  assert.equal(cfg.policy?.route?.["VYGI-VPN"], undefined);

  cfg = simulate(cfg, removeClientCommands(cfg, readClients(cfg)[0], ["eth1"]));
  assert.deepEqual(readClients(cfg), []);
  assert.deepEqual(Object.keys(cfg.interfaces.wireguard), ["wg0"]); // the VPN server stays
  assert.deepEqual(Object.keys(cfg.nat.source.rule), ["100"]);
  assert.equal(cfg.protocols.static.table?.["150"], undefined);
});

test("tunnel state from wg dump", () => {
  const dump = `wg10\tPRIV\tPUB\t51820\toff\nwg10\t${KEY2}\t(none)\t185.65.135.1:51820\t0.0.0.0/0\t1792960000\t1234\t5678\t25\n`;
  assert.deepEqual(tunnelState(dump, "wg10"), { handshake: 1792960000, rx: 1234, tx: 5678 });
  assert.equal(tunnelState(dump, "wg11"), null);
});
