// "Set up this router": a checklist of the basics (internet, a home network,
// the router's password, security, saving, backups and alerts, the clock),
// each with its state and a button to fix it. Opens by itself the first
// time VyGi connects to a router that misses something; later from
// Dashboard, Settings > System or the search bar.
import { api, errorText } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { modal, alertBox, confirmBox } from "../lib/dialog.js";
import { session, onSessionChange, isConnected, applyChanges } from "../lib/session.js";
import { showView } from "../lib/views.js";
import { isDesktop } from "../lib/platform.js";
import { wanInfo, wanProblem, mgmtAddress } from "../lib/wan.js";
import { toArray, flattenInterfaces } from "../lib/vyos.js";
import { readInternet, describeInternet } from "../lib/wanconf.js";
import { readNetworks } from "../lib/netplan.js";
import { loadFindings, changePassword } from "./security.js";
import { openIdentityClock } from "./resources.js";
import { openMakeRouter } from "./makerouter.js";

const seenKey = () => `vygi.setup.${session.info?.profileId || "?"}`;
// Raised when the checklist gains items, so it opens once more on routers
// that were set up before (2: router address, VyGi's own login with a key).
const VERSION = 2;
/** The checklist version last shown for this router (0: never). */
function seenVersion() {
  try {
    return Number(localStorage.getItem(seenKey())) || 0;
  } catch {
    return VERSION; // can't remember: don't keep opening it
  }
}
function markSeen() {
  try {
    localStorage.setItem(seenKey(), String(VERSION));
  } catch {
    /* not remembered */
  }
}

/** The checklist: [{ title, ok: true|false|"warn", text, action?: [label, fn] }]. */
async function checks() {
  const host = session.info?.profile?.host;
  const user = session.info?.profile?.sshUser || "vyos";
  const [cfg, w, findings, watch, mgmt, routes] = await Promise.all([
    api.getConfig([]).then((c) => c || {}),
    wanInfo(),
    loadFindings().catch(() => []),
    isDesktop ? Promise.resolve(null) : api.watchGet().catch(() => null),
    mgmtAddress(host),
    api.routes(4, "default").catch(() => []),
  ]);
  const close = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const go = (view, tab) => () => {
    close();
    showView(view, { tab });
  };
  const conn = readInternet(cfg, w.wan);
  const nets = readNetworks(cfg, w.wan);
  const risks = findings.filter((f) => f.level === "bad" && f.needs !== "password");
  const auto = document.getElementById("auto-save");
  const tz = cfg?.system?.["time-zone"];
  const problem = wanProblem(w.wanIp);
  const list = [
    {
      title: "Internet",
      ok: w.wanIp ? (problem ? "warn" : true) : false,
      text: w.wanIp
        ? `${conn.manual ? "Set up by hand" : describeInternet(conn)} on ${w.wan}: ${w.wanIp}.${problem ? ` ${problem.text}` : ""}`
        : "The router has no internet address. Choose how it connects (from the modem, PPPoE login, fixed address).",
      action: ["Internet settings", go("settings", "internet")],
    },
    {
      title: "Home network",
      ok: nets.length > 0,
      text: nets.length ? `${nets.map((n) => `${n.name} (${n.network})`).join(", ")}.` : "No network for your devices yet: create one with DHCP so devices get addresses.",
      action: [nets.length ? "Networks" : "Create one", go("networks")],
    },
    addressCheck(cfg, host, mgmt, routes),
    ownLogin(user),
    {
      title: "Router password",
      ok: !session.info?.defaultPassword,
      text: session.info?.defaultPassword ? `The ${session.info?.profile?.sshUser || "vyos"} login still has the factory password: anyone on your network can log in.` : "Not the factory password.",
      action: session.info?.defaultPassword ? ["Change it", () => changePassword(() => {})] : null,
    },
    {
      title: "Security check",
      ok: risks.length ? false : findings.length ? "warn" : true,
      text: risks.length ? risks.map((f) => f.title).join(" · ") : findings.length ? `${findings.length} suggestion${findings.length === 1 ? "" : "s"}, nothing serious.` : "No common problems found.",
      action: findings.length ? ["Review", go("settings", "router")] : null,
    },
    {
      title: "Save changes automatically",
      ok: !!auto?.checked,
      text: auto?.checked ? "Changes are saved to the boot config once confirmed, so they survive a restart." : "Off: changes are lost when the router restarts unless you press Save.",
      action: auto && !auto.checked ? ["Turn on", () => {
        auto.checked = true;
        auto.dispatchEvent(new Event("change"));
        refresh();
      }] : null,
    },
    isDesktop
      ? { title: "Backups", ok: true, text: "The settings are saved on this computer each time VyGi connects and they changed.", action: ["Backups", go("settings", "router")] }
      : {
          title: "24/7 watching, backups and alerts",
          ok: !!watch?.router?.enabled,
          text: watch?.router?.enabled
            ? `On: backups every 6 hours when the settings change, alerts${watch.notify?.ntfyUrl || watch.notify?.webhookUrl ? " sent to your phone" : " in VyGi (phone notifications: off)"}.`
            : "Off: the VyGi server only backs up and records when you're connected, and can't alert you.",
          action: ["Open", () => {
            close();
            document.getElementById("btn-alerts")?.click();
          }],
        },
    {
      title: "Clock and time zone",
      ok: tz && tz !== "UTC" ? true : "warn",
      text: tz && tz !== "UTC" ? `${tz}. Schedules (Traffic Rules) follow it.` : "UTC: Traffic Rules schedules run on UTC time unless you set your time zone.",
      action: ["Change", () => openIdentityClock().then(refresh)],
    },
  ];
  return list;
}

/** VyGi's own router login: a login of its own, then an SSH key instead of a password. */
function ownLogin(user) {
  const title = "VyGi's own login";
  if (user !== "vygi") {
    return {
      title, ok: "warn",
      text: `VyGi logs in as ${user}, the same login you use. With its own login, your password isn't stored in VyGi, the router's change history shows what VyGi changed, and you can shut VyGi out without touching your login. (Every VyOS login can change everything: this doesn't limit what VyGi can do.)`,
      action: ["Make one", async () => {
        if (!(await confirmBox(title,
          `VyGi creates the router login "vygi" with an SSH key that only VyGi keeps, checks that it works, and uses it from then on. The vygi login gets no password anyone knows, so it can only log in with that key.\n\nYour ${user} login doesn't change.`, "Make it"))) return;
        try {
          await api.useOwnLogin();
          session.info.profile.sshUser = "vygi";
          await api.useSshKey();
          session.info.keyLogin = true;
        } catch (e) {
          alertBox(title, errorText(e));
        }
        refresh();
      }],
    };
  }
  if (session.info?.keyLogin) return { title, ok: true, text: "VyGi logs in as vygi with its own SSH key; that login has no password anyone knows." };
  return {
    title, ok: "warn",
    text: "VyGi logs in as vygi with a password. An SSH key is stronger: it can't be guessed, and VyGi then turns off password login for vygi.",
    action: ["Use a key", async () => {
      if (!(await confirmBox(title,
        "VyGi makes an SSH key, adds it to the vygi login on the router and checks that it works. Then vygi's password is replaced with a random one nobody keeps, so vygi can only log in with the key.\n\nYour own login doesn't change.", "Use a key"))) return;
      try {
        await api.useSshKey();
        session.info.keyLogin = true;
      } catch (e) {
        alertBox(title, errorText(e));
      }
      refresh();
    }],
  };
}

/** The address VyGi reaches the router on: fixed, or from DHCP (and then it can change). */
function addressCheck(cfg, host, mgmt, routes) {
  const title = "Router address";
  if (!mgmt) return { title, ok: true, text: `VyGi reaches the router at ${host}.` };
  const it = flattenInterfaces(cfg.interfaces).get(mgmt.iface);
  const addrs = toArray(it?.cfg?.address).map(String);
  if (!it || addrs.some((a) => a.split("/")[0] === host) || !addrs.includes("dhcp")) {
    return { title, ok: true, text: `${host} on ${mgmt.iface}, set on the router.` };
  }
  const def = routes.find((r) => r.dst === "default" && r.dev === mgmt.iface);
  const gw = def?.gateway || "";
  return {
    title, ok: "warn",
    text: `${host} on ${mgmt.iface} comes from DHCP, so it can change, and then VyGi can't find the router. Make it fixed, and on the router that handed it out, reserve it (or use an address outside its DHCP range).`,
    action: ["Make it fixed", async () => {
      const commands = [
        { op: "set", path: [...it.path, "address"], value: mgmt.cidr },
        { op: "delete", path: [...it.path, "address", "dhcp"] },
      ];
      // DHCP also gave the router its way out and its DNS server: keep them
      if (gw && !cfg.protocols?.static?.route?.["0.0.0.0/0"]) commands.push({ op: "set", path: ["protocols", "static", "route", "0.0.0.0/0", "next-hop", gw] });
      if (gw && !cfg.system?.["name-server"]) commands.push({ op: "set", path: ["system", "name-server"], value: gw });
      try {
        await applyChanges(commands, `Fixed address ${mgmt.cidr} on ${mgmt.iface}`);
      } catch (e) {
        if (!/^Cancelled/.test(e?.message || "")) alertBox("Router address", errorText(e));
      }
      refresh();
    }],
  };
}

let body = null;
async function refresh() {
  const el = body; // the checklist may be closed while this runs
  if (!el) return;
  let list;
  try {
    list = await checks();
  } catch (e) {
    if (el.isConnected) clear(el).append(h("div.err-box", errorText(e)));
    return;
  }
  if (!el.isConnected) return;
  const todo = list.filter((c) => c.ok !== true).length;
  const basics = list.slice(0, 2).some((c) => c.ok === false); // no internet or no home network
  clear(el).append(
    basics ? h("div.setup-make",
      h("div.grow", h("b", "Make it a router"), h("div.hint", "Set up the internet, a home network, DHCP, NAT and a basic firewall together, in one change.")),
      h("button.primary", { on: { click: () => openMakeRouter().then(refresh) } }, "Make it a router…")) : "",
    h("p.hint", { style: { marginTop: 0 } }, todo ? `${todo} thing${todo === 1 ? "" : "s"} to look at. Every change goes through Safe Mode.` : "All set."),
    h("div.setup-list", list.map((c) => h("div.setup-item",
      h(`span.setup-mark.${c.ok === true ? "ok" : c.ok === "warn" ? "warn" : "bad"}`, c.ok === true ? "✓" : "!"),
      h("div.grow", h("b", c.title), h("div.hint", c.text)),
      c.action ? h("button", { on: { click: c.action[1] } }, c.action[0]) : ""))));
  return todo;
}

export async function openSetup() {
  if (!isConnected()) return alertBox("Set up", "Connect to a router first.");
  body = h("div.setup", { style: { width: "600px" } }, h("div.hint", "Checking the router…"));
  const shown = modal(`Set up ${session.info?.hostname || "this router"}`, body, [{ label: "Done", value: "ok", primary: true }]);
  refresh();
  await shown;
  body = null;
  markSeen();
}

/**
 * First connection to a router that misses one of the basics: open the
 * checklist once. After the checklist gained items, it opens once more if
 * anything on it isn't done.
 */
export function initSetup() {
  let last = null;
  onSessionChange(async (s) => {
    const id = s.info?.profileId || null;
    if (!id || id === last) {
      last = id;
      return;
    }
    last = id;
    const shown = seenVersion();
    if (shown >= VERSION) return;
    // let the connect check-up and its dialogs finish first
    for (let i = 0; i < 30 && document.querySelector(".modal-back"); i++) await new Promise((r) => setTimeout(r, 1000));
    await new Promise((r) => setTimeout(r, 1500));
    if (session.info?.profileId !== id || document.querySelector(".modal-back")) return;
    try {
      const list = await checks();
      if (list.some((c) => c.ok === false || (shown > 0 && c.ok !== true))) openSetup();
      else markSeen();
    } catch {
      /* try again next time */
    }
  });
}
