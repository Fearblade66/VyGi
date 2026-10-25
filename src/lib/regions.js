// Region blocking (UniFi-style): no traffic to or from chosen countries,
// using VyOS firewall GeoIP matching (DB-IP data the router downloads itself).
// Rules are described "VyGi region block (...)". Pure: no API calls.

/** Country codes VyOS accepts for `geoip country-code`. */
export const COUNTRY_CODES = "ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug um us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw".split(" ");

const DESC = "VyGi region block";
// [family, chain, direction]: in = from those countries, out = to them
const PLACES = [
  ["ipv4", "input", "source"],
  ["ipv4", "forward", "source"],
  ["ipv4", "forward", "destination"],
  ["ipv6", "input", "source"],
  ["ipv6", "forward", "source"],
  ["ipv6", "forward", "destination"],
];
const what = (chain, dir) => (chain === "input" ? "to the router" : dir === "source" ? "in" : "out");
const toArr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** Current region block: { countries: ["cn", ...], rules: [{ fam, chain, n }] }. */
export function parseRegions(cfg) {
  const rules = [];
  const countries = new Set();
  for (const [fam, chain] of [["ipv4", "input"], ["ipv4", "forward"], ["ipv6", "input"], ["ipv6", "forward"]]) {
    for (const [n, r] of Object.entries(cfg?.firewall?.[fam]?.[chain]?.filter?.rule || {})) {
      if (!String(r?.description || "").startsWith(DESC)) continue;
      rules.push({ fam, chain, n });
      for (const dir of ["source", "destination"]) for (const c of toArr(r?.[dir]?.geoip?.["country-code"])) countries.add(c);
    }
  }
  return { countries: [...countries].sort(), rules };
}

/** Commands to block exactly `countries` (empty = turn region blocking off). */
export function regionCommands(cfg, countries) {
  const list = [...new Set(countries.map((c) => String(c).toLowerCase()))].sort();
  for (const c of list) if (!COUNTRY_CODES.includes(c)) throw new Error(`Unknown country code ${c}`);
  const cur = parseRegions(cfg);
  const cmds = cur.rules.map((r) => ({ op: "delete", path: ["firewall", r.fam, r.chain, "filter", "rule", r.n] }));
  if (!list.length) return cmds;
  const freed = new Map(); // "fam/chain" -> numbers we just deleted (reused first)
  for (const r of cur.rules) freed.set(`${r.fam}/${r.chain}`, [...(freed.get(`${r.fam}/${r.chain}`) || []), Number(r.n)]);
  const taken = new Map();
  const take = (fam, chain) => {
    const k = `${fam}/${chain}`;
    if (!taken.has(k)) {
      const used = new Set(Object.keys(cfg?.firewall?.[fam]?.[chain]?.filter?.rule || {}).map(Number));
      for (const n of freed.get(k) || []) used.delete(n);
      taken.set(k, used);
    }
    const used = taken.get(k);
    // early, so the block runs before any allow rule (VPN, port forwards)
    for (let n = 1; n <= 99; n++) if (!used.has(n)) { used.add(n); return String(n); }
    throw new Error(`No free firewall rule numbers between 1 and 99 in ${fam} ${chain}`);
  };
  for (const [fam, chain, dir] of PLACES) {
    const b = ["firewall", fam, chain, "filter", "rule", take(fam, chain)];
    cmds.push({ op: "set", path: [...b, "action"], value: "drop" });
    for (const c of list) cmds.push({ op: "set", path: [...b, dir, "geoip", "country-code"], value: c });
    cmds.push({ op: "set", path: [...b, "description"], value: `${DESC} (${what(chain, dir)})` });
  }
  return cmds;
}
