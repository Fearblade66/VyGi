import { test } from "node:test";
import assert from "node:assert/strict";
import { siteOf, siteFromOrg, prettyOrg, answerIps, ipDomainMap, groupSites, flagEmoji, isPrivateIp } from "../src/lib/sites.js";

test("siteOf groups CDNs under their brand and others by registrable domain", () => {
  assert.equal(siteOf("r3---sn-abc.googlevideo.com").name, "YouTube");
  assert.equal(siteOf("i.ytimg.com.").icon, "youtube.com");
  assert.equal(siteOf("stats.g.doubleclick.net").name, "Google Ads & Analytics");
  assert.equal(siteOf("www.google.com").name, "Google");
  assert.equal(siteOf("ipv4-c001.1.oca.nflxvideo.net").name, "Netflix");
  assert.equal(siteOf("api.example.com").name, "example.com");
  assert.equal(siteOf("news.bbc.co.uk").name, "bbc.co.uk");
  assert.equal(siteOf("notgoogle.com").name, "notgoogle.com");
});

test("siteFromOrg names networks", () => {
  assert.equal(siteFromOrg("GOOGLE", 15169).name, "Google");
  assert.equal(siteFromOrg("Hetzner Online GmbH", 24940).name, "Hetzner Online GmbH");
  assert.equal(siteFromOrg("", null).key, "unknown");
  assert.equal(prettyOrg("DIGITALOCEAN-ASN"), "Digitalocean Asn");
});

test("query log answers map IPs to the newest domain", () => {
  assert.deepEqual(answerIps("edge.example.net., 1.2.3.4, 2001:db8::1"), ["1.2.3.4", "2001:db8::1"]);
  assert.deepEqual(answerIps(""), []);
  const m = ipDomainMap([
    { qname: "new.example.com", answer: "1.2.3.4", responseType: "Recursive" },
    { qname: "old.example.com", answer: "1.2.3.4", responseType: "Cached" },
    { qname: "ads.example.com", answer: "0.0.0.0", responseType: "Blocked" },
  ]);
  assert.equal(m.get("1.2.3.4"), "new.example.com");
  assert.equal(m.has("0.0.0.0"), false);
});

test("groupSites sums traffic per site with countries", () => {
  const remotes = [
    { remote: "1.1.1.1", down: 100, up: 10, totalDown: 1000, totalUp: 50, conns: 2 },
    { remote: "2.2.2.2", down: 300, up: 0, totalDown: 3000, totalUp: 0, conns: 1 },
    { remote: "8.8.8.8", down: 0, up: 0, totalDown: 10, totalUp: 10, conns: 1 },
  ];
  const map = new Map([["1.1.1.1", "rr1.googlevideo.com"], ["2.2.2.2", "i.ytimg.com"]]);
  const geo = { "1.1.1.1": { country: "US" }, "2.2.2.2": { country: "NL" }, "8.8.8.8": { country: "US", org: "GOOGLE", asn: 15169 } };
  const sites = groupSites(remotes, map, geo);
  assert.equal(sites[0].name, "YouTube");
  assert.equal(sites[0].down, 400);
  assert.equal(sites[0].conns, 3);
  assert.deepEqual([...sites[0].countries].sort(), ["NL", "US"]);
  assert.equal(sites[1].name, "Google");
  assert.deepEqual([...sites[1].orgs], ["Google"]);
});

test("helpers", () => {
  assert.equal(flagEmoji("us"), "🇺🇸");
  assert.equal(flagEmoji("xyz"), "");
  assert.equal(isPrivateIp("192.168.1.5"), true);
  assert.equal(isPrivateIp("100.64.0.1"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("fd00::1"), true);
});
