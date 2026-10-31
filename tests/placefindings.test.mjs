import { test } from "node:test";
import assert from "node:assert/strict";
import { findingsFor } from "../src/lib/placefindings.js";

const f = (id, level = "bad") => ({ id, level, title: id });
const all = [f("nat:eth3"), f("dns:eth4"), f("overlap:eth1:eth3", "warn"), f("dhcp-gw:10.20.1.0/24"), f("dnat-dyn:100", "warn"), f("dnat-all:999"), f("wg-port:wg0"), f("security:wan-input"), f("security:ssh-guess", "warn")];

test("findings go to the item they're about", () => {
  assert.deepEqual(findingsFor(all, "network", { iface: "eth3", network: "10.20.1.0/24" }).map((x) => x.id), ["nat:eth3", "dhcp-gw:10.20.1.0/24", "overlap:eth1:eth3"]);
  assert.deepEqual(findingsFor(all, "network", { iface: "eth5", network: "10.20.3.0/24" }), []);
  assert.deepEqual(findingsFor(all, "forward", { n: "100" }).map((x) => x.id), ["dnat-dyn:100"]);
  assert.deepEqual(findingsFor(all, "forward", { n: "999" }).map((x) => x.id), ["dnat-all:999"]);
  assert.deepEqual(findingsFor(all, "vpn", { iface: "wg0" }).map((x) => x.id), ["wg-port:wg0"]);
  assert.deepEqual(findingsFor(all, "internet").map((x) => x.id), ["security:wan-input"]);
});
