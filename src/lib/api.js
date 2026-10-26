// Thin wrappers around the Rust commands (src-tauri/src/*.rs).
import { call, stream, newWindow } from "./platform.js";

// Pages often ask for the same thing at once (the whole config was read 35
// times in one tour of the pages, and the router answers one at a time).
// These reads share one router call for a few seconds; anything that can
// change the router clears them. Live counters (traffic, connections) are
// never shared: their speeds come from the difference between two reads.
const SHARED_MS = { get_config: 5000, routes: 5000, dhcp_leases: 5000, neighbors: 3000 };
const CHANGES = new Set(["connect", "disconnect", "apply_changes", "confirm_commit", "rollback_to", "set_revert_action",
  "history_restore", "import_config", "import_config_text", "change_login_password", "image_add", "image_set_default",
  "image_delete", "power", "term_write", "accounting_sync"]);
const shared = new Map(); // "cmd args" -> { at, promise }

export function clearShared() {
  shared.clear();
}

function invoke(cmd, args) {
  const ttl = SHARED_MS[cmd];
  if (!ttl) {
    if (CHANGES.has(cmd)) shared.clear();
    const p = call(cmd, args);
    // the router may have changed even if the call failed
    if (CHANGES.has(cmd)) p.finally(() => shared.clear()).catch(() => {});
    return p;
  }
  const key = `${cmd} ${JSON.stringify(args ?? null)}`;
  // part of the config: take it from a fresh copy of the whole config if there is one
  const whole = cmd === "get_config" && args?.path?.length ? shared.get(`get_config ${JSON.stringify({ path: [] })}`) : null;
  if (whole && Date.now() - whole.at <= ttl) {
    return whole.promise.then((cfg) => {
      let node = cfg;
      for (const k of args.path) node = node && typeof node === "object" ? node[k] : undefined;
      return node === undefined ? {} : structuredClone(node);
    });
  }
  let hit = shared.get(key);
  if (!hit || Date.now() - hit.at > ttl) {
    hit = { at: Date.now(), promise: call(cmd, args) };
    shared.set(key, hit);
    hit.promise.catch(() => shared.get(key) === hit && shared.delete(key));
  }
  // each caller gets its own copy, so one page can't change another's data
  return hit.promise.then((v) => (v && typeof v === "object" ? structuredClone(v) : v));
}

export function errorText(e) {
  if (e && typeof e === "object" && e.message) return e.message;
  return String(e);
}

export const api = {
  listRouters: () => invoke("list_routers"),
  hasSavedSecrets: (id) => invoke("has_saved_secrets", { id }),
  forgetRouter: (id) => invoke("forget_router", { id }),
  connect: (req) => invoke("connect", { req }),
  disconnect: () => invoke("disconnect"),
  newWindow,
  changeLoginPassword: (newPassword) => invoke("change_login_password", { newPassword }),
  ddnsStatus: () => invoke("ddns_status"),
  routerTime: () => invoke("router_time"),
  wakeOnLan: (iface, mac) => invoke("wake_on_lan", { interface: iface, mac }),
  speedTest: () => invoke("speed_test"),
  // web server only: 24/7 watching and its recordings
  watchGet: () => invoke("watch_get"),
  watchSet: (patch) => invoke("watch_set", patch),
  watchNotifySet: (notify) => invoke("watch_notify_set", { notify }),
  watchNotifyTest: () => invoke("watch_notify_test"),
  watchAlerts: (since, limit) => invoke("watch_alerts", { since, limit }),
  watchTraffic: (hours) => invoke("watch_traffic", { hours }),
  watchDevices: (days) => invoke("watch_devices", { days }),
  watchLogs: (query, days, maxPriority, limit) => invoke("watch_logs", { query, days, maxPriority, limit }),
  watchFlows: (hours, query, kind, limit) => invoke("watch_flows", { hours, query, kind, limit }),
  ddnsUpdateNow: () => invoke("ddns_update_now"),
  geoipStatus: () => invoke("geoip_status"),
  geoipUpdate: () => invoke("geoip_update"),
  geoipLookup: (ips) => invoke("geoip_lookup", { ips }),
  siteIcons: (domains) => invoke("site_icons", { domains }),
  dnsServerLink: () => invoke("dns_server_link"),
  dnsServerSetup: (req) => invoke("dns_server_setup", req),
  dnsServerForget: () => invoke("dns_server_forget"),
  dnsServer: (endpoint, params = {}) => invoke("dns_server_call", { endpoint, params }),

  txStatus: () => invoke("tx_status"),
  getConfig: (path) => invoke("get_config", { path }),
  runShow: (path) => invoke("run_show", { path }),
  // what: a plain description for the web version's activity log
  applyChanges: (commands, confirmMinutes, what = "") => invoke("apply_changes", { commands, confirmMinutes, what }),
  confirmCommit: () => invoke("confirm_commit"),
  saveConfig: () => invoke("save_config"),
  listRevisions: () => invoke("list_revisions"),
  revisionDiff: (rev, rev2 = null) => invoke("revision_diff", { rev, rev2 }),
  rollbackTo: (rev, confirmMinutes) => invoke("rollback_to", { rev, confirmMinutes }),
  setRevertAction: (action) => invoke("set_revert_action", { action }),

  interfaceStats: () => invoke("interface_stats"),
  routes: (family, vrf) => invoke("routes", { family, vrf }),
  wireguardDump: () => invoke("wireguard_dump"),
  dhcpLeases: (family) => invoke("dhcp_leases", { family }),
  wireguardKeypair: () => invoke("wireguard_keypair"),
  wireguardPsk: () => invoke("wireguard_psk"),
  saveTextFile: (file, contents) => invoke("save_text_file", { file, contents }),
  systemLoad: () => invoke("system_load"),
  systemInfo: () => invoke("system_info"),
  neighbors: () => invoke("neighbors"),
  lldpNeighbors: () => invoke("lldp_neighbors"),
  connections: () => invoke("connections"),
  pingLatency: (target) => invoke("ping_latency", { target }),
  ipScan: (network) => invoke("ip_scan", { network }),
  processes: () => invoke("processes"),
  imageList: () => invoke("image_list"),
  imageAdd: (url) => invoke("image_add", { url }),
  updateCheck: () => invoke("update_check"),
  accountingSync: () => invoke("accounting_sync"),
  clientAddress: () => invoke("client_address"),
  portInfo: () => invoke("port_info"),
  imageSetDefault: (name) => invoke("image_set_default", { name }),
  imageDelete: (name) => invoke("image_delete", { name }),
  power: (action) => invoke("power", { action }),
  connectCheckup: () => invoke("connect_checkup"),
  historyList: () => invoke("history_list"),
  historyDiff: (id) => invoke("history_diff", { id }),
  historyRestore: (id, confirmMinutes) => invoke("history_restore", { id, confirmMinutes }),
  exportConfig: (file, format) => invoke("export_config", { file, format }),
  importConfig: (file, confirmMinutes) => invoke("import_config", { file, confirmMinutes }),
  exportConfigText: (format) => invoke("export_config_text", { format }),
  importConfigText: (text, confirmMinutes) => invoke("import_config_text", { text, confirmMinutes }),

  /** Opens a streaming SSH command. `onEvent` gets {event:"data"|"closed", data}. */
  openStream: (kind, onEvent) => stream("open_stream", { kind }, onEvent),
  openTorch: (iface, filter, hidePort, onEvent) => stream("open_torch", { interface: iface, filter, hidePort }, onEvent),
  openTerminal: (cols, rows, onEvent) => stream("open_terminal", { cols, rows }, onEvent),
  termWrite: (id, data) => invoke("term_write", { id, data }),
  termResize: (id, cols, rows) => invoke("term_resize", { id, cols, rows }),
  closeSession: (id) => invoke("close_session", { id }),
};
