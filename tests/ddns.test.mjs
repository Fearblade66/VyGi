import { test } from "node:test";
import assert from "node:assert/strict";
import { ddnsCommands, parseDdns, parseStatus, needs } from "../src/lib/ddns.js";

const base = { name: "home", protocol: "cloudflare", hosts: "vpn.example.com", password: "tok", zone: "example.com", source: "interface", iface: "eth0" };

test("cloudflare: zone required, no username", () => {
  const cmds = ddnsCommands(base);
  const paths = cmds.map((c) => `${c.op} ${c.path.slice(4).join(" ")} ${c.value ?? ""}`.trim());
  assert.deepEqual(paths, [
    "set home protocol cloudflare",
    "set home host-name vpn.example.com",
    "set home password tok",
    "set home zone example.com",
    "set home address interface eth0",
  ]);
  assert.throws(() => ddnsCommands({ ...base, zone: "" }), /zone/);
  assert.equal(needs("cloudflare").username, false);
});

test("noip needs a username; duckdns doesn't", () => {
  assert.throws(() => ddnsCommands({ ...base, protocol: "noip", zone: "" }), /username/);
  assert.ok(ddnsCommands({ ...base, protocol: "noip", zone: "", username: "me" }).some((c) => c.path.at(-1) === "username"));
  const d = ddnsCommands({ ...base, protocol: "duckdns", hosts: "me.duckdns.org", zone: "x.org", username: "ignored" });
  assert.ok(!d.some((c) => c.path.at(-1) === "zone" || c.path.at(-1) === "username"));
});

test("web address source, multiple hosts, ip version", () => {
  const cmds = ddnsCommands({ ...base, hosts: "a.example.com b.example.com", source: "web", url: "https://api.ipify.org", ipVersion: "both" });
  assert.equal(cmds.filter((c) => c.path.at(-1) === "host-name").length, 2);
  assert.ok(cmds.some((c) => c.path.join(" ").endsWith("address web url") && c.value === "https://api.ipify.org"));
  assert.ok(cmds.some((c) => c.path.at(-1) === "ip-version" && c.value === "both"));
  assert.throws(() => ddnsCommands({ ...base, source: "web", url: "ftp://x" }), /web address/);
});

test("editing keeps the old password when left blank and replaces the node", () => {
  const old = parseDdns({ home: { protocol: "cloudflare", "host-name": "vpn.example.com", password: "secret", zone: "example.com", address: { interface: "eth0" } } })[0];
  assert.equal(old.hasPassword, true);
  const cmds = ddnsCommands({ ...base, password: "" }, old);
  assert.deepEqual(cmds[0], { op: "delete", path: ["service", "dns", "dynamic", "name", "home"] });
  assert.ok(cmds.some((c) => c.path.at(-1) === "password" && c.value === "secret"));
});

test("validation", () => {
  assert.throws(() => ddnsCommands({ ...base, name: "bad name" }), /Name/);
  assert.throws(() => ddnsCommands({ ...base, hosts: "" }), /host name/);
  assert.throws(() => ddnsCommands({ ...base, hosts: "bad/host" }), /Bad host/);
  assert.throws(() => ddnsCommands({ ...base, protocol: "nope" }), /provider/);
  assert.throws(() => ddnsCommands({ ...base, iface: "" }), /interface/);
});

test("status parsing skips empty cache entries", () => {
  assert.deepEqual(parseStatus([{}]), []);
  assert.deepEqual(parseStatus([{ host: "a.example.com", ipv4: "203.0.113.5", "status-ipv4": "good", mtime: "2026-10-25 01:00:00" }]),
    [{ host: "a.example.com", ip: "203.0.113.5", status: "good", updated: "2026-10-25 01:00:00" }]);
  assert.deepEqual(parseStatus(null), []);
});
