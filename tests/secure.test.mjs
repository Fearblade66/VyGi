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

test("edge readiness: installer, nightly build, other logins, IPv6 to devices", async () => {
  const { securityFindings, usesIpv6, wanBlocked } = await import("../src/lib/secure.js");
  const ids = (cfg, ctx) => securityFindings(cfg, ctx).map((f) => f.id);
  const base = { wan: "eth0", user: "vygi" };
  assert.ok(ids({}, { ...base, live: true }).includes("live"));
  assert.ok(ids({}, { ...base, version: "2026.10.23-0026-rolling" }).includes("rolling"));
  assert.ok(!ids({}, { ...base, version: "1.5.0" }).includes("rolling"));
  const pw = securityFindings({}, { ...base, defaultUsers: ["vyos"] }).find((f) => f.id === "password:vyos");
  assert.equal(pw.user, "vyos");
  assert.equal(pw.needs, "password");
  // VyGi's own login found both ways: reported once
  assert.equal(securityFindings({}, { ...base, defaultPassword: true, defaultUsers: ["vygi"] }).filter((f) => f.id.startsWith("password")).length, 1);

  const v6 = { interfaces: { ethernet: { eth0: { address: "dhcp", "dhcpv6-options": { pd: { 0: {} } } }, eth1: { address: ["10.0.0.1/24"] } } } };
  assert.ok(usesIpv6(v6, "eth0"));
  assert.ok(!usesIpv6({ interfaces: { ethernet: { eth0: { address: "dhcp" }, eth1: { address: ["10.0.0.1/24"] } } } }, "eth0"));
  const f = securityFindings(v6, base).find((x) => x.id === "wan-forward6");
  assert.ok(f && f.fix.length === 4);
  // after the fix, the forward chain counts as blocked and the finding goes
  const rule = {};
  for (const c of f.fix) if (c.op === "set") rule[c.path[6] === "inbound-interface" ? "inbound-interface" : c.path[6]] = c.path[6] === "inbound-interface" ? { name: c.value } : c.value;
  const fixed = { ...v6, firewall: { ipv6: { forward: { filter: { rule: { 9900: rule } } } } } };
  assert.ok(wanBlocked(fixed.firewall.ipv6.forward.filter, "eth0"));
  assert.ok(!ids(fixed, base).includes("wan-forward6"));
});

test("behind another router (private internet address): advice, not a problem", () => {
  const cfg = { interfaces: { ethernet: { eth0: { address: "192.168.88.6/24" } } } };
  const wan = securityFindings(cfg, { ...ctx, wanCidr: "192.168.88.6/24", mgmtHost: "192.168.88.6" }).find((x) => x.id === "wan-input");
  assert.equal(wan.level, "warn");
  assert.match(wan.text, /private, so another router sits in front/);
  assert.match(wan.text, /won't block this for you/);
  assert.equal(wan.fix, null);
  assert.equal(securityFindings({}, ctx).find((x) => x.id === "wan-input").level, "bad");
});
