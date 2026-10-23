// Thin wrappers around the Rust commands (src-tauri/src/*.rs).
import { invoke, Channel } from "@tauri-apps/api/core";

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

  txStatus: () => invoke("tx_status"),
  getConfig: (path) => invoke("get_config", { path }),
  runShow: (path) => invoke("run_show", { path }),
  applyChanges: (commands, confirmMinutes) => invoke("apply_changes", { commands, confirmMinutes }),
  confirmCommit: () => invoke("confirm_commit"),
  saveConfig: () => invoke("save_config"),
  listRevisions: () => invoke("list_revisions"),
  revisionDiff: (rev, rev2 = null) => invoke("revision_diff", { rev, rev2 }),
  rollbackTo: (rev, confirmMinutes) => invoke("rollback_to", { rev, confirmMinutes }),
  setRevertAction: (action) => invoke("set_revert_action", { action }),

  interfaceStats: () => invoke("interface_stats"),
  routes: (family, vrf) => invoke("routes", { family, vrf }),
  wireguardDump: () => invoke("wireguard_dump"),

  /** Opens a streaming SSH command. `onEvent` gets {event:"data"|"closed", data}. */
  async openStream(kind, onEvent) {
    const ch = new Channel();
    ch.onmessage = onEvent;
    return invoke("open_stream", { kind, onData: ch });
  },
  async openTerminal(cols, rows, onEvent) {
    const ch = new Channel();
    ch.onmessage = onEvent;
    return invoke("open_terminal", { cols, rows, onData: ch });
  },
  termWrite: (id, data) => invoke("term_write", { id, data }),
  termResize: (id, cols, rows) => invoke("term_resize", { id, cols, rows }),
  closeSession: (id) => invoke("close_session", { id }),
};
