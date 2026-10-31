// Connection state, the Safe Mode / Save toolbar, and the shared "apply" helper.
import { api, errorText } from "./api.js";
import { setTitle } from "./platform.js";
import { setStatus, toast, h } from "./dom.js";
import { confirmBox, modal } from "./dialog.js";
import { checkChange } from "./doctor.js";
import { describeChange, wantsPreview, commandLine } from "./describe.js";
import { routerContext } from "./routerctx.js";
import { addEntry, updateEntry, settlePending, parseRevisions } from "./history.js";

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
  setTitle(info ? `${info.hostname} (${info.profile?.host}) - VyGi` : "VyGi");
  listeners.forEach((fn) => fn(session));
  renderToolbar();
}

export function isConnected() {
  return !!session.info;
}

/** "Save changes automatically" (on by default): saves after Confirm, or right after applying without Safe Mode. */
export function autoSave() {
  return document.getElementById("auto-save")?.checked ?? false;
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
export async function applyChanges(commands, what = "Changes", { check = true } = {}) {
  if (check) commands = await reviewChange(commands, what);
  let minutes = safeMinutes();
  // VyOS commits changes to its own HTTPS API in the background and its
  // commit-confirm then undoes them, so Safe Mode can't be used for these.
  if (minutes && commands.some((c) => c.path[0] === "service" && c.path[1] === "https")) {
    if (!(await confirmBox("Apply without Safe Mode?",
      "This changes the router's HTTPS API, the connection VyGi uses. VyOS undoes such changes when they're made with Safe Mode, so this one is applied directly: there's no automatic undo.\n\nThe API restarts, so VyGi pauses for about 30 seconds. If VyGi can't reach the router afterwards, SSH still works: log in and run \"configure\", \"delete service https allow-client\", \"commit\".",
      "Apply"))) throw new Error("Cancelled: nothing was changed.");
    minutes = 0;
  }
  setStatus(`Applying: ${what}…`);
  let tx;
  try {
    tx = await withForeignPending(() => api.applyChanges(commands, minutes, what));
  } catch (e) {
    setStatus(`${what} failed: ${errorText(e).split("\n")[0]}`, true);
    throw e;
  }
  applyTx(tx);
  if (/confirmed automatically/.test(tx.message || "") && session.info) settlePending(session.info.profileId, "kept");
  remember(what, minutes);
  const auto = /confirmed automatically/.test(tx.message || "") ? "Previous Safe Mode changes kept. " : "";
  if (!minutes && autoSave()) await quietSave();
  setStatus(auto + (minutes ? `${what} applied. Press Confirm within ${minutes} min or the router reverts them.` : `${what} applied${autoSave() && !session.unsaved ? " and saved" : ""}.`));
  listeners.forEach((fn) => fn(session));
  return tx;
}

/** Adds the change to this router's history, with the revision it made (for Undo). */
function remember(what, minutes) {
  const router = session.info?.profileId;
  if (!router) return;
  const e = addEntry(router, { what, pending: minutes > 0 });
  api.listRevisions().then((t) => {
    const top = parseRevisions(t)[0];
    if (top) updateEntry(router, e.id, { stamp: top.stamp });
  }).catch(() => {});
}


/**
 * Before a change: would it cause problems elsewhere? Shows what else VyGi
 * would change (only its own settings) and anything you should know, and
 * asks. Returns the commands to apply; throws if you cancel.
 */
/** When to show a change before applying it: always, big (removals, many steps), never. */
export function previewMode() {
  try {
    return localStorage.getItem("vygi.preview") || "big";
  } catch {
    return "big";
  }
}
export function setPreviewMode(v) {
  try {
    localStorage.setItem("vygi.preview", v);
  } catch {
    /* not remembered */
  }
}

async function reviewChange(commands, what) {
  let cfg;
  let env;
  try {
    [cfg, env] = await Promise.all([api.getConfig([]), routerContext()]);
  } catch {
    return commands; // can't check (e.g. not connected): VyOS still validates the change
  }
  const { extras, warnings } = checkChange(cfg || {}, commands, env);
  const preview = wantsPreview(previewMode(), commands);
  if (!extras.length && !warnings.length && !preview) return commands;
  const boxes = extras.map((x) => h("input", { type: "checkbox", checked: true }));
  const VERB = { add: ["ok", "Add"], change: ["info", "Change"], remove: ["bad", "Remove"], on: ["ok", "Turn on"], off: ["warn", "Turn off"] };
  const steps = describeChange(cfg || {}, commands);
  const body = h("div.review", { style: { width: "560px" } },
    h("p", extras.length || warnings.length ? `Before applying "${what}", VyGi checked how it fits with the rest of your setup.` : `"${what}" will:`),
    h("div.change-list", steps.map((d) => h("div.change-item",
      h(`span.pill.${VERB[d.verb][0]}`, VERB[d.verb][1]),
      h("span", h("b", d.label), d.name ? h("span.hint", ` · ${d.name}`) : "",
        d.details.length ? h("div.hint", d.details.join(" · ") + (d.more ? ` · +${d.more} more` : "")) : "")))),
    h("details.change-cmds", h("summary", `The ${commands.length} VyOS command${commands.length === 1 ? "" : "s"}`), h("pre", commands.map(commandLine).join("\n"))),
    extras.length ? h("div", h("h4", "VyGi will also change these, so nothing breaks:"),
      extras.map((x, i) => h("label.review-item", boxes[i], h("span", h("b", x.finding.title), h("span.hint", ` ${x.finding.text}`))))) : null,
    warnings.length ? h("div", h("h4", "Worth knowing:"),
      warnings.map((w) => h("div.review-item", h(`span.pill.${w.level === "bad" ? "bad" : "warn"}`, w.level === "bad" ? "problem" : "note"), h("span", h("b", w.title), h("span.hint", ` ${w.text}`))))) : null,
    h("div.hint", "Settings made in Advanced or by hand are never changed automatically."));
  const r = await modal(extras.length || warnings.length ? "Check before applying" : "Apply this change?", body, [
    { label: "Cancel", value: "cancel" },
    { label: warnings.length && !extras.length ? "Apply anyway" : "Apply", value: "apply", primary: true },
  ]);
  if (r !== "apply") throw new Error("Cancelled: nothing was changed.");
  return [...commands, ...extras.filter((_, i) => boxes[i].checked).flatMap((x) => x.commands)];
}

/** Updates the toolbar from a TxStatus returned by a command. */
export function applyTxStatus(tx) {
  applyTx(tx);
  listeners.forEach((fn) => fn(session));
}

/**
 * Runs a commit; if another change (another window, the CLI) is waiting for
 * Confirm, asks whether to keep it and then retries once.
 */
async function withForeignPending(run) {
  try {
    return await run();
  } catch (e) {
    if (e?.kind !== "ForeignPending") throw e;
    const keep = await confirmBox("Another change is waiting",
      "Another change on this router is waiting for Confirm: from another VyGi window, the command line, or someone else.\n\nKeep that change (Confirm it) and continue with yours? If you aren't sure what it is, cancel and let it revert first.",
      "Keep it and continue");
    if (!keep) throw new Error("Cancelled: another change is waiting for Confirm on this router.");
    await api.confirmCommit();
    return run();
  }
}

export async function rollbackTo(rev, what = `roll back to revision ${rev}`) {
  const minutes = safeMinutes();
  const tx = await withForeignPending(() => api.rollbackTo(rev, minutes));
  applyTx(tx);
  remember(what, minutes);
  if (!minutes && autoSave()) await quietSave();
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
  const connectLabel = document.getElementById("connect-label");
  if (connectLabel) connectLabel.textContent = connected ? "Disconnect" : "Connect";
  else document.getElementById("btn-connect").textContent = connected ? "Disconnect" : "Connect";
  document.getElementById("btn-connect").title = connected ? "Disconnect" : "Connect to a router";
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
      if (session.info) settlePending(session.info.profileId, "reverted");
      setStatus("Safe Mode timer expired: the router reverted the unconfirmed changes.", true);
      listeners.forEach((fn) => fn(session));
    }
  }

  const sub = document.getElementById("conn-sub");
  if (connected) {
    const i = session.info;
    label.textContent = i.profile.name || i.hostname; // the name it's saved under, as in the router switcher
    label.title = `${i.profile.sshUser}@${i.hostname} (${i.profile.host}) — VyOS ${i.version}`;
    sub.textContent = `${i.profile.host} · VyOS ${i.version}`;
  } else {
    label.textContent = "Not connected";
    label.title = "";
    sub.textContent = "Click to pick or add a router";
  }
  label.classList.toggle("on", connected);
  document.getElementById("conn-dot").classList.toggle("on", connected);
  document.getElementById("app").classList.toggle("connected", connected);
}

export function initToolbar() {
  document.getElementById("btn-confirm").addEventListener("click", async () => {
    try {
      applyTx(await api.confirmCommit());
      if (session.info) settlePending(session.info.profileId, "kept");
      if (autoSave() && (await quietSave())) {
        setStatus("Changes confirmed and saved.");
      } else {
        setStatus("Changes confirmed and kept.", false, { silent: true });
        // Confirm keeps a change running; only Save keeps it after a reboot.
        toast("Changes kept. They'll be lost if the router restarts, until you Save.", { action: { label: "Save now", fn: saveNow } });
      }
    } catch (e) {
      setStatus(errorText(e), true);
    }
  });
  document.getElementById("btn-save").addEventListener("click", saveNow);
  const auto = document.getElementById("auto-save");
  try {
    auto.checked = localStorage.getItem("vygi.autosave") !== "0";
  } catch {
    auto.checked = true;
  }
  auto.addEventListener("change", () => {
    try {
      localStorage.setItem("vygi.autosave", auto.checked ? "1" : "0");
    } catch {
      /* stays for this session */
    }
  });
  setInterval(renderToolbar, 1000);
  renderToolbar();
}

/** Saves without asking; false (with a message) if it failed. */
async function quietSave() {
  try {
    applyTx(await api.saveConfig());
    return true;
  } catch (e) {
    setStatus(`Applied, but saving failed: ${errorText(e)}`, true);
    return false;
  }
}

/** Writes the running config to the boot config (asks first if a Safe Mode change is unconfirmed). */
export async function saveNow() {
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
}
