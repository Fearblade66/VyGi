import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/lib/redact.js";

test("secrets are removed, the rest kept", () => {
  const cfg = {
    system: { "host-name": "gw", login: { user: { vyos: { authentication: { "encrypted-password": "$6$x", "plaintext-password": "" } } } } },
    service: { https: { api: { keys: { id: { vygi: { key: "abc" } } } } }, "dns": { dynamic: { name: { a: { password: "pw", "host-name": "h.example.com" } } } } },
    interfaces: { wireguard: { wg0: { "private-key": "P", address: ["10.0.0.1/24"], peer: { phone: { "preshared-key": "S", "public-key": "PUB" } } } } },
  };
  const s = JSON.stringify(redact(cfg));
  for (const secret of ['"$6$x"', '"abc"', '"pw"', '"P"', '"S"']) assert.ok(!s.includes(secret), secret);
  for (const kept of ["h.example.com", "10.0.0.1/24", "PUB", '"gw"']) assert.ok(s.includes(kept), kept);
});
