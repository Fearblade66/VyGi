import { test } from "node:test";
import assert from "node:assert/strict";
import { score, synonymTargets, flattenConfig } from "../src/lib/searchindex.js";

test("score prefers exact, prefix and word matches", () => {
  assert.equal(score("Port Forwarding", "port forwarding"), 100);
  assert.equal(score("Port Forwarding", "port"), 80);
  assert.equal(score("Port Forwarding", "forw"), 60);
  assert.equal(score("Teleport", "port"), 40);
  assert.equal(score("Clients", "zzz"), 0);
});

test("everyday words find the right place", () => {
  assert.ok(synonymTargets("password").has("t:Users"));
  assert.ok(synonymTargets("bedtime").has("p:rules"));
  assert.ok(synonymTargets("open port").has("p:ports"));
  assert.ok(synonymTargets("timez").has("t:Identity & Clock"));
  assert.equal(synonymTargets("xq").size, 0);
});

test("flattenConfig skips secrets", () => {
  const rows = flattenConfig({ system: { "host-name": "gw", login: { user: { vyos: { authentication: { "plaintext-password": "x" } } } } }, interfaces: { wireguard: { wg0: { "private-key": "K", address: ["10.0.0.1/24"] } } } });
  const texts = rows.map((r) => r.text);
  assert.ok(texts.includes("system host-name gw"));
  assert.ok(texts.includes("interfaces wireguard wg0 address 10.0.0.1/24"));
  assert.ok(!texts.some((t) => /plaintext|private-key|K$/.test(t)));
});
