// Which devices look up a domain: Technitium query-log entries grouped by
// client. Pure (tested with npm test).

/** Start of a Technitium stats period, as an ISO time. */
export function periodStart(period, now = Date.now()) {
  const hours = { LastHour: 1, LastDay: 24, LastWeek: 24 * 7, LastMonth: 24 * 30 }[period] || 1;
  return new Date(now - hours * 3600_000).toISOString();
}

/**
 * entries: query-log entries ({ clientIpAddress, timestamp, responseType }).
 * names: Map ip -> device name. Returns [{ ip, name, hits, blocked, last }],
 * most lookups first.
 */
export function domainClients(entries, names) {
  names = names || new Map();
  const by = new Map();
  for (const e of entries || []) {
    const ip = e.clientIpAddress;
    if (!ip) continue;
    const c = by.get(ip) || { ip, name: names.get(ip) || "", hits: 0, blocked: 0, last: 0 };
    c.hits++;
    if (/Blocked/i.test(e.responseType || "")) c.blocked++;
    c.last = Math.max(c.last, Date.parse(e.timestamp) || 0);
    by.set(ip, c);
  }
  return [...by.values()].sort((a, b) => b.hits - a.hits || b.last - a.last);
}
