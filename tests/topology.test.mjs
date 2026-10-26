import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTopology, speedText } from "../src/lib/topology.js";

const cfg = { interfaces: {
  ethernet: { eth0: { description: "WAN" }, eth1: { address: "192.168.1.1/24", description: "Home", vif: { 20: { address: "192.168.20.1/24", description: "IoT" } } }, eth2: {}, eth3: {}, eth4: {} },
  bridge: { br0: { address: "10.0.0.1/24", description: "Office", member: { interface: { eth2: {}, eth3: {} } } } },
  pppoe: { pppoe0: { "source-interface": "eth0" } },
} };
const clients = [
  { mac: "aa:00:00:00:00:01", ip: "192.168.1.10", iface: "eth1", label: "laptop", online: true },
  { mac: "aa:00:00:00:00:02", ip: "192.168.20.5", iface: "eth1.20", label: "camera", online: false },
  { mac: "aa:00:00:00:00:03", ip: "10.0.0.7", iface: "br0", label: "printer", online: true },
  { mac: "aa:00:00:00:00:04", ip: "10.0.0.8", iface: "br0", label: "desk pc", online: true },
  { ip: "10.8.0.2", iface: "wg0", label: "phone (VPN)", kind: "vpn", online: true },
];

test("ports with roles, networks, devices and neighbors", () => {
  const t = buildTopology({
    cfg, wan: "pppoe0", clients,
    ports: [{ name: "eth0", speedMbit: 1000, carrier: true }, { name: "eth1", speedMbit: 2500, carrier: true }, { name: "eth2", speedMbit: 100, carrier: true }, { name: "eth3", speedMbit: null, carrier: false }, { name: "eth4", carrier: false }],
    fdb: [{ mac: "aa:00:00:00:00:03", ifname: "eth3", master: "br0" }, { mac: "11:11:11:11:11:11", ifname: "eth2", flags: ["self"] }],
    lldp: [{ local: "eth1", device: "switch-living-room" }],
  });
  const port = (n) => t.ports.find((p) => p.name === n);
  assert.equal(t.wanPort, "eth0");
  assert.deepEqual(t.ports.map((p) => [p.name, p.role]), [["eth0", "internet"], ["eth1", "network"], ["eth2", "bridge"], ["eth3", "bridge"], ["eth4", "unused"]]);
  assert.deepEqual(port("eth1").networks.map((n) => [n.name, n.cidr, n.vlan]), [["Home", "192.168.1.0/24", ""], ["IoT", "192.168.20.0/24", "20"]]);
  assert.deepEqual(port("eth1").devices.map((d) => d.label), ["laptop", "camera"]);
  assert.deepEqual(port("eth3").devices.map((d) => d.label), ["printer"]);
  assert.equal(port("eth1").neighbors[0].device, "switch-living-room");
  assert.deepEqual(t.elsewhere.map((d) => d.label), ["desk pc", "phone (VPN)"]);
  assert.equal(port("eth3").up, false);
  assert.equal(speedText(2500), "2.5 Gbit/s");
});
