import { test } from "node:test";
import assert from "node:assert/strict";
import { ruleLabel, unloggedBlocks, logBlocksCommands, portName } from "../src/lib/flows.js";

const cfg = { interfaces: { ethernet: { eth2: { description: "IoT" } } }, firewall: {
  ipv4: { forward: { filter: { rule: {
    1: { action: "reject", description: "VyGi rule 1: Kids bedtime" },
    3: { action: "drop", description: "VyGi: blocked clients", log: {} },
    4: { action: "drop", description: "VyGi net eth2: isolate (out)" },
    5: { action: "drop", description: "my own drop" },
    6: { action: "accept", description: "VyGi policy 1: IoT to NAS" },
  } } }, input: { filter: { rule: { 9900: { action: "drop", description: "VyGi: block new connections from the internet" } } } } },
} };

test("rule names from log tags", () => {
  assert.equal(ruleLabel(cfg, "ipv4-FWD-filter-1"), "Traffic Rule: Kids bedtime");
  assert.equal(ruleLabel(cfg, "ipv4-FWD-filter-4"), "IoT: isolated");
  assert.equal(ruleLabel(cfg, "ipv4-INP-filter-9900"), "block new connections from the internet");
  assert.equal(ruleLabel(cfg, "ipv6-FWD-filter-77"), "ipv6 forward rule 77");
  assert.equal(portName(443), "HTTPS");
});

test("VyGi's blocking rules that don't log yet", () => {
  assert.deepEqual(unloggedBlocks(cfg).map((r) => r.path.at(-1)), ["1", "4", "9900"]);
  assert.deepEqual(logBlocksCommands(cfg)[0], { op: "set", path: ["firewall", "ipv4", "forward", "filter", "rule", "1", "log"] });
});
