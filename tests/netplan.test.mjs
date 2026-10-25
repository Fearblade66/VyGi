import { test } from "node:test";
import assert from "node:assert/strict";
import { readNetworks, suggestSubnet, suggestVlan, networkCommands, deleteNetworkCommands, LOCAL_GROUP } from "../src/lib/netplan.js";

const cfg = {
  interfaces: { ethernet: { eth0: { address: "dhcp" }, eth1: { address: "192.168.1.1/24", description: "LAN", vif: { 10: { address: "192.168.10.1/24" } } }, eth2: {} } },
  service: {
    "dhcp-server": { "shared-network-name": { LAN: { subnet: { "192.168.1.0/24": { "subnet-id": "1", option: { "default-router": "192.168.1.1", "name-server": "192.168.1.1" }, range: { 0: { start: "192.168.1.100", stop: "192.168.1.200" } }, "static-mapping": { nas: { mac: "aa:bb:cc:dd:ee:ff", "ip-address": "192.168.1.5" } } } } } } },
    dns: { forwarding: { "allow-from": "192.168.1.0/24", "listen-address": "192.168.1.1" } },
  },
  nat: { source: { rule: { 100: { "outbound-interface": { name: "eth0" }, source: { address: "192.168.1.0/24" }, translation: { address: "masquerade" } } } } },
  firewall: { ipv4: { forward: { filter: { "default-action": "drop", rule: { 10: { action: "accept", state: ["established", "related"] } } } }, input: { filter: { "default-action": "drop", rule: { 10: { action: "accept" } } } } } },
};
const env = { wan: "eth0", mgmtHost: "192.168.1.1" };
const lines = (cmds) => cmds.map((c) => `${c.op} ${c.path.join(" ")}${c.value !== undefined ? ` ${c.value}` : ""}`);

test("readNetworks lists LANs with DHCP and DNS mode, not the WAN", () => {
  const nets = readNetworks(cfg, "eth0");
  assert.deepEqual(nets.map((n) => n.iface), ["eth1", "eth1.10"]);
  assert.equal(nets[0].name, "LAN");
  assert.equal(nets[0].dhcp.start, "192.168.1.100");
  assert.equal(nets[0].dnsMode, "router");
  assert.equal(nets[1].vlan, "10");
  assert.equal(nets[1].dhcp, null);
});

test("suggestions avoid used subnets and VLANs", () => {
  assert.equal(suggestSubnet(cfg, "20"), "192.168.20.1/24");
  assert.equal(suggestSubnet(cfg, "10"), "192.168.20.1/24");
  assert.equal(suggestVlan(cfg, "eth1"), "20");
});

const guest = { name: "Guest", mode: "vlan", parent: "eth1", vlan: "30", cidr: "192.168.30.1/24", dhcp: true, poolStart: "192.168.30.100", poolStop: "192.168.30.200", dnsMode: "router", internet: true, isolate: true };

test("new isolated guest VLAN: interface, DHCP, DNS, NAT, firewall", () => {
  const l = lines(networkCommands(cfg, guest, env));
  assert.ok(l.includes("set interfaces ethernet eth1 vif 30 address 192.168.30.1/24"));
  assert.ok(l.includes("set interfaces ethernet eth1 vif 30 description Guest"));
  assert.ok(l.includes("set service dhcp-server shared-network-name GUEST subnet 192.168.30.0/24 subnet-id 2"));
  assert.ok(l.includes("set service dhcp-server shared-network-name GUEST subnet 192.168.30.0/24 option name-server 192.168.30.1"));
  assert.ok(l.includes("set service dns forwarding allow-from 192.168.30.0/24"));
  assert.ok(l.includes("set nat source rule 110 source address 192.168.30.0/24"));
  assert.ok(l.includes(`set firewall group network-group ${LOCAL_GROUP} network 10.0.0.0/8`));
  // internet accept goes late (900+), isolation drops early (1+), router access only DHCP/DNS/ping
  assert.ok(l.includes("set firewall ipv4 forward filter rule 900 inbound-interface name eth1.30"));
  assert.ok(l.includes("set firewall ipv4 forward filter rule 1 destination group network-group VYGI-LOCAL"));
  assert.ok(l.includes("set firewall ipv4 forward filter rule 2 outbound-interface name eth1.30"));
  assert.ok(l.includes("set firewall ipv4 input filter rule 5 action drop"));
  assert.ok(l.includes("set firewall ipv4 input filter rule 1 destination port 67,68"));
});

test("validation", () => {
  assert.throws(() => networkCommands(cfg, { ...guest, cidr: "192.168.1.50/24" }, env), /overlaps/);
  assert.throws(() => networkCommands(cfg, { ...guest, vlan: "10" }, env), /already exists/);
  assert.throws(() => networkCommands(cfg, { ...guest, cidr: "192.168.30.0/24" }, env), /network or broadcast/);
  assert.throws(() => networkCommands(cfg, { ...guest, cidr: "8.8.8.1/24" }, env), /private/);
  assert.throws(() => networkCommands(cfg, { ...guest, poolStart: "192.168.30.1" }, env), /gateway/);
  assert.throws(() => networkCommands(cfg, { ...guest, name: "" }, env), /Name/);
  assert.throws(() => networkCommands(cfg, { ...guest, mode: "port", port: "eth1" }, env), /already has an address/);
});

test("separate port, no internet, no DHCP", () => {
  const l = lines(networkCommands(cfg, { ...guest, mode: "port", port: "eth2", dhcp: false, internet: false, isolate: false }, env));
  assert.ok(l.includes("set interfaces ethernet eth2 address 192.168.30.1/24"));
  assert.ok(!l.some((x) => x.includes("dhcp-server") || x.includes("nat source")));
  assert.ok(l.includes("set firewall ipv4 forward filter rule 1 description VyGi net eth2: no internet"));
  assert.ok(l.includes("set firewall ipv4 input filter rule 900 description VyGi net eth2: router access"));
});

test("editing the management LAN: can't isolate; re-creating DHCP keeps id and reservations", () => {
  const lan = readNetworks(cfg, "eth0")[0];
  assert.throws(() => networkCommands(cfg, { ...guest, name: "LAN", isolate: true }, env, lan), /locked|lock VyGi out/);
  const l = lines(networkCommands(cfg, { name: "Home", dhcp: true, poolStart: "192.168.1.50", poolStop: "192.168.1.99", dnsMode: "custom", dnsServers: "1.1.1.1", internet: true, isolate: false }, env, lan));
  assert.ok(l.includes("set interfaces ethernet eth1 description Home"));
  assert.ok(l.includes("delete service dhcp-server shared-network-name LAN subnet 192.168.1.0/24"));
  assert.ok(l.includes("set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 subnet-id 1"));
  assert.ok(l.includes("set service dhcp-server shared-network-name LAN subnet 192.168.1.0/24 static-mapping nas mac aa:bb:cc:dd:ee:ff"));
  assert.ok(l.includes("delete service dns forwarding allow-from 192.168.1.0/24"));
  assert.ok(!l.some((x) => x.startsWith("set nat")), "existing masquerade covers it");
});

test("edit replaces our earlier rules; delete removes everything we added", () => {
  const withRules = structuredClone(cfg);
  withRules.firewall.ipv4.forward.filter.rule[3] = { action: "drop", description: "VyGi net eth1.10: no internet" };
  withRules.nat.source.rule[120] = { description: "VyGi net eth1.10: internet" };
  const net = readNetworks(withRules, "eth0")[1];
  assert.equal(net.internet, false);
  const l = lines(networkCommands(withRules, { name: "IoT", dhcp: false, internet: true, isolate: false }, env, net));
  assert.ok(l.includes("delete firewall ipv4 forward filter rule 3"));
  assert.ok(l.includes("delete nat source rule 120"));
  const d = lines(deleteNetworkCommands(withRules, net, env));
  assert.ok(d.includes("delete interfaces ethernet eth1 vif 10"));
  assert.ok(d.includes("delete firewall ipv4 forward filter rule 3"));
  assert.throws(() => deleteNetworkCommands(cfg, readNetworks(cfg, "eth0")[0], env), /connected through/);
});

test("isolated network keeps its DNS server on another LAN reachable, before the isolation drop", () => {
  const l = lines(networkCommands(cfg, { ...guest, dnsMode: "custom", dnsServers: "192.168.1.5 1.1.1.1" }, env));
  // rule 1 = DNS exception for the private server only, rule 2 = isolate (out)
  assert.ok(l.includes("set firewall ipv4 forward filter rule 1 destination address 192.168.1.5"));
  assert.ok(l.includes("set firewall ipv4 forward filter rule 1 destination port 53"));
  assert.ok(l.includes("set firewall ipv4 forward filter rule 1 action accept"));
  assert.ok(l.includes("set firewall ipv4 forward filter rule 2 description VyGi net eth1.30: isolate (out)"));
  assert.ok(!l.some((x) => x.includes("destination address 1.1.1.1")));
});

test("IPv6: isolation and no-internet get matching rules, and delete removes them", () => {
  const l = lines(networkCommands(cfg, { ...guest, internet: false }, env));
  assert.ok(l.includes("set firewall ipv6 forward filter rule 1 description VyGi net eth1.30: no internet"));
  assert.ok(l.includes("set firewall ipv6 forward filter rule 2 outbound-interface name !eth0"));
  assert.ok(l.includes("set firewall ipv6 forward filter rule 3 inbound-interface name !eth0"));
  assert.ok(l.includes("set firewall ipv6 input filter rule 1 protocol ipv6-icmp"));
  assert.ok(l.includes("set firewall ipv6 input filter rule 5 action drop"));
  const withV6 = structuredClone(cfg);
  withV6.firewall.ipv6 = { forward: { filter: { rule: { 7: { action: "drop", description: "VyGi net eth1.10: no internet" } } } } };
  const net = readNetworks(withV6, "eth0")[1];
  assert.ok(lines(deleteNetworkCommands(withV6, net, env)).includes("delete firewall ipv6 forward filter rule 7"));
});
