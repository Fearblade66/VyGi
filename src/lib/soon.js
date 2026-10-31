// Slow extras shouldn't hold a page back: wait a little for them, else draw
// the page without them (or with the last value) and redraw when they arrive.
import { session } from "./session.js";

const store = new Map(); // key -> { value, at, pending }

/**
 * fn's result if it comes within `wait` ms; else the last value (or fallback),
 * and onLate() once it arrives. Results are reused for maxAge ms.
 * Keys are per router.
 */
export async function soon(key, fn, { wait = 2500, fallback = null, maxAge = 30_000, onLate = null } = {}) {
  const k = `${session.info?.profileId || ""}|${key}`;
  let e = store.get(k);
  if (!e) store.set(k, (e = { value: undefined, at: 0, pending: null }));
  if (e.at && Date.now() - e.at < maxAge) return e.value;
  if (!e.pending) {
    e.pending = Promise.resolve()
      .then(fn)
      .then((v) => {
        e.value = v;
        e.at = Date.now();
        return v;
      })
      .finally(() => (e.pending = null));
  }
  const p = e.pending;
  const got = await Promise.race([p.then((v) => ({ v })), new Promise((r) => setTimeout(() => r(null), wait))]).catch(() => ({ v: e.at ? e.value : fallback }));
  if (got) return got.v;
  if (onLate) p.then(() => onLate(), () => {});
  return e.at ? e.value : fallback;
}
