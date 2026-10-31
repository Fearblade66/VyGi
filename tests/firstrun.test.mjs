import { test } from "node:test";
import assert from "node:assert/strict";
import { consoleCommands } from "../src/lib/firstrun.js";

test("first-run console commands", () => {
  const r = consoleCommands({ cidr: "192.168.88.6/24", gw: "192.168.88.1", port: "eth0" });
  assert.equal(r.ip, "192.168.88.6");
  assert.deepEqual(r.text.split("\n"), [
    "configure",
    "set interfaces ethernet eth0 address 192.168.88.6/24",
    "set protocols static route 0.0.0.0/0 next-hop 192.168.88.1",
    "set system name-server 192.168.88.1",
    "set service ssh",
    "commit",
    "save",
    "exit",
  ]);
  assert.match(consoleCommands({ cidr: "192.168.88.6", gw: "192.168.88.1", port: "eth0" }).error, /Router address/);
  assert.match(consoleCommands({ cidr: "192.168.88.6/24", gw: "10.0.0.1", port: "eth0" }).error, /Gateway/);
  assert.match(consoleCommands({ cidr: "192.168.88.6/24", gw: "192.168.88.6", port: "eth0" }).error, /gateway/);
  assert.match(consoleCommands({ cidr: "192.168.88.6/24", gw: "192.168.88.1", port: "eth0; reboot" }).error, /Port/);
});
