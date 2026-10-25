import assert from "node:assert/strict";
import { createSampler, orient, accountingOn } from "../src/lib/flowrates.js";
const isLan = (ip) => ip.startsWith("192.168.1.") && ip !== "192.168.1.1";
const out = { id: "1", proto: "tcp", src: "192.168.1.10", dst: "1.1.1.1", sport: "5000", dport: "443", replySrc: "1.1.1.1", replyDst: "203.0.113.7", origBytes: 1000, replyBytes: 5000, bytes: 6000 };
const inb = { id: "2", proto: "tcp", src: "8.8.8.8", dst: "203.0.113.7", sport: "4000", dport: "8443", replySrc: "192.168.1.20", replyDst: "8.8.8.8", origBytes: 300, replyBytes: 9000, bytes: 9300 };
const routerOwn = { id: "3", proto: "udp", src: "203.0.113.7", dst: "9.9.9.9", sport: "1", dport: "53", replySrc: "9.9.9.9", replyDst: "203.0.113.7", origBytes: 60, replyBytes: 120, bytes: 180 };
assert.equal(orient(routerOwn, isLan), null);
assert.equal(orient(inb, isLan).client, "192.168.1.20");
assert.equal(accountingOn([out]), true);
assert.equal(accountingOn([{ ...out, bytes: 0 }]), false);
const s = createSampler();
let r = s.sample([out, inb, routerOwn], 0, isLan);
assert.equal(r.ready, false);
assert.equal(r.clients.get("192.168.1.10").totalDown, 5000);
assert.equal(r.clients.get("192.168.1.20").totalUp, 9000); // device's upload is the reply direction
r = s.sample([{ ...out, origBytes: 3000, replyBytes: 25000 }, inb, { ...out, id: "4", origBytes: 100, replyBytes: 400 }], 2000, isLan);
assert.equal(r.ready, true);
const c = r.clients.get("192.168.1.10");
assert.equal(c.up, (2000 + 100) / 2);
assert.equal(c.down, (20000 + 400) / 2);
assert.equal(c.conns, 2);
assert.equal(r.clients.get("192.168.1.20").down, 0);
assert.equal(r.remotes.get("192.168.1.10|1.1.1.1").down, 10200);

