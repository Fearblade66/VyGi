import { test } from "node:test";
import assert from "node:assert/strict";
import { domainClients, periodStart } from "../src/lib/dnsclients.js";

test("lookups of a domain grouped by device, most first", () => {
  const e = (ip, t, r = "Recursive") => ({ clientIpAddress: ip, timestamp: t, responseType: r });
  const rows = domainClients([
    e("192.168.1.20", "2026-10-26T10:00:00Z"),
    e("192.168.1.5", "2026-10-26T10:01:00Z", "Blocked"),
    e("192.168.1.20", "2026-10-26T10:02:00Z", "Cached"),
    e("192.168.1.5", "2026-10-26T10:03:00Z", "Blocked"),
    e("192.168.1.20", "2026-10-26T10:04:00Z"),
    { timestamp: "2026-10-26T10:05:00Z" },
  ], new Map([["192.168.1.20", "LG TV"]]));
  assert.deepEqual(rows.map((r) => [r.ip, r.name, r.hits, r.blocked]), [["192.168.1.20", "LG TV", 3, 0], ["192.168.1.5", "", 2, 2]]);
  assert.equal(rows[0].last, Date.parse("2026-10-26T10:04:00Z"));
  assert.deepEqual(domainClients(null), []);
});

test("period start", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  assert.equal(periodStart("LastHour", now), "2026-10-26T11:00:00.000Z");
  assert.equal(periodStart("LastWeek", now), "2026-10-19T12:00:00.000Z");
});
