import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerOf, ownerText, manualDescription } from "../src/lib/owner.js";

test("ownerOf knows each page's descriptions", () => {
  const o = (d) => { const r = ownerOf(d); return r && [r.feature, r.name, r.view, r.tab]; };
  assert.deepEqual(o("VyGi rule 3: Kids bedtime"), ["Traffic Rules", "Kids bedtime", "rules", null]);
  assert.deepEqual(o("VyGi policy 2: IoT to NAS"), ["Network access", "IoT to NAS", "access", null]);
  assert.deepEqual(o("VyGi fwd 1: Plex"), ["Port Forwarding", "Plex", "ports", null]);
  assert.deepEqual(o("VyGi net eth2: mDNS"), ["Device discovery", "eth2", "access", null]);
  assert.deepEqual(o("VyGi net eth2: no internet"), ["Networks", "eth2", "networks", null]);
  assert.deepEqual(o("VyGi group: Kids [limit 5000/1000]"), ["Device groups", "Kids", "clients", null]);
  assert.deepEqual(o("VyGi group: Kids"), ["Device groups", "Kids", "clients", null]);
  assert.equal(o("VyGi: intrusion detection blocks")[2], "ids");
  assert.equal(o("VyGi intrusion detection (Suricata)")[2], "ids");
  assert.deepEqual(o("VyGi region block (cn ru)").slice(2), ["settings", "security"]);
  assert.deepEqual(o("VyGi VPN client: Mullvad").slice(0, 3), ["VPN client", "Mullvad", "vpn"]);
  assert.equal(o("VyGi VPN client wg1: block incoming")[2], "vpn");
  assert.equal(o("VyGi VPN wg0")[2], "vpn");
  assert.deepEqual(o("VyGi: backup internet").slice(2), ["settings", "internet"]);
  assert.deepEqual(o("VyGi: allow replies").slice(2), ["settings", "security"]);
  assert.deepEqual(o("VyGi: something new"), ["VyGi", "", null, null]);
  assert.equal(ownerOf("my own rule"), null);
  assert.equal(ownerOf(""), null);
  assert.equal(ownerOf(undefined), null);
});

test("ownerText and manualDescription", () => {
  assert.equal(ownerText(ownerOf("VyGi rule 3: Kids bedtime")), "Traffic Rules: Kids bedtime");
  assert.equal(ownerText(ownerOf("VyGi: blocked clients")), "Blocked devices");
  assert.equal(manualDescription("VyGi rule 3: Kids bedtime"), "Kids bedtime (was Traffic Rules)");
  assert.equal(manualDescription("VyGi: allow replies"), "allow replies (was Router security)");
  assert.equal(ownerOf(manualDescription("VyGi fwd 1: Plex")), null);
});
