import { test } from "node:test";
import assert from "node:assert/strict";
import { compareValues } from "../src/lib/table.js";

const sorted = (vals) => [...vals].sort(compareValues);

test("table sort order", () => {
  assert.deepEqual(sorted(["10.20.2.31", "10.20.10.5", "10.20.2.4"]), ["10.20.2.4", "10.20.2.31", "10.20.10.5"]);
  assert.deepEqual(sorted(["eth10", "eth2", "Eth1"]), ["Eth1", "eth2", "eth10"]);
  assert.deepEqual(sorted([3, "", 10, null, 1]), [1, 3, 10, "", null]);
  assert.deepEqual(sorted([false, true, false]), [true, false, false]);
  assert.deepEqual(sorted(["10.0.0.0/8", "192.168.1.0/24", "10.20.0.0/16"]), ["10.0.0.0/8", "10.20.0.0/16", "192.168.1.0/24"]);
});
