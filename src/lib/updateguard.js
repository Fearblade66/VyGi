// After a VyOS update (Settings > System > Update now): when VyGi reaches the
// router again, keep the new version, or say that the router went back to the
// old one by itself (upgrade.rs). The update being waited for is remembered
// per router in this browser.
import { api, errorText } from "./api.js";
import { toast } from "./dom.js";
import { alertBox, confirmBox } from "./dialog.js";
import { session, onSessionChange } from "./session.js";

const key = () => `vygi.update.${session.info?.profileId || "?"}`;
function remembered(v) {
  try {
    if (v === undefined) return JSON.parse(localStorage.getItem(key()) || "null");
    if (v === null) localStorage.removeItem(key());
    else localStorage.setItem(key(), JSON.stringify(v));
  } catch {
    return null;
  }
  return v;
}

/** Called right before restarting into a new image: { old, new }. */
export function rememberUpdate(st) {
  remembered({ old: st.old, new: st.new, at: Date.now() });
}

/** Go back to the version before the last update (Settings > System). */
export async function goBack() {
  let st;
  try {
    st = await api.updateGuardStatus();
  } catch (e) {
    return alertBox("Go back", errorText(e));
  }
  const old = st.pending ? st.old : st.previous;
  if (!old || old === st.running) return alertBox("Go back", "There's no earlier version to go back to (VyGi only knows the one before an update it installed).");
  if (!(await confirmBox("Go back to the old VyOS?", `The router makes ${old} the default again and restarts into it (about 2 minutes without internet). Your settings as they were before the update come back with it.`, "Go back and restart"))) return;
  try {
    await api.updateRollbackNow();
    remembered(null);
    toast(`Restarting into ${old}…`);
  } catch (e) {
    alertBox("Go back", errorText(e));
  }
}

async function check() {
  const want = remembered();
  let st;
  try {
    st = await api.updateGuardStatus();
  } catch {
    return; // older router or no SSH: nothing to do
  }
  if (st.pending && st.running === st.new) {
    const kept = await api.updateGuardConfirm().catch(() => null);
    if (kept) toast(`VyOS ${kept} is running and VyGi reaches the router: the update is kept. (System > Router > Go back undoes it.)`, { timeout: 15000 });
    remembered(null);
  } else if (want && !st.pending && st.running === want.old) {
    toast(`The update to VyOS ${want.new} wasn't confirmed in time, so the router went back to ${want.old}.`, { error: true, timeout: 30000 });
    remembered(null);
  } else if (want && !st.pending && st.running === want.new) {
    remembered(null); // kept already (by the VyGi server or another window)
  }
}

export function initUpdateGuard() {
  let last = null;
  onSessionChange((s) => {
    const id = s.info?.profileId || null;
    if (id && id !== last) check();
    last = id;
  });
}
