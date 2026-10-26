import { test } from "node:test";
import assert from "node:assert/strict";
// netdata.js pulls in browser modules; a do-nothing document is enough to load it
const noop = new Proxy(function () {}, { get: () => noop, apply: () => noop });
globalThis.document ??= noop;
globalThis.window ??= noop;
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const { mergeClients } = await import("../src/lib/netdata.js");

test("devices on the internet port aren't clients", () => {
  const neighbors = [
    { dst: "192.168.1.20", dev: "eth1", lladdr: "00:11:32:aa:00:20", state: ["REACHABLE"] },
    { dst: "203.0.113.1", dev: "eth0", lladdr: "00:aa:bb:cc:dd:ee", state: ["REACHABLE"] },
  ];
  const ifaces = { ethernet: { eth0: { address: "dhcp" }, eth1: { address: "192.168.1.1/24" } } };
  assert.deepEqual(mergeClients({ neighbors, ifaces, wan: "eth0" }).map((c) => c.ip), ["192.168.1.20"]);
  assert.equal(mergeClients({ neighbors, ifaces }).length, 2); // unknown internet port: everything shown
});
