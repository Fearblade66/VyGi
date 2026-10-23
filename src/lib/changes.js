// Display helpers for config changes (set-command diffs).
import { h } from "./dom.js";

const SECRET_RE = /\b(private-key|preshared-key|plaintext-password|encrypted-password|password|secret|key)\s+('[^']*'|"[^"]*"|\S+)\s*$/;

/** Hides secret values in a `set` line for display. */
export function maskSecrets(line) {
  return line.replace(SECRET_RE, (_, k) => `${k} ••••••`);
}

export function fmtDate(unixSecs) {
  return unixSecs ? new Date(unixSecs * 1000).toLocaleString() : "";
}

/** Renders added/removed `set` lines (secrets masked) into a <pre>. */
export function changesPre(added, removed) {
  const pre = h("pre.out", { style: { maxHeight: "260px" } });
  if (!added.length && !removed.length) pre.append("(no changes)");
  for (const l of removed) pre.append(h("span.diff-del", `- ${maskSecrets(l)}`), "\n");
  for (const l of added) pre.append(h("span.diff-add", `+ ${maskSecrets(l)}`), "\n");
  return pre;
}
