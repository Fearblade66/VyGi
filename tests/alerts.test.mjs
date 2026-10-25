import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, duration } from "../src/lib/alerts.js";

const run = (steps) => {
  let state = {};
  const out = [];
  for (const s of steps) {
    const r = evaluate(state, s);
    state = r.state;
    out.push(r.alerts.map((a) => a.kind + ": " + a.text));
  }
  return { state, out };
};

test("internet: two failed checks make an outage, recovery says how long", () => {
  const min = 60000;
  const { out } = run([
    { at: 0, internetOk: true },
    { at: 1 * min, internetOk: false },
    { at: 2 * min, internetOk: false },
    { at: 3 * min, internetOk: false },
    { at: 6 * min, internetOk: true },
    { at: 7 * min, internetOk: false },
    { at: 8 * min, internetOk: true },
  ]);
  assert.deepEqual(out[1], []);
  assert.deepEqual(out[2], ["internet: Internet is down: the router can't reach the internet."]);
  assert.deepEqual(out[3], []);
  assert.deepEqual(out[4], ["internet: Internet is back (down for 5 min)."]);
  assert.deepEqual(out[5], []); // a single lost check
  assert.deepEqual(out[6], []);
});

test("devices: first run learns silently, then new ones are reported once", () => {
  const a = { mac: "aa:aa:aa:aa:aa:01", ip: "192.168.1.10", name: "nas" };
  const b = { mac: "aa:aa:aa:aa:aa:02", ip: "192.168.1.11", name: "" };
  const { out, state } = run([{ at: 0, devices: [a] }, { at: 1, devices: [a, b] }, { at: 2, devices: [a, b] }]);
  assert.deepEqual(out, [[], ["device: New device joined: unnamed device (192.168.1.11, aa:aa:aa:aa:aa:02)."], []]);
  assert.equal(state.known.length, 2);
  const many = Array.from({ length: 8 }, (_, i) => ({ mac: `bb:00:00:00:00:0${i}` }));
  assert.equal(evaluate(state, { at: 3, devices: many }).alerts.length, 6);
});

test("DDNS failure reported once, recovery reported", () => {
  const { out } = run([
    { at: 0, ddns: [{ host: "home.example.com", status: "good" }] },
    { at: 1, ddns: [{ host: "home.example.com", status: "badauth" }] },
    { at: 2, ddns: [{ host: "home.example.com", status: "badauth" }] },
    { at: 3, ddns: [{ host: "home.example.com", status: "good" }] },
  ]);
  assert.equal(out[1].length, 1);
  assert.match(out[1][0], /couldn't update home.example.com \(badauth\)/);
  assert.deepEqual(out[2], []);
  assert.deepEqual(out[3], ["ddns: Dynamic DNS for home.example.com is working again."]);
});

test("restart and VPN connect", () => {
  const { out } = run([
    { at: 0, uptime: 5000, vpn: [{ key: "k1", name: "phone", handshake: 0 }] },
    { at: 60000, uptime: 5060, vpn: [{ key: "k1", name: "phone", handshake: 50 }] },
    { at: 120000, uptime: 30, vpn: [{ key: "k1", name: "phone", handshake: 110 }] },
  ]);
  assert.deepEqual(out[0], []);
  assert.deepEqual(out[1], ["vpn: phone connected to the VPN."]);
  assert.deepEqual(out[2], ["reboot: The router restarted (up for less than a minute)."]);
});

test("duration", () => {
  assert.equal(duration(90 * 60000), "1 h 30 min");
  assert.equal(duration(3 * 86400000), "3 days");
});
