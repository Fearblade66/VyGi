import { test } from "node:test";
import assert from "node:assert/strict";
import { niceMax, splitAtGaps } from "../src/lib/chart.js";

test("axis top rounds up to 1/2/5 x 10^n", () => {
  assert.equal(niceMax(1), 1);
  assert.equal(niceMax(730), 1000);
  assert.equal(niceMax(14_000), 20_000);
});

test("traffic lines break where nothing was recorded", () => {
  const m = 60_000;
  const pts = [0, 1, 2, 3, 60, 61, 62, 200].map((t) => [t * m, 1, 1]);
  assert.deepEqual(splitAtGaps(pts).map((r) => r.map((p) => p[0] / m)), [[0, 1, 2, 3], [60, 61, 62], [200]]);
  assert.equal(splitAtGaps(pts.slice(0, 4)).length, 1);
  assert.deepEqual(splitAtGaps([]), []);
  // recorded out of order: sorted first, so no line runs backwards
  assert.deepEqual(splitAtGaps([[2 * m, 1, 1], [0, 1, 1], [m, 1, 1]]).map((r) => r.map((p) => p[0] / m)), [[0, 1, 2]]);
});
