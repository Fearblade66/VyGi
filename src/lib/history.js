// Plain-language change history: what VyGi changed on each router ("Block
// internet: Kids bedtime"), when, and the router revision it made, so a change
// can be undone. Kept on this computer, per router. The parsing is pure.

const MAX = 200;
const key = (router) => `vygi.history.${router}`;

/** `show system commit` -> [{ rev, stamp, by, via }] (newest first). */
export function parseRevisions(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+by\s+(\S+)(?:\s+via\s+(.+?))?\s*$/);
    if (m) out.push({ rev: Number(m[1]), stamp: m[2], by: m[3], via: m[4] || "" });
  }
  return out;
}

/** A router revision in plain words (who changed it, and how). */
export function describeRevision(r) {
  const via = (r.via || "").toLowerCase();
  if (/boot-config-loader|^init/.test(via)) return "The router loaded its saved settings while starting up";
  if (/rollback|revert|commit-confirm/.test(via)) return "Settings were rolled back (an unconfirmed Safe Mode change, or a rollback)";
  if (!via || via === "cli") return `Changed on the router's command line by ${r.by}`;
  if (/http-api/.test(via)) return `Changed through the router's API by ${r.by}`;
  return `Changed by ${r.by} (${r.via})`;
}

/** "2026-10-25 23:15:25" (the router's clock) as a Date, or null. */
export function revisionDate(stamp) {
  const d = new Date(String(stamp || "").replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * How to undo entry `e`: roll back to the revision just before its commit.
 * Returns { rev, later: [entries after it that also get undone] } or { error }.
 */
export function undoPlan(entries, e, revisions) {
  if (!e.stamp) return { error: "VyGi couldn't tell which router revision this change made." };
  const i = revisions.findIndex((r) => r.stamp === e.stamp);
  if (i < 0) return { error: "This change is too old: the router no longer keeps that revision." };
  if (!revisions[i + 1]) return { error: "There's no earlier revision to go back to." };
  const later = entries.filter((x) => x.at > e.at && !x.reverted && !x.undone);
  const ours = new Set(entries.map((x) => x.stamp).filter(Boolean));
  const foreign = revisions.slice(0, i).filter((r) => !ours.has(r.stamp)).length;
  return { rev: revisions[i + 1].rev, later, foreign };
}

function read(router) {
  try {
    return JSON.parse(localStorage.getItem(key(router))) || [];
  } catch {
    return [];
  }
}
function write(router, list) {
  try {
    localStorage.setItem(key(router), JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* storage unavailable */
  }
}

export function historyList(router) {
  return read(router);
}

/** Adds an entry (newest first); returns it so the caller can fill in the stamp. */
export function addEntry(router, entry) {
  const list = read(router);
  const e = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), ...entry };
  write(router, [e, ...list]);
  return e;
}

export function updateEntry(router, id, patch) {
  write(router, read(router).map((x) => (x.id === id ? { ...x, ...patch } : x)));
}

/** Safe Mode outcome for the changes still waiting: kept (confirmed) or reverted. */
export function settlePending(router, outcome) {
  write(router, read(router).map((x) => (x.pending ? { ...x, pending: false, reverted: outcome === "reverted" } : x)));
}
