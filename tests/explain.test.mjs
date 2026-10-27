import { test } from "node:test";
import assert from "node:assert/strict";
import { explainDevice, explainPath, ruleMatch } from "../src/lib/explain.js";

const cfg = {
  firewall: {
    group: {
      "mac-group": { "VYGI-BLOCKED": { "mac-address": "aa:aa:aa:aa:aa:01" }, "VYGI-G1": { "mac-address": ["aa:aa:aa:aa:aa:02"] } },
      "network-group": { "VYGI-LOCAL": { network: ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"] } },
      "domain-group": { "VYGI-R2": { address: ["tiktok.com", "snapchat.com"] } },
    },
    ipv4: {
      forward: { filter: { rule: {
        1: { action: "reject", description: "VyGi rule 1: Bedtime", source: { group: { "mac-group": "VYGI-G1" } }, time: { starttime: "21:30", stoptime: "07:00" } },
        2: { action: "reject", description: "VyGi rule 2: No TikTok", source: { group: { "mac-group": "VYGI-G1" } }, destination: { group: { "domain-group": "VYGI-R2" } } },
        3: { action: "drop", description: "VyGi: blocked clients", source: { group: { "mac-group": "VYGI-BLOCKED" } } },
        5: { action: "accept", description: "VyGi policy 1: IoT to NAS", "inbound-interface": { name: "eth3" }, destination: { address: "10.0.2.20" }, protocol: "tcp", state: "new" },
        6: { action: "drop", description: "VyGi net eth3: isolate (out)", "inbound-interface": { name: "eth3" }, destination: { group: { "network-group": "VYGI-LOCAL" } }, state: "new" },
        7: { action: "drop", description: "VyGi net eth3: no internet", "inbound-interface": { name: "eth3" }, "outbound-interface": { name: "eth0" } },
        8: { action: "jump", "jump-target": "LAN-OUT", "inbound-interface": { name: "eth1" } },
        9: { action: "drop", description: "disabled one", disable: {} },
      } } },
      name: { "LAN-OUT": { "default-action": "return", rule: { 10: { action: "drop", destination: { address: "10.0.3.0/24" } } } } },
    },
  },
  nat: { destination: { rule: { 100: { description: "VyGi fwd 1: Plex", protocol: "tcp", destination: { port: "32400" }, translation: { address: "10.0.2.20" }, "inbound-interface": { name: "eth0" } } } } },
};
const nets = [
  { iface: "eth1", name: "Office", network: "10.0.1.0/24" },
  { iface: "eth2", name: "Home", network: "10.0.2.0/24" },
  { iface: "eth3", name: "IoT", network: "10.0.3.0/24" },
];

test("a blocked device: blocked everywhere by the blocked-devices rule", () => {
  const r = explainDevice(cfg, { ip: "10.0.2.5", mac: "aa:aa:aa:aa:aa:01", iface: "eth2" }, nets, "eth0");
  assert.equal(r.internet.verdict, "blocked");
  assert.equal(r.internet.by.number, 3);
  assert.equal(r.internet.by.owner.feature, "Blocked devices");
  assert.deepEqual(r.networks.map((n) => n.verdict), ["blocked", "blocked"]);
});

test("a kid's device: allowed, but partly blocked by schedule and sites", () => {
  const r = explainDevice(cfg, { ip: "10.0.2.6", mac: "aa:aa:aa:aa:aa:02", iface: "eth2" }, nets, "eth0");
  assert.equal(r.internet.verdict, "allowed");
  assert.equal(r.internet.by, null);
  assert.deepEqual(r.internet.partly.map((s) => s.number), [1, 2]);
  assert.match(r.internet.partly[0].reasons[0], /schedule \(21:30–07:00\)/);
  assert.match(r.internet.partly[1].reasons[0], /tiktok\.com, snapchat\.com/);
  // sites are on the internet: the TikTok rule doesn't touch other networks
  assert.deepEqual(r.networks.find((n) => n.net.name === "Office").partly.map((s) => s.number), [1]);
});

test("an isolated network: no other networks, no internet, with an exception", () => {
  const r = explainDevice(cfg, { ip: "10.0.3.9", mac: "aa:aa:aa:aa:aa:09", iface: "eth3" }, nets, "eth0");
  assert.equal(r.internet.verdict, "blocked");
  assert.equal(r.internet.by.number, 7);
  const home = r.networks.find((n) => n.net.name === "Home");
  assert.equal(home.verdict, "blocked");
  assert.equal(home.by.number, 6);
  assert.deepEqual(home.partlyAllowed.map((s) => s.number), [5]); // TCP to the NAS only
  assert.ok(home.partlyAllowed[0].reasons.includes("only TCP"));
});

test("jumps into custom chains, and return goes back", () => {
  const r = explainDevice(cfg, { ip: "10.0.1.4", mac: "aa:aa:aa:aa:aa:04", iface: "eth1" }, nets, "eth0");
  assert.equal(r.networks.find((n) => n.net.name === "IoT").verdict, "blocked");
  assert.equal(r.networks.find((n) => n.net.name === "IoT").by.chain, "LAN-OUT");
  assert.equal(r.networks.find((n) => n.net.name === "Home").verdict, "allowed");
  assert.equal(r.internet.verdict, "allowed");
});

test("port forwards to the device", () => {
  const r = explainDevice(cfg, { ip: "10.0.2.20", mac: "aa:aa:aa:aa:aa:20", iface: "eth2" }, nets, "eth0");
  assert.deepEqual(r.forwards.map((f) => [f.protocol, f.port, f.owner.name]), [["tcp", "32400", "Plex"]]);
});

test("ruleMatch details", () => {
  const pkt = { srcIp: "10.0.2.6", srcMac: "aa:bb:cc:dd:ee:ff", inIf: "eth2", outIf: "eth0", dstRange: null };
  assert.equal(ruleMatch({ state: "established" }, pkt, {}).match, "no");
  assert.equal(ruleMatch({ source: { address: "!10.0.2.0/24" } }, pkt, {}).match, "no");
  assert.equal(ruleMatch({ source: { address: "10.0.2.1-10.0.2.9" } }, pkt, {}).match, "yes");
  assert.equal(ruleMatch({ destination: { address: "192.168.0.0/16" } }, pkt, {}).match, "no"); // the internet isn't private
  assert.equal(ruleMatch({ destination: { address: "0.0.0.0/0" } }, pkt, {}).match, "yes");
  assert.equal(ruleMatch({ "inbound-interface": { name: "eth*" } }, pkt, {}).match, "yes");
  assert.equal(ruleMatch({ "inbound-interface": { name: "!eth2" } }, pkt, {}).match, "no");
  assert.equal(ruleMatch({ source: { "mac-address": "AA:BB:CC:DD:EE:FF" } }, pkt, {}).match, "yes");
  const d = explainPath({ firewall: { ipv4: { forward: { filter: { "default-action": "drop" } } } } }, pkt);
  assert.equal(d.verdict, "blocked");
  assert.equal(d.by, null);
});
