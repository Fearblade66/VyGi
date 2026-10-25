import { test } from "node:test";
import assert from "node:assert/strict";
import { ddnsName, wanProblem } from "../src/lib/wan.js";

test("ddnsName picks a usable full name", () => {
  assert.equal(ddnsName({ name: { a: { protocol: "duckdns", "host-name": "myhome" } } }), "myhome.duckdns.org");
  assert.equal(ddnsName({ name: { a: { protocol: "cloudflare", zone: "example.com", "host-name": ["home.example.com", "x.example.com"] } } }), "home.example.com");
  assert.equal(ddnsName({ name: { a: { protocol: "cloudflare", zone: "example.com", "host-name": "@" }, b: { protocol: "noip", "host-name": "me.ddns.net" } } }), "me.ddns.net");
  assert.equal(ddnsName({}), "");
});

test("wanProblem spots CGNAT and a modem in front", () => {
  assert.equal(wanProblem("100.72.1.5").kind, "cgnat");
  assert.equal(wanProblem("192.168.0.50").kind, "double");
  assert.equal(wanProblem("203.0.113.9"), null);
  assert.equal(wanProblem(""), null);
});
