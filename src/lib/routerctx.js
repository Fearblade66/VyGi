// What the checks (security, health check, conflict checks) need to know
// about the connected router, gathered in one place.
import { api } from "./api.js";
import { session } from "./session.js";
import { wanInfo, mgmtAddress } from "./wan.js";

let cache = { at: 0, router: null, ctx: null };

/**
 * { wan, wanCidr, wanIp, mgmtHost, mgmtIface, defaultPassword, user, vygiAddr,
 *   live, defaultUsers, version }. Kept for a minute; fresh: read it again.
 */
export async function routerContext({ fresh = false } = {}) {
  const router = session.info?.profileId;
  if (!fresh && cache.router === router && Date.now() - cache.at < 60_000) return cache.ctx;
  const host = session.info?.profile?.host;
  const [w, mgmt, vygiAddr, facts] = await Promise.all([
    wanInfo(),
    mgmtAddress(host),
    api.clientAddress().catch(() => ""),
    api.routerFacts().catch(() => ({})),
  ]);
  const ctx = {
    wan: w.wan,
    wanCidr: w.wanCidr,
    wanIp: w.wanIp,
    mgmtHost: host,
    mgmtIface: mgmt?.iface,
    defaultPassword: !!session.info?.defaultPassword,
    user: session.info?.profile?.sshUser || "vyos",
    vygiAddr,
    live: facts.live === true,
    defaultUsers: facts.defaultPasswordUsers || [],
    version: session.info?.version || "",
  };
  cache = { at: Date.now(), router, ctx };
  return ctx;
}
