import { test } from "node:test";
import assert from "node:assert/strict";
import { securityFindings } from "../src/lib/secure.js";

const ctx = { wan: "eth0", wanCidr: "203.0.113.0/24", mgmtHost: "192.168.1.1", defaultPassword: false, user: "vyos" };
const ids = (f) => f.map((x) => x.id).sort();

test("fresh router: open to the internet, reboot revert", () => {
  const f = securityFindings({}, ctx);
  assert.deepEqual(ids(f), ["revert-reboot", "wan-input"]);
  const wan = f.find((x) => x.id === "wan-input");
  const l = wan.fix.map((c) => `${c.op} ${c.path.join(" ")} ${c.value ?? ""}`.trim());
  assert.ok(l.includes("set firewall ipv4 input filter rule 9900 action drop"));
  assert.ok(l.includes("set firewall ipv4 input filter rule 9900 state new"));
  assert.ok(l.includes("set firewall ipv6 input filter rule 9890 destination port 546"));
  assert.ok(l.includes("set firewall ipv6 input filter rule 9900 inbound-interface name eth0"));
});

test("well set up router: nothing to report", () => {
  const cfg = {
    firewall: { ipv4: { input: { filter: { "default-action": "drop" } } }, ipv6: { input: { filter: { rule: { 5: { action: "drop", "inbound-interface": { name: "eth0" }, state: "new" } } } } } },
    system: { "config-management": { "commit-confirm": { action: "reload" } } },
  };
  assert.deepEqual(securityFindings(cfg, ctx), []);
});

test("narrow drop rules don't count; connected via WAN gets no fix", () => {
  const cfg = { firewall: { ipv4: { input: { filter: { rule: { 5: { action: "drop", protocol: "tcp", destination: { port: "22" } } } } } } } };
  const f = securityFindings(cfg, { ...ctx, mgmtHost: "203.0.113.7" }).find((x) => x.id === "wan-input");
  assert.equal(f.fix, null);
  assert.match(f.text, /cut VyGi off/);
});

test("default password, open DNS", () => {
  const cfg = { service: { dns: { forwarding: { "allow-from": ["192.168.1.0/24", "0.0.0.0/0"] } } } };
  const f = securityFindings(cfg, { ...ctx, defaultPassword: true });
  assert.deepEqual(ids(f), ["dns-open", "password", "revert-reboot", "wan-input"]);
  assert.deepEqual(f.find((x) => x.id === "dns-open").fix, [{ op: "delete", path: ["service", "dns", "forwarding", "allow-from", "0.0.0.0/0"] }]);
  const only = securityFindings({ service: { dns: { forwarding: { "allow-from": "0.0.0.0/0" } } } }, ctx).find((x) => x.id === "dns-open");
  assert.equal(only.fix, null);
});

test("API open to every address: allow only my networks plus VyGi", () => {
  const cfg = {
    interfaces: { ethernet: { eth0: { address: ["dhcp"] }, eth1: { address: ["192.168.1.1/24"] } }, loopback: { lo: {} } },
    service: { https: { api: { keys: { id: { vygi: { key: "short" } } } } }, ssh: { port: "22" } },
  };
  const f = securityFindings(cfg, { ...ctx, vygiAddr: "10.8.0.5" });
  const api = f.find((x) => x.id === "api-open");
  assert.deepEqual(api.fix.map((c) => c.value), ["192.168.1.0/24", "10.8.0.5/32"]);
  assert.ok(api.fix.every((c) => c.path.join(" ") === "service https allow-client address"));
  // VyGi already inside a LAN: no extra /32
  assert.deepEqual(securityFindings(cfg, { ...ctx, vygiAddr: "192.168.1.20" }).find((x) => x.id === "api-open").fix.map((c) => c.value), ["192.168.1.0/24"]);
  // unknown VyGi address: advice only
  assert.equal(securityFindings(cfg, ctx).find((x) => x.id === "api-open").fix, null);
  assert.ok(f.some((x) => x.id === "api-key-short" && !x.fix));
  assert.deepEqual(f.find((x) => x.id === "ssh-guess").fix, [{ op: "set", path: ["service", "ssh", "dynamic-protection"] }]);
});

test("API limited, long key, SSH protected: no API/SSH findings", () => {
  const cfg = { service: {
    https: { "allow-client": { address: "192.168.1.0/24" }, api: { keys: { id: { vygi: { key: "a-very-long-random-key-123" } } } } },
    ssh: { "dynamic-protection": {} },
  } };
  assert.ok(!securityFindings(cfg, ctx).some((x) => ["api-open", "api-key-short", "ssh-guess"].includes(x.id)));
  assert.ok(!securityFindings({ service: { ssh: { "disable-password-authentication": {} } } }, ctx).some((x) => x.id === "ssh-guess"));
});
