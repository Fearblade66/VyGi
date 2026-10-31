// Removes passwords, keys and other secrets from a VyOS config tree before
// it leaves VyGi (Diagnostics Report). Same rule as the server's MCP redaction.

const SECRET = /password|private-key|preshared|secret|token/;

export function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const secret = SECRET.test(k) || k === "key";
      out[k] = secret && (x === null || typeof x !== "object" || Array.isArray(x)) ? "<redacted>" : redact(x);
    }
    return out;
  }
  return v;
}
