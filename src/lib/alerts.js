// Alerts: compares what the router looks like now with last time and says
// what changed (internet down/back, new device, Dynamic DNS failing, router
// restarted, VPN device connected). Pure: the caller polls and delivers.

export const KINDS = {
  internet: "Internet down / back",
  device: "New device joined",
  ddns: "Dynamic DNS update failed",
  reboot: "Router restarted",
  vpn: "VPN device connected",
};
export const DEFAULT_ON = { internet: true, device: true, ddns: true, reboot: true, vpn: false };

const DDNS_BAD = /fail|bad|abuse|noconnect|nohost|notfqdn|error|911|dnserr/i;
const FAILS_FOR_DOWN = 2; // checks in a row before "internet down" (one lost ping isn't an outage)
const MAX_DEVICE_ALERTS = 5;

/**
 * prev: state from the last call (or {} the first time, or what was saved for this router).
 * now: { at (ms), internetOk (bool|null), devices: [{mac, ip, name}], ddns: [{host, status}],
 *        uptime (s|null), vpn: [{key, name, handshake (unix s)}] }
 * Returns { state, alerts: [{kind, text, level}] }. Nothing is reported for
 * things seen for the first time (no "new device" flood on first run).
 */
export function evaluate(prev, now) {
  const alerts = [];
  const add = (kind, text, level = "info") => alerts.push({ kind, text, level });
  const state = { ...prev };

  // internet
  if (now.internetOk === true) {
    if (prev.downSince) add("internet", `Internet is back (down for ${duration(now.at - prev.downSince)}).`, "ok");
    state.fails = 0;
    state.downSince = null;
  } else if (now.internetOk === false) {
    state.fails = (prev.fails || 0) + 1;
    if (state.fails === FAILS_FOR_DOWN && !prev.downSince) {
      state.downSince = prev.firstFail || now.at;
      add("internet", "Internet is down: the router can't reach the internet.", "bad");
    }
    if (state.fails === 1) state.firstFail = now.at;
  }

  // devices
  if (now.devices) {
    const known = new Set(prev.known || []);
    const fresh = now.devices.filter((d) => d.mac && !known.has(d.mac));
    if (prev.known) {
      for (const d of fresh.slice(0, MAX_DEVICE_ALERTS)) add("device", `New device joined: ${d.name || "unnamed device"} (${[d.ip, d.mac].filter(Boolean).join(", ")}).`);
      if (fresh.length > MAX_DEVICE_ALERTS) add("device", `…and ${fresh.length - MAX_DEVICE_ALERTS} more new devices.`);
    }
    state.known = [...known, ...fresh.map((d) => d.mac)];
  }

  // Dynamic DNS: report a host once when it starts failing, and when it recovers
  if (now.ddns) {
    const bad = new Set(prev.ddnsBad || []);
    const nowBad = new Set();
    for (const e of now.ddns) {
      if (DDNS_BAD.test(e.status || "")) {
        nowBad.add(e.host);
        if (!bad.has(e.host)) add("ddns", `Dynamic DNS couldn't update ${e.host} (${e.status}). Devices using this name may not find your router.`, "bad");
      } else if (bad.has(e.host) && e.status) {
        add("ddns", `Dynamic DNS for ${e.host} is working again.`, "ok");
      }
    }
    state.ddnsBad = [...nowBad];
  }

  // restart: uptime went down
  if (now.uptime != null) {
    if (prev.uptime != null && now.uptime < prev.uptime) add("reboot", `The router restarted (up for ${duration(now.uptime * 1000)}).`, "warn");
    state.uptime = now.uptime;
  }

  // VPN: a device whose handshake turned fresh
  if (now.vpn) {
    const was = new Set(prev.vpnOn || []);
    const on = now.vpn.filter((p) => p.handshake && now.at / 1000 - p.handshake < 180);
    if (prev.vpnOn) for (const p of on) if (!was.has(p.key)) add("vpn", `${p.name || "A VPN device"} connected to the VPN.`);
    state.vpnOn = on.map((p) => p.key);
  }

  state.at = now.at;
  return { state, alerts };
}

export function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "less than a minute";
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  if (hrs < 48) return `${hrs} h${m % 60 ? ` ${m % 60} min` : ""}`;
  return `${Math.floor(hrs / 24)} days`;
}
