// Per-device traffic from the router's connection table (conntrack with
// accounting on). Two snapshots a few seconds apart give rates; each
// connection is split into the LAN device's upload and download.
// Pure: no API calls, so it can be tested with plain Node.

/**
 * Which side of a connection is the LAN device.
 * Outbound (device opened it): orig = device -> remote.
 * Inbound (port forward): orig = remote -> router WAN, reply comes from the device.
 * Returns { client, remote, port, upKey, downKey } or null (router's own traffic).
 */
export function orient(f, isLan) {
  if (isLan(f.src)) return { client: f.src, remote: f.dst, port: f.dport, upKey: "origBytes", downKey: "replyBytes" };
  if (f.replySrc && isLan(f.replySrc)) return { client: f.replySrc, remote: f.src, port: f.dport, upKey: "replyBytes", downKey: "origBytes", inbound: true };
  return null;
}

/** True when the router counts bytes per connection (sysctl nf_conntrack_acct = 1). */
export function accountingOn(flows) {
  return flows.some((f) => (f.bytes || 0) > 0);
}

export function createSampler() {
  let prev = null; // { at, bytes: Map id -> { up, down } }
  return {
    reset() {
      prev = null;
    },
    /**
     * flows: conntrack entries; now: ms timestamp; isLan(ip).
     * Returns { ready, clients: Map ip -> stats, remotes: Map "client|remote" -> stats }
     * where stats = { down, up (bytes/s), totalDown, totalUp (bytes in open connections), conns }.
     */
    sample(flows, now, isLan) {
      const dt = prev ? (now - prev.at) / 1000 : 0;
      const ready = !!prev && dt > 0.5;
      const bytes = new Map();
      const clients = new Map();
      const remotes = new Map();
      const add = (map, key, init, up, down, rUp, rDown) => {
        const s = map.get(key) || { ...init, down: 0, up: 0, totalDown: 0, totalUp: 0, conns: 0 };
        s.totalUp += up;
        s.totalDown += down;
        s.up += rUp;
        s.down += rDown;
        s.conns += 1;
        map.set(key, s);
      };
      for (const f of flows) {
        const o = orient(f, isLan);
        if (!o) continue;
        const up = f[o.upKey] || 0;
        const down = f[o.downKey] || 0;
        const key = f.id || `${f.proto}|${f.src}|${f.sport}|${f.dst}|${f.dport}`;
        bytes.set(key, { up, down });
        let rUp = 0;
        let rDown = 0;
        if (ready) {
          // A connection missing from the last snapshot started since then: all its bytes are new.
          const p = prev.bytes.get(key) || { up: 0, down: 0 };
          rUp = Math.max(0, up - p.up) / dt;
          rDown = Math.max(0, down - p.down) / dt;
        }
        add(clients, o.client, { ip: o.client }, up, down, rUp, rDown);
        add(remotes, `${o.client}|${o.remote}`, { client: o.client, remote: o.remote, port: o.port, proto: f.proto, inbound: !!o.inbound }, up, down, rUp, rDown);
      }
      prev = { at: now, bytes };
      return { ready, clients, remotes };
    },
  };
}
