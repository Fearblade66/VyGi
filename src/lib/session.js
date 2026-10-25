// Connection state, the Safe Mode / Save toolbar, and the shared "apply" helper.
import { api, errorText } from "./api.js";
import { setStatus } from "./dom.js";
import { confirmBox } from "./dialog.js";

const listeners = new Set();
export const session = {
  info: null, // ConnectInfo from Rust, null when disconnected
  confirmDeadline: null, // ms timestamp when the router auto-reverts
  unsaved: false,
};

export function onSessionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setConnected(info) {
  session.info = info;
  session.confirmDeadline = null;
  session.unsaved = false;
  document.title = info ? `${info.hostname} (${info.profile?.host}) - VyGi` : "VyGi";
  listeners.forEach((fn) => fn(session));
  renderToolbar();
}

export function isConnected() {
  return !!session.info;
}

function safeMinutes() {
  const on = document.getElementById("safe-mode").checked;
  return on ? Number(document.getElementById("safe-minutes").value) : 0;
}

function applyTx(tx) {
  session.unsaved = tx.unsaved;
  session.confirmDeadline = tx.confirmSecondsLeft != null ? Date.now() + tx.confirmSecondsLeft * 1000 : null;
  renderToolbar();
}

/**
 * Commits config changes, honouring Safe Mode.
 * commands: [{op: "set"|"delete", path: [...], value?}]
 * Throws on failure (the caller shows the error).
 */
export async function applyChanges(commands, what = "Changes") {
  const minutes = safeMinutes();
  setStatus(`Applying: ${what}…`);
  let tx;
  try {
    tx = await api.applyChanges(commands, minutes);
  } catch (e) {
    setStatus(`${what} failed: ${errorText(e).split("\n")[0]}`, true);
    throw e;
  }
  applyTx(tx);
  const auto = /confirmed automatically/.test(tx.message || "") ? "Previous Safe Mode changes kept. " : "";
  setStatus(auto + (minutes ? `${what} applied. Press Confirm within ${minutes} min or the router reverts them.` : `${what} applied.`));
  listeners.forEach((fn) => fn(session));
  return tx;
}

/** Updates the toolbar from a TxStatus returned by a command. */
export function applyTxStatus(tx) {
  applyTx(tx);
  listeners.forEach((fn) => fn(session));
}

export async function rollbackTo(rev) {
  const tx = await api.rollbackTo(rev, safeMinutes());
  applyTx(tx);
  listeners.forEach((fn) => fn(session));
}

export async function refreshTx() {
  try {
    applyTx(await api.txStatus());
  } catch {
    /* not connected */
  }
}

function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function renderToolbar() {
  const connected = isConnected();
  const btnConfirm = document.getElementById("btn-confirm");
  const btnSave = document.getElementById("btn-save");
  const label = document.getElementById("conn-label");
  document.getElementById("btn-connect").textContent = connected ? "Disconnect" : "Connect";
  document.getElementById("btn-terminal").disabled = !connected;
  btnSave.disabled = !connected;
  btnSave.classList.toggle("badge-unsaved", connected && session.unsaved);
  btnSave.textContent = connected && session.unsaved ? "Save ●" : connected ? "Saved" : "Save";
  btnSave.title = connected && session.unsaved ? "Unsaved changes: write the running config to the boot config" : "Write running config to the boot config";

  const left = session.confirmDeadline ? session.confirmDeadline - Date.now() : 0;
  if (connected && left > 0) {
    btnConfirm.hidden = false;
    btnConfirm.textContent = `Confirm (${fmtCountdown(left)})`;
  } else {
    btnConfirm.hidden = true;
    if (session.confirmDeadline && left <= 0) {
      session.confirmDeadline = null;
      setStatus("Safe Mode timer expired: the router reverted the unconfirmed changes.", true);
      listeners.forEach((fn) => fn(session));
    }
  }

  const sub = document.getElementById("conn-sub");
  if (connected) {
    const i = session.info;
    label.textContent = i.hostname;
    label.title = `${i.profile.sshUser}@${i.hostname} (${i.profile.host}) — VyOS ${i.version}`;
    sub.textContent = `${i.profile.host} · VyOS ${i.version}`;
  } else {
    label.textContent = "Not connected";
    label.title = "";
    sub.textContent = "Connect to manage a router";
  }
  label.classList.toggle("on", connected);
  document.getElementById("conn-dot").classList.toggle("on", connected);
  document.getElementById("app").classList.toggle("connected", connected);
}

export function initToolbar() {
  document.getElementById("btn-confirm").addEventListener("click", async () => {
    try {
      applyTx(await api.confirmCommit());
      setStatus("Changes confirmed and kept.");
    } catch (e) {
      setStatus(errorText(e), true);
    }
  });
  document.getElementById("btn-save").addEventListener("click", async () => {
    if (session.confirmDeadline) {
      const ok = await confirmBox("Save", "There are unconfirmed Safe Mode changes. Saving now writes them to the boot config even if they later revert in the running config.\n\nConfirm first unless you are sure.", "Save anyway");
      if (!ok) return;
    }
    try {
      applyTx(await api.saveConfig());
      setStatus("Configuration saved: it will survive a reboot.");
    } catch (e) {
      setStatus(errorText(e), true);
    }
  });
  setInterval(renderToolbar, 1000);
  renderToolbar();
}
