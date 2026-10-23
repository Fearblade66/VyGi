// Helpers for VyOS config JSON (as returned by /retrieve showConfig).

/** Multi-value nodes come back as a string or an array; normalise to array. */
export function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Valueless nodes like `disable` come back as `{}`; presence is what matters. */
export function has(cfg, key) {
  return !!cfg && Object.prototype.hasOwnProperty.call(cfg, key);
}

/**
 * Flattens `interfaces` config into kernel interface names:
 * eth0 -> ["interfaces","ethernet","eth0"], eth0.10 -> [..., "vif", "10"],
 * eth0.100.20 -> [..., "vif-s", "100", "vif-c", "20"].
 */
export function flattenInterfaces(ifaces) {
  const out = new Map();
  for (const [type, members] of Object.entries(ifaces || {})) {
    for (const [name, cfg] of Object.entries(members || {})) {
      const base = ["interfaces", type, name];
      out.set(name, { type, path: base, cfg: cfg || {} });
      for (const [vid, vcfg] of Object.entries(cfg?.vif || {})) {
        out.set(`${name}.${vid}`, { type: `${type} vlan`, path: [...base, "vif", vid], cfg: vcfg || {} });
      }
      for (const [sid, scfg] of Object.entries(cfg?.["vif-s"] || {})) {
        out.set(`${name}.${sid}`, { type: `${type} QinQ`, path: [...base, "vif-s", sid], cfg: scfg || {} });
        for (const [cid, ccfg] of Object.entries(scfg?.["vif-c"] || {})) {
          out.set(`${name}.${sid}.${cid}`, { type: `${type} QinQ`, path: [...base, "vif-s", sid, "vif-c", cid], cfg: ccfg || {} });
        }
      }
    }
  }
  return out;
}

/** Diff two value lists into set/delete commands for `path + [leaf]`. */
export function diffMulti(path, leaf, before, after) {
  const cmds = [];
  for (const v of before) if (!after.includes(v)) cmds.push({ op: "delete", path: [...path, leaf, v] });
  for (const v of after) if (!before.includes(v)) cmds.push({ op: "set", path: [...path, leaf], value: v });
  return cmds;
}

/** set or delete a single-value leaf depending on whether it changed / is empty. */
export function diffSingle(path, leaf, before, after) {
  before = before == null ? "" : String(before);
  after = after == null ? "" : String(after).trim();
  if (before === after) return [];
  if (!after) return [{ op: "delete", path: [...path, leaf] }];
  return [{ op: "set", path: [...path, leaf], value: after }];
}

/** Valid VyOS node name (keeps typos from producing confusing API errors). */
export function validNodeName(s) {
  return /^[A-Za-z0-9._@:\/-]{1,64}$/.test(s);
}
