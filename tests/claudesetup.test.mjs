import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupScript, certCovers, MCP_REMOTE } from "../src/lib/claudesetup.js";

test("certificate names cover the address Claude uses", () => {
  assert.ok(certCovers(["vygi", "localhost", "127.0.0.1", "192.168.88.31"], "192.168.88.31"));
  assert.ok(!certCovers(["vygi", "localhost", "127.0.0.1"], "192.168.88.31"));
  assert.ok(certCovers(["VyGi.LAN"], "vygi.lan"));
  assert.ok(certCovers([], "anything")); // own certificate: can't tell
});

test("setup script is valid JavaScript with the settings in it", () => {
  const text = setupScript({ url: "https://192.168.88.31:8443/mcp", token: "vygi_abc", cert: "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n", apps: { code: true, desktop: false } });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vygi-setup-")), "s.mjs");
  fs.writeFileSync(file, text);
  execFileSync(process.execPath, ["--check", file]); // throws on a syntax error
  const s = JSON.parse(text.match(/^const S = (.*);$/m)[1]);
  assert.deepEqual(s, { url: "https://192.168.88.31:8443/mcp", token: "vygi_abc", cert: "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n", code: true, desktop: false, pkg: MCP_REMOTE });
  // the bare token goes in the header: no spaces or ${} placeholders for Claude to expand
  assert.ok(text.includes('"Authorization:" + S.token'));
  assert.ok(!/\$\{VYGI/.test(text));
});
