// Traffic Rules (UniFi-style): block the internet or specific sites for chosen
// devices, networks or everyone, always or on a schedule. Each rule is one
// forward-chain firewall rule described "VyGi rule <id>: <name>", with groups
// VYGI-R<id> (mac-group / network-group / domain-group). Pure: no API calls.
import { toArray } from "./vyos.js";

const FWD = ["firewall", "ipv4", "forward", "filter", "rule"];
const GROUP = ["firewall", "group"];
export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DESC_RE = /^VyGi rule (\d+): (.*)$/;
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

const gname = (id) => `VYGI-R${id}`;

/** Day names from VyOS "Sun,Mon" / "0,1" / "Sunday" -> [0..6]. */
function parseDays(v) {
  return String(v || "").split(/[\s,]+/).filter(Boolean).map((d) => (/^\d$/.test(d) ? Number(d) : DAYS.findIndex((x) => d.toLowerCase().startsWith(x.toLowerCase())))).filter((d) => d >= 0);
}

/** Rules VyGi manages, from the full config. */
export function parseRules(cfg) {
  const groups = cfg?.firewall?.group || {};
  const out = [];
  for (const [n, r] of Object.entries(cfg?.firewall?.ipv4?.forward?.filter?.rule || {})) {
    const m = String(r?.description || "").match(DESC_RE);
    if (!m) continue;
    const id = m[1];
    const g = gname(id);
    const macs = toArray(groups["mac-group"]?.[g]?.["mac-address"]).map((x) => x.toLowerCase());
    const networks = toArray(groups["network-group"]?.[g]?.network);
    const domains = toArray(groups["domain-group"]?.[g]?.address);
    const t = r?.time || {};
    out.push({
      n, id, name: m[2],
      enabled: !("disable" in (r || {})),
      block: domains.length ? "sites" : "internet",
      domains,
      targets: { kind: macs.length ? "devices" : networks.length ? "networks" : "all", macs, networks },
      schedule: t.starttime || t.weekdays ? { kind: "times", start: t.starttime || "00:00", stop: t.stoptime || "23:59", days: t.weekdays ? parseDays(t.weekdays) : [0, 1, 2, 3, 4, 5, 6] } : { kind: "always" },
    });
  }
  return out.sort((a, b) => Number(a.id) - Number(b.id));
}

/** "Every day, 22:00–07:00" / "Mon–Fri, 08:00–15:00" / "Always". */
export function describeSchedule(s) {
  if (!s || s.kind !== "times") return "Always";
  const d = [...new Set(s.days)].sort();
  let days;
  if (d.length === 7) days = "Every day";
  else if (d.join() === "1,2,3,4,5") days = "Mon–Fri";
  else if (d.join() === "0,6") days = "Weekends";
  else if (d.join() === "0,1,2,3,4") days = "Sun–Thu (school nights)";
  else days = d.map((x) => DAYS[x]).join(", ");
  return `${days}, ${s.start}–${s.stop}`;
}

const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Whether the rule blocks right now (date in the router's time zone). Overnight ranges count from the start day. */
export function activeNow(rule, date = new Date()) {
  if (!rule.enabled) return false;
  const s = rule.schedule;
  if (!s || s.kind !== "times") return true;
  const now = date.getHours() * 60 + date.getMinutes();
  const day = date.getDay();
  const a = mins(s.start);
  const b = mins(s.stop);
  if (a <= b) return s.days.includes(day) && now >= a && now < b;
  // overnight: VyOS matches the weekday of the moment itself, so 22:00–07:00 on Sun means Sun 22-24 and Sun 0-7
  return s.days.includes(day) && (now >= a || now < b);
}

/** Lowest free number in a range given used numbers. */
function freeNumber(used, from, to) {
  for (let n = from; n <= to; n++) if (!used.has(n)) return n;
  throw new Error(`No free firewall rule numbers between ${from} and ${to}`);
}

/**
 * Commands to create or replace a rule.
 * spec: { name, block: "internet"|"sites", domains (text), targets: "devices"|"networks"|"all",
 *         macs: [mac], networks: [cidr], schedule: "always"|"times", days: [0..6], start, stop, enabled }
 */
export function ruleCommands(cfg, spec, existing = null) {
  const name = String(spec.name || "").trim().replace(/['"]/g, "");
  if (!name || name.length > 48) throw new Error("Give the rule a name (up to 48 characters)");
  const cmds = [];
  const set = (path, value) => cmds.push({ op: "set", path, value });
  const del = (path) => cmds.push({ op: "delete", path });
  const rules = cfg?.firewall?.ipv4?.forward?.filter?.rule || {};
  const used = new Set(Object.keys(rules).map(Number));

  let id;
  let n;
  if (existing) {
    id = existing.id;
    n = existing.n;
    del([...FWD, n]);
    for (const kind of ["mac-group", "network-group", "domain-group"]) if (cfg?.firewall?.group?.[kind]?.[gname(id)]) del([...GROUP, kind, gname(id)]);
  } else {
    const ids = new Set(parseRules(cfg).map((r) => Number(r.id)));
    id = String(freeNumber(ids, 1, 999));
    // Early in the chain, so a later "allow" rule can't let blocked traffic through.
    n = String(freeNumber(used, 1, 99));
  }
  const g = gname(id);

  // who
  if (spec.targets === "devices") {
    const macs = [...new Set((spec.macs || []).map((m) => String(m).toLowerCase()))];
    if (!macs.length) throw new Error("Choose at least one device");
    for (const m of macs) if (!MAC_RE.test(m)) throw new Error(`Bad MAC address ${m}`);
    for (const m of macs) set([...GROUP, "mac-group", g, "mac-address"], m);
    set([...FWD, n, "source", "group", "mac-group"], g);
  } else if (spec.targets === "networks") {
    const nets = [...new Set(spec.networks || [])];
    if (!nets.length) throw new Error("Choose at least one network");
    for (const c of nets) if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(c)) throw new Error(`Bad network ${c}`);
    for (const c of nets) set([...GROUP, "network-group", g, "network"], c);
    set([...FWD, n, "source", "group", "network-group"], g);
  } else if (spec.targets !== "all") {
    throw new Error("Choose who the rule applies to");
  }

  // what
  if (spec.block === "sites") {
    const domains = [...new Set(String(spec.domains || "").toLowerCase().split(/[\s,]+/).map((d) => d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\*\./, "")).filter(Boolean))];
    if (!domains.length) throw new Error("Enter at least one site, e.g. tiktok.com");
    for (const d of domains) if (!DOMAIN_RE.test(d)) throw new Error(`Not a domain name: ${d}`);
    const all = new Set();
    for (const d of domains) {
      all.add(d);
      if (d.split(".").length === 2) all.add(`www.${d}`);
    }
    for (const d of all) set([...GROUP, "domain-group", g, "address"], d);
    set([...FWD, n, "destination", "group", "domain-group"], g);
  } else if (spec.block !== "internet") {
    throw new Error("Choose what to block");
  } else if (spec.targets === "all") {
    throw new Error("Blocking the internet for everyone isn't a traffic rule; pick devices or networks");
  }

  // when
  if (spec.schedule === "times") {
    const start = String(spec.start || "").trim();
    const stop = String(spec.stop || "").trim();
    if (!TIME_RE.test(start) || !TIME_RE.test(stop)) throw new Error("Times as HH:MM, e.g. 22:00");
    if (start === stop) throw new Error("Start and end time are the same");
    const days = [...new Set((spec.days || []).map(Number))].sort();
    if (!days.length) throw new Error("Pick at least one day");
    set([...FWD, n, "time", "starttime"], start);
    set([...FWD, n, "time", "stoptime"], stop);
    if (days.length < 7) set([...FWD, n, "time", "weekdays"], days.map((d) => DAYS[d]).join(","));
  }

  set([...FWD, n, "action"], "reject");
  set([...FWD, n, "description"], `VyGi rule ${id}: ${name}`);
  if (spec.enabled === false) cmds.push({ op: "set", path: [...FWD, n, "disable"] });
  return cmds;
}

export function deleteRuleCommands(cfg, rule) {
  const cmds = [{ op: "delete", path: [...FWD, rule.n] }];
  for (const kind of ["mac-group", "network-group", "domain-group"]) if (cfg?.firewall?.group?.[kind]?.[gname(rule.id)]) cmds.push({ op: "delete", path: [...GROUP, kind, gname(rule.id)] });
  return cmds;
}

export function toggleCommands(rule, enabled) {
  return [{ op: enabled ? "delete" : "set", path: [...FWD, rule.n, "disable"] }];
}
