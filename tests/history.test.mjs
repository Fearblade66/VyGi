import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRevisions, undoPlan } from "../src/lib/history.js";

const text = `sudo: unable to resolve host vyos: System error
 0  2026-10-25 04:34:46  by root  via vyos-http-api
 1  2026-10-25 04:34:44  by root  via vyos-http-api
 2  2026-10-25 04:34:37  by vyos  via cli
 3  2026-10-25 04:33:49  by root
`;

test("parseRevisions", () => {
  const r = parseRevisions(text);
  assert.equal(r.length, 4);
  assert.deepEqual(r[2], { rev: 2, stamp: "2026-10-25 04:34:37", by: "vyos", via: "cli" });
  assert.equal(r[3].via, "");
});

test("undoPlan rolls back to the revision before, listing later changes", () => {
  const revs = parseRevisions(text);
  const entries = [
    { id: "c", at: 3, what: "C", stamp: "2026-10-25 04:34:46" },
    { id: "b", at: 2, what: "B", stamp: "2026-10-25 04:34:44" },
    { id: "a", at: 1, what: "A", stamp: "2026-10-25 04:34:37" },
  ];
  assert.deepEqual(undoPlan(entries, entries[0], revs), { rev: 1, later: [], foreign: 0 });
  const p = undoPlan(entries, entries[2], revs);
  assert.equal(p.rev, 3);
  assert.deepEqual(p.later.map((x) => x.id), ["c", "b"]);
  assert.match(undoPlan(entries, { at: 0, stamp: "2020-01-01 00:00:00" }, revs).error, /too old/);
  assert.match(undoPlan(entries, { at: 0 }, revs).error, /couldn't tell/);
  // a commit made outside VyGi in between is counted
  const withCli = [{ ...entries[0], stamp: "2026-10-25 04:34:46" }, entries[2]];
  assert.equal(undoPlan(withCli, entries[2], revs).foreign, 1);
});
