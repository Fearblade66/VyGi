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

/** Reads a nested value: getPath(rule, ["source", "address"]). */
export function getPath(node, path) {
  let n = node;
  for (const k of path) {
    if (n == null || typeof n !== "object" || Array.isArray(n)) return undefined;
    n = n[k];
  }
  return n;
}

/** Writes a nested value; `undefined` removes it (and empty parents). */
export function setPath(node, path, value) {
  const [k, ...rest] = path;
  if (!rest.length) {
    if (value === undefined) delete node[k];
    else node[k] = value;
    return;
  }
  if (node[k] == null || typeof node[k] !== "object" || Array.isArray(node[k])) {
    if (value === undefined) return;
    node[k] = {};
  }
  setPath(node[k], rest, value);
  if (value === undefined && !Object.keys(node[k]).length) delete node[k];
}

/** Turns a config subtree back into `set` commands rooted at `path`. */
export function toCommands(node, path) {
  if (typeof node === "string") return [{ op: "set", path, value: node }];
  if (Array.isArray(node)) return node.map((v) => ({ op: "set", path, value: String(v) }));
  const entries = Object.entries(node || {});
  if (!entries.length) return [{ op: "set", path }];
  return entries.flatMap(([k, v]) => toCommands(v, [...path, k]));
}

function ipv4ToInt(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

/** True if IPv4 `ip` is inside `cidr` (e.g. "192.168.1.0/24"). */
export function ipv4InCidr(ip, cidr) {
  const [net, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(net);
  if (a == null || b == null || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) >>> 0 === (b & mask) >>> 0;
}
