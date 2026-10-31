// Settings page (UniFi-style): Internet, Security and System, each a list of
// settings with their current values. What has its own page (networks, VPN,
// traffic rules, clients) stays there. Settings VyGi didn't make (set up by
// hand in Advanced or the CLI) are shown but left alone; every change goes
// through applyChanges, so conflicts are checked first.
import { openMakeRouter } from "./makerouter.js";
import { api, errorText } from "../lib/api.js";
import { h, clear, toast, formatBits } from "../lib/dom.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges, isConnected, onSessionChange, session, previewMode, setPreviewMode } from "../lib/session.js";
import { registerView, welcome, loadingPage, viewTab } from "../lib/views.js";
import { toArray } from "../lib/vyos.js";
import { isDesktop, webSessions, webSessionEnd } from "../lib/platform.js";
import { openActivityLog } from "./activity.js";
import { openClaudeSetup } from "./claude_setup.js";
import { wanInfo, wanProblem } from "../lib/wan.js";
import { routerContext } from "../lib/routerctx.js";
import { readInternet, internetCommands, describeInternet, PD_LENGTHS, ifacePath } from "../lib/wanconf.js";
import { itemMenu, itemCommands } from "./itemref.js";
import { readNetworks } from "../lib/netplan.js";
import { protectStatus, protectOn, protectOff, smoothStatus, smoothOn, smoothOff, smoothBandwidth, adblockStatus, BLOCKLISTS } from "../lib/switches.js";
import { failoverStatus, failoverLines, failoverOn, failoverOff, backupCandidates, parseLbStatus } from "../lib/failover.js";
import { dnsState, dnsCommands, DNS_PRESETS } from "../lib/internet.js";
import { parseRegions } from "../lib/regions.js";
import { countryName, flagEmoji } from "../lib/sites.js";
import { editRegions } from "./regions_ui.js";
import { dnsServerUrl, dnsCall, setupDnsServer, openDnsServer } from "./technitium.js";
import { loadDoctor, renderDoctor, itemIssues } from "./doctor.js";
import { openDdns } from "./ddns.js";
import { openIdentityClock } from "./resources.js";
import { openBackup } from "./backup.js";
import { openSetup } from "./setup.js";
import { rememberUpdate, goBack } from "../lib/updateguard.js";

// Internet shows under Network; Router and VyGi under System (views.js)
const TABS = { internet: "Internet", router: "Router", vygi: "VyGi" };
const speedKey = () => `vygi.speed.${session.info?.profileId}`;

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
  return value;
}

function lastSpeed() {
  try {
    return JSON.parse(store(speedKey())) || null;
  } catch {
    return null;
  }
}

async function loadState() {
  const [cfg, w, routes, env] = await Promise.all([
    api.getConfig([]).then((c) => c || {}),
    wanInfo(),
    api.routes(4, "default").catch(() => []),
    routerContext(),
  ]);
  const def = routes.find((r) => r.dst === "default");
  return { cfg, env, w, wan: w.wan, wanGateway: def?.gateway || (def?.nexthops || [])[0]?.gateway || "" };
}

// The update check downloads a version list: once an hour per router is plenty.
const updateCache = new Map(); // profileId -> { at, info | error }
async function checkUpdate(force = false) {
  const key = session.info?.profileId;
  const c = updateCache.get(key);
  if (!force && c && Date.now() - c.at < 3600_000) return c;
  const r = await api.updateCheck().then((info) => ({ info }), (e) => ({ error: errorText(e) }));
  updateCache.set(key, { ...r, at: Date.now() });
  return updateCache.get(key);
}

// ---- building blocks

const section = (title, ...rows) => h("section.card.set-section", h("h3", title), ...rows);

/** A setting: title and explanation on the left, its value or control on the right. */
function row(title, hint, control, below = null) {
  return h("div.set-row",
    h("div.set-text", h("div.set-title", title), hint ? h("div.hint", hint) : null, below),
    control ? h("div.set-ctl", control) : null);
}

function value(text, cls = "") {
  return h(`span.set-value${cls}`, text);
}

/** On/off switch; fn(on) applies the change, then the page reloads. */
function toggle(on, fn, reload, { disabled = false, title = "" } = {}) {
  const sw = h("input", { type: "checkbox", checked: on, disabled, title });
  sw.addEventListener("change", async () => {
    const want = sw.checked;
    sw.disabled = true;
    try {
      await fn(want);
    } catch (e) {
      if (!/^Cancelled/.test(e?.message || "")) alertBox("Settings", errorText(e));
    }
    reload();
  });
  return h("label.switch", sw);
}

const button = (label, fn, primary = false) => h(primary ? "button.primary" : "button", { on: { click: fn } }, label);
const handMade = (what) => h("span.badge", { title: "Set up by hand (Advanced or the CLI): VyGi shows it but doesn't change it." }, `${what} set up by hand`);

export function initSettings() {
  const root = document.getElementById("settings");
  let seq = 0;
  let shownTab = null;

  async function render() {
    const my = ++seq;
    if (!isConnected()) {
      clear(root).append(welcome(() => document.getElementById("btn-connect").click()));
      return;
    }
    // a different tab: don't leave the old one up while this one loads
    if (!root.querySelector(".page") || shownTab !== viewTab("settings", "internet")) clear(root).append(loadingPage(3));
    let st;
    try {
      st = await loadState();
    } catch (e) {
      if (my === seq) clear(root).append(h("div.page", h("div.err-box", errorText(e)), h("p", button("Try again", render))));
      return;
    }
    if (my !== seq) return;
    // the tabs are under the top bar (views.js: Internet, Management, System, Change History)
    const tab = TABS[viewTab("settings", "internet")] ? viewTab("settings", "internet") : "internet";
    shownTab = tab;
    const body = { internet, router: (s, m) => [...management(s, m), ...system(s)], vygi }[tab](st, my);
    clear(root).append(h("div.page.settings", ...body));
  }

  // ================================================================ Internet

  function internet(st) {
    const { cfg, w, wan } = st;
    const ethCfg = cfg?.interfaces?.ethernet?.[wan] || {};
    const dhcp = toArray(ethCfg.address).includes("dhcp");
    const problem = wanProblem(w.wanIp);
    const sp = lastSpeed();
    let testing = false;
    const speedVal = value(sp ? `↓ ${formatBits(sp.downBps)}  ↑ ${formatBits(sp.upBps)} (${new Date(sp.at).toLocaleDateString()})` : "not measured");
    const speedBtn = button("Run speed test", async () => {
      if (testing) return;
      testing = true;
      speedBtn.disabled = true;
      speedBtn.textContent = "Testing… (about 20 s)";
      try {
        const r = await api.speedTest();
        store(speedKey(), JSON.stringify({ ...r, at: Date.now() }));
      } catch (e) {
        alertBox("Speed test", errorText(e));
      }
      render();
    });

    const conn = readInternet(cfg, wan);
    const carrier = [conn.port, conn.vlan].filter(Boolean).join(".");
    const wanPaths = [...new Set([wan, carrier].filter(Boolean))].map(ifacePath).concat([["system", "name-server"], ["protocols", "static", "route", "0.0.0.0/0"]]);
    return [
      section("Internet (WAN)",
        row("Connection", "How the router gets online: automatically from the modem (DHCP), with a username and password (PPPoE), or a fixed address. Some providers also need a VLAN tag.",
          conn.manual ? handMade("Connection") : h("span.set-inline", value(describeInternet(conn)), button("Change…", () => changeConnection(st, conn)))),
        row("Make it a router", "Internet, a home network that hands out addresses, the router as DNS server, NAT and a basic firewall, set up together in one change.",
          button("Make it a router…", () => openMakeRouter().then((ok) => ok && render()))),
        row("Internet address", dhcp ? "Given by your provider (DHCP)." : "Set by hand.", value(w.wanIp || "none"),
          problem ? h("div.warn-box", { style: { marginTop: "6px" } }, problem.text) : null),
        row("Gateway", "Your provider's router that all internet traffic goes through.", value(st.wanGateway || "–")),
        row("Dynamic DNS", "A name that follows your internet address when it changes (for the VPN and port forwards).",
          h("span.set-inline", value(w.ddns || "off"), button(w.ddns ? "Change…" : "Set up…", openDdns))),
        row("Speed", "Measured from the router itself (Cloudflare). Uses a few GB of data on a fast line.", h("span.set-inline", speedVal, speedBtn)),
        itemIssues(cfg, "internet", {}, render),
        itemCommands(cfg, wanPaths)),
      smartQueues(st),
      dnsSection(st),
      backupLine(st),
    ];
  }

  async function changeConnection(st, cur) {
    const { cfg } = st;
    const ports = Object.keys(cfg?.interfaces?.ethernet || {}).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const lans = readNetworks(cfg, cur.wan);
    const lanOpt = (n) => `${n.name} (${n.iface})`;
    let cmds = null;
    await formDialog("Internet connection", [
      { name: "port", label: "Port to the modem / ONT", type: "select", value: cur.port, options: ports },
      { name: "mode", label: "Connection type", type: "select", value: cur.mode, options: [
        { value: "dhcp", label: "Automatic (DHCP): cable, most fibre, a modem/router in front" },
        { value: "pppoe", label: "PPPoE: DSL or fibre with a username and password" },
        { value: "static", label: "Fixed address from your provider" },
      ] },
      { name: "vlan", label: "VLAN tag", value: cur.vlan, placeholder: "empty = none", hint: "Only if your provider says so (some fibre lines use e.g. 6, 7, 10 or 35). A wrong tag means no internet." },
      { name: "user", label: "PPPoE username", value: cur.user },
      { name: "password", label: "PPPoE password", type: "password", placeholder: cur.hasPassword ? "unchanged" : "" },
      { name: "staticAddr", label: "Address", value: cur.staticAddr, placeholder: "203.0.113.10/24" },
      { name: "gateway", label: "Gateway", value: cur.gateway, placeholder: "203.0.113.1" },
      { name: "dns", label: "DNS servers", value: cur.dns, placeholder: "1.1.1.1 9.9.9.9" },
      { name: "ipv6", label: "IPv6 from my provider", type: "checkbox", value: cur.ipv6 },
      { name: "pdLength", label: "Prefix size", type: "select", value: cur.pdLength, options: PD_LENGTHS.map((l) => ({ value: l, label: `/${l}${l === "56" ? " (most common)" : l === "64" ? " (one network only)" : ""}` })), hint: "What your provider hands out; /56 if unsure." },
      { name: "pdLans", label: "Networks that get IPv6", type: "multicheck", value: cur.ipv6 ? lans.filter((n) => cur.pdLans.includes(n.iface)).map(lanOpt) : lans.map(lanOpt), options: lans.map(lanOpt) },
    ], (v) => {
      const pdLans = lans.filter((n) => v.pdLans.includes(lanOpt(n))).map((n) => n.iface);
      cmds = internetCommands(cfg, cur, { ...v, pdLans }, lans.map((n) => n.iface)).cmds;
      return true;
    }, {
      okLabel: "Apply",
      intro: "The internet drops for a few seconds while the router reconnects. If VyGi reaches the router through this port and loses it, Safe Mode puts the old connection back. Port forwards, the firewall, Smart Queues and failover follow the new connection automatically.",
      initChange: true,
      onChange(_f, v, set) {
        for (const f of ["user", "password"]) set.show(f, v.mode === "pppoe");
        for (const f of ["staticAddr", "gateway", "dns"]) set.show(f, v.mode === "static");
        set.show("pdLength", v.ipv6);
        set.show("pdLans", v.ipv6);
      },
    });
    if (!cmds) return;
    if (!cmds.length) return toast("Nothing changed.");
    try {
      await applyChanges(cmds, "internet connection");
    } catch (e) {
      if (!/^Cancelled/.test(e?.message || "")) alertBox("Internet connection", errorText(e));
    }
    render();
  }

  function smartQueues(st) {
    const { cfg, wan } = st;
    const status = smoothStatus(cfg, wan);
    const bw = smoothBandwidth(cfg);
    const ask = async () => {
      const up = lastSpeed()?.upBps ? String(Math.round(lastSpeed().upBps / 1e6)) : bw ? String(Math.round(parseInt(bw, 10) / 0.9)) : "";
      let cmds = null;
      await formDialog("Smart Queues", [
        { name: "up", label: "Upload speed (Mbit/s)", value: up, hint: lastSpeed() ? "From your last speed test. Use your plan's speed if the test was low." : "Your plan's upload speed, or run the speed test above." },
      ], (v) => {
        cmds = smoothOn(cfg, wan, v.up);
        return true;
      }, { okLabel: "Apply" });
      if (!cmds) throw new Error("Cancelled");
      await applyChanges(cmds, "Smart Queues");
    };
    return section("Smart Queues",
      row("Smart Queues", "Keeps games, calls and browsing fast while something big uploads (cloud backups, photo sync). Shapes uploads to 90% of your line's speed with CAKE. Downloads aren't shaped (VyOS can't do CAKE on incoming traffic).",
        status === "manual" ? handMade("Shaping") : toggle(status === "on", (on) => (on ? ask() : applyChanges(smoothOff(cfg), "turn off Smart Queues")), render)),
      status === "on" ? row("Upload limit", "", h("span.set-inline", value(bw.replace("mbit", " Mbit/s")), button("Change…", () => ask().catch((e) => /^Cancelled/.test(e.message) || alertBox("Smart Queues", errorText(e))).then(render)))) : null);
  }

  function dnsSection(st) {
    const d = dnsState(st.cfg);
    if (!d.forwarding) {
      return section("DNS servers",
        row("DNS", "The router doesn't answer DNS for your network, so your devices use whatever servers DHCP gives them. Set it up in Advanced → IP → DNS.", value("not handled by the router")));
    }
    const options = [
      { value: "auto", label: "Auto (from your provider)" },
      ...Object.entries(DNS_PRESETS).map(([k, p]) => ({ value: k, label: p.label })),
      { value: "custom", label: "Custom" },
    ];
    const sel = h("select", options.map((o) => h("option", { value: o.value, selected: o.value === (d.mode === "mixed" ? "custom" : d.mode) }, o.label)));
    const custom = h("input", { type: "text", value: d.mode === "custom" || d.mode === "mixed" ? d.servers.join(" ") : "", placeholder: "1.1.1.1 9.9.9.9" });
    const apply = button("Apply", async () => {
      try {
        const cmds = dnsCommands(st.cfg, sel.value, custom.value);
        if (!cmds.length) return;
        await applyChanges(cmds, `DNS servers: ${options.find((o) => o.value === sel.value).label}`);
      } catch (e) {
        if (!/^Cancelled/.test(e?.message || "")) alertBox("DNS servers", errorText(e));
      }
      render();
    });
    const sync = () => (custom.hidden = sel.value !== "custom");
    sel.addEventListener("change", sync);
    sync();
    return section("DNS servers",
      row("Upstream DNS", "Where the router looks up names for your devices." + (d.mode === "mixed" ? " Now: your provider's servers plus " + d.servers.join(", ") + " (set by hand)." : ""),
        h("span.set-inline", sel, custom, apply)),
      h("div.hint.set-note", "Devices given another DNS server (e.g. Technitium through DHCP) don't use these."));
  }

  function backupLine(st) {
    const { cfg, wan } = st;
    const status = failoverStatus(cfg);
    const lines = failoverLines(cfg);
    const ports = backupCandidates(cfg, wan);
    const liveEl = h("div");
    if (status === "on") {
      api.runShow(["wan-load-balance"]).then((t) => {
        const s = parseLbStatus(t);
        const line = (iface, role) => {
          const x = s.find((l) => l.iface === iface);
          return h("div", `${role} (${iface}): `, x ? h(`span.badge${x.up ? ".ok" : ".bad"}`, x.up ? "working" : "not answering") : h("span.badge", "unknown"));
        };
        clear(liveEl).append(line(lines.main, "Main"), line(lines.backup, "Backup"));
      }).catch(() => {});
    }
    const turnOn = async () => {
      let cmds = null;
      await formDialog("Backup internet (WAN2)", [
        { name: "backup", label: "Backup line is plugged into", type: "select", value: ports[0], options: ports },
        { name: "mode", label: "It gets its address", type: "select", value: "dhcp", options: [
          { value: "dhcp", label: "automatically (most modems and hotspots)" },
          { value: "static", label: "a fixed address I enter" },
        ] },
        { name: "cidr", label: "Address", placeholder: "192.168.8.2/24" },
        { name: "gateway", label: "Gateway", placeholder: "192.168.8.1", hint: "The backup modem's own address." },
      ], (v) => {
        cmds = failoverOn(cfg, { wan, wanGateway: st.wanGateway, ...v });
        return true;
      }, {
        okLabel: "Turn on",
        intro: `Your main line is ${wan}. Both lines are checked with a ping every few seconds (1.1.1.1 on the main, 9.9.9.9 on the backup). The backup port gets the same protection from the internet as the main line.`,
        initChange: true,
        onChange(_f, v, set) {
          set.show("cidr", v.mode === "static");
          set.show("gateway", v.mode === "static");
        },
      });
      if (!cmds) throw new Error("Cancelled");
      await applyChanges(cmds, "backup internet line");
    };
    const turnOff = async () => {
      if (!(await confirmBox("Turn off the backup line?", "The router then only uses the main line.", "Turn off"))) throw new Error("Cancelled");
      await applyChanges(failoverOff(cfg), "stop using the backup internet line");
    };
    const ctl = status === "manual" ? handMade("Load balancing")
      : !ports.length && status === "off" ? value("needs a spare port")
      : toggle(status === "on", (on) => (on ? turnOn() : turnOff()), render);
    return section("Backup internet (WAN2)",
      row("Failover", "A second line (another modem, or a phone hotspot with a USB/ethernet adapter) on a spare port. When the main line stops answering, everything switches to it within about a minute, and back when the main line recovers. Port forwards and the VPN only work on the main line.",
        ctl, status === "on" ? liveEl : null));
  }

  // ================================================================ Security

  function management(st, my) {
    const { cfg, env } = st;
    const health = h("div", h("div.hint", "Checking…"));
    loadDoctor().then((f) => my === seq && renderDoctor(health, f, render)).catch((e) => clear(health).append(h("div.err-box", errorText(e))));

    const prot = protectStatus(cfg, env);
    const canProtect = prot !== "off" || !!protectOn(cfg, env);
    const protectCtl = prot === "manual" ? h("span.badge.ok", { title: "Your firewall already blocks it (set up by hand)." }, "Blocked by your rules")
      : !canProtect ? value("connect from your home network to change this")
      : toggle(prot === "on", async (on) => {
          if (on) return applyChanges(protectOn(cfg, env), "block the internet from reaching the router");
          if (!(await confirmBox("Open the router to the internet?", "Anyone on the internet could then try to log in to the router. Only do this if you know you need it.", "Allow"))) throw new Error("Cancelled");
          return applyChanges(protectOff(cfg), "allow the internet to reach the router");
        }, render);

    return [
      section("Health Check", health),
      section("Router Access",
        row("Block the internet from reaching the router", "Stops new connections from the internet to the router itself (its settings, SSH, DNS). Replies to your own traffic, port forwards and VPN ports still work.", protectCtl)),
    ];
  }

  // ================================================================ System > VyGi

  function vygi() {
    return [
      isDesktop ? null : accessSection(),
      isDesktop ? null : watchSection(),
      section("Changes",
        row("Show changes before applying", "A short list of what will change (Add, Change, Remove), with the VyOS commands, before VyGi applies it. Conflict checks still show whenever they find something.", previewSelect())),
    ].filter(Boolean);
  }

  // ================================================================ Security > Content Filtering

  function filtering(st, again) {
    const { countries } = parseRegions(st.cfg);
    const adblock = h("div", h("div.hint", "Checking…"));
    fillAdblock(adblock);
    return [
      h("div.hint", "Block whole countries, and ads and trackers, for every device on your networks."),
      section("Region Blocking",
        row("Blocked countries", countries.length
          ? `No traffic to or from: ${countries.slice(0, 8).map((c) => `${flagEmoji(c)} ${countryName(c.toUpperCase())}`).join(", ")}${countries.length > 8 ? ", …" : ""}`
          : "Block all traffic to and from chosen countries, for every device and the router.",
        h("span.set-inline", value(countries.length ? `${countries.length} blocked` : "off"), button("Choose countries…", () => editRegions(st.cfg, again))))),
      section("Ad and Tracker Blocking", adblock),
    ];
  }

  /** Web version: who can use this VyGi server, and what they did. */
  function accessSection() {
    const browsers = h("div", h("div.hint", "Loading…"));
    const fill = async () => {
      let list;
      try {
        list = await webSessions();
      } catch (e) {
        clear(browsers).append(h("div.err-box", e.message));
        return;
      }
      const agent = (a) => {
        const app = { Edg: "Edge", OPR: "Opera" }[/(Edg|OPR)\//.exec(a)?.[1]] || /(Firefox|Chrome|Safari)\//.exec(a)?.[1] || "Browser";
        const os = ["Android", "iPhone", "iPad", "Windows", "Mac OS X", "Linux"].find((x) => a.includes(x))?.replace("Mac OS X", "Mac");
        return os ? `${app} on ${os}` : app;
      };
      clear(browsers).append(h("table.grid",
        h("thead", h("tr", h("th", "Browser"), h("th", "Address"), h("th", "Logged in"), h("th", "Last used"), h("th", ""))),
        h("tbody", list.map((s) => h("tr",
          h("td", agent(s.agent || ""), s.current ? h("span.badge.ok", { style: { marginLeft: "6px" } }, "this one") : null),
          h("td", s.ip || "–"),
          h("td", new Date(s.created).toLocaleString()),
          h("td", new Date(s.lastSeen).toLocaleString()),
          h("td", s.current ? null : h("button", { on: { click: async () => {
            try {
              await webSessionEnd(s.id);
            } catch (e) {
              alertBox("Log out", e.message);
            }
            fill();
          } } }, "Log out")))))));
    };
    fill();
    const menu = (id) => () => document.getElementById(id).click();
    return section("VyGi Access",
      row("Activity log", "Logins, API tokens (Claude), and every change made to a router, with who, when and from which address.", button("Open…", openActivityLog)),
      row("Claude", "Let Claude (Claude Code or Claude Desktop) check and change your routers for you. A guided setup: one file to run on your computer.", button("Connect Claude…", openClaudeSetup, true)),
      row("API tokens", "Keys that let Claude or scripts use VyGi. Each can expire and be revoked; you get an alert when one is created.", button("Manage…", menu("web-api"))),
      row("Web password", "Logins lock for a while after repeated wrong passwords. You get an alert on a lockout and on a login from a new address (with 24/7 watching and alerts set up).", button("Change…", menu("web-password"))),
      row("Logged-in browsers", "", null, browsers));
  }

  async function fillAdblock(el) {
    let settings = null;
    let linked = false;
    try {
      linked = !!(await dnsServerUrl());
      if (linked) settings = await dnsCall("settings/get");
    } catch {
      /* shown as not available */
    }
    const status = adblockStatus(settings);
    const lists = toArray(settings?.blockListUrls);
    if (!linked) {
      clear(el).append(row("Blocking", "Blocks ads, trackers and known bad sites for every device. VyGi uses a Technitium DNS Server for this (free; runs on a PC, NAS or in Docker).",
        button("Link a DNS server…", async () => (await setupDnsServer()) && fillAdblock(el))));
      return;
    }
    if (status === "unavailable") {
      clear(el).append(row("Blocking", "The linked Technitium server isn't answering.", button("Open DNS Server…", () => openDnsServer())));
      return;
    }
    clear(el).append(
      row("Blocking", "Blocks ads, trackers and known bad sites for every device that uses your Technitium server.",
        toggle(status === "on", (on) => dnsCall("settings/set", { enableBlocking: String(on), ...(on && !lists.length ? { blockListUrls: BLOCKLISTS.join(",") } : {}) }), () => fillAdblock(el))),
      row("Block lists", lists.length ? lists.map((u) => u.replace(/^https?:\/\//, "")).join(", ") : "None yet: turning blocking on adds the StevenBlack list.",
        button("Manage…", () => openDnsServer())));
  }

  // ================================================================ System

  function system(st) {
    const { cfg } = st;
    const update = h("div", row("VyOS version", "", value("checking…")));
    checkUpdate().then((c) => fillUpdate(update, c));
    const backups = value("…");
    api.historyList().then((l) => (backups.textContent = `${l.length} saved`)).catch(() => (backups.textContent = "–"));

    const out = [
      section("Router",
        row("Set up", "A checklist of the basics: internet, a home network, the router's password, security, saving, backups and alerts, the clock.", button("Open checklist…", () => openSetup().then(render))),
        row("Name", "", value(cfg?.system?.["host-name"] || "–")),
        row("Time zone", "Schedules (Traffic Rules) follow it.", h("span.set-inline", value(cfg?.system?.["time-zone"] || "UTC"), button("Change…", () => openIdentityClock().then(render))))),
      section("Updates", update),
      section("Backups",
        row("Backups", isDesktop
          ? "Saved on this computer each time VyGi connects and the settings changed."
          : "Saved on the VyGi server each time you connect, and every 6 hours while 24/7 watching is on, when the settings changed.",
        h("span.set-inline", backups, button("History…", () => openBackup("History")), button("Download / restore…", () => openBackup("Backup"))))),
    ];
    return out;
  }

  function previewSelect() {
    const sel = h("select", [["big", "For bigger changes"], ["always", "Always"], ["never", "Never"]].map(([v, l]) => h("option", { value: v, selected: previewMode() === v }, l)));
    sel.addEventListener("change", () => setPreviewMode(sel.value));
    return sel;
  }

  function fillUpdate(el, c) {
    const again = button("Check again", async () => fillUpdate(el, await checkUpdate(true)));
    if (c.error) {
      clear(el).append(row("VyOS version", `Couldn't check for updates: ${c.error}`, again));
    } else if (c.info.unsupported) {
      clear(el).append(row("VyOS version", c.info.unsupported, value(c.info.local || "unknown")));
    } else if (c.info.available) {
      clear(el).append(row("VyOS version", `Running ${c.info.local}. ${c.info.remote} is available.`, button("Update now…", () => install(c.info), true)));
    } else {
      clear(el).append(row("VyOS version", `Up to date (newest is ${c.info.remote}).`, h("span.set-inline", value(c.info.local), again)));
    }
    if (!isDesktop && !c.error && !c.info.unsupported) el.append(h("div.hint.set-note", "With 24/7 watching on, the server checks daily and alerts you when a new version comes out."));
    // after an update VyGi installed: the way back to the version before it
    api.updateGuardStatus().then((st) => {
      const old = st.pending ? st.old : st.previous;
      if (old && old !== st.running && el.isConnected) {
        el.append(row("Previous version", st.pending ? `Waiting for VyGi to confirm the update; until then the router goes back to ${old} by itself.` : `Before the last update: ${old}.`, button("Go back…", goBack)));
      }
    }).catch(() => {});
  }

  async function install(info) {
    const ok = await confirmBox("Update VyOS",
      `VyGi saves your settings, then the router downloads VyOS ${info.remote} (about 600 MB) and installs it next to the current version. Your settings are copied to the new version. The internet keeps working while it downloads.\n\nAfterwards the router restarts into the new version (about 2 minutes without internet). If VyGi can't reach the router within 10 minutes of it starting, the router goes back to the current version by itself and restarts again.`,
      "Download and install");
    if (!ok) return;
    try {
      await api.saveConfig();
    } catch (e) {
      return alertBox("Update VyOS", `Couldn't save the settings first, so nothing was installed: ${errorText(e)}`);
    }
    toast(`Downloading and installing VyOS ${info.remote}: this can take 10 minutes or more…`, { timeout: 30 * 60_000 });
    try {
      await api.imageAdd(info.url);
    } catch (e) {
      toast("Update failed.", { error: true });
      return alertBox("Update VyOS", `The install failed, nothing changed: ${errorText(e)}`);
    }
    updateCache.delete(session.info?.profileId);
    toast(`VyOS ${info.remote} installed.`);
    // the way back: the router returns to this version unless VyGi reaches it after the restart
    let guard = null;
    let guardErr = "";
    try {
      guard = await api.updateGuardArm(10);
      rememberUpdate(guard);
    } catch (e) {
      guardErr = errorText(e);
    }
    const text = guard
      ? `VyOS ${info.remote} is installed and will be used after a restart. Restart the router now? (About 2 minutes without internet. VyGi reconnects when it's back; if it can't within 10 minutes, the router goes back to ${guard.old} by itself.)`
      : `VyOS ${info.remote} is installed and will be used after a restart.\n\nThe automatic way back couldn't be set up (${guardErr}): if the new version doesn't work, choose the old one under Advanced > System > Images (Upgrade) and restart. Restart now?`;
    if (await confirmBox("Restart now?", text, "Restart now")) {
      await api.power("reboot").catch((e) => alertBox("Restart", errorText(e)));
    }
  }

  function watchSection() {
    const el = section("Monitoring", h("div.hint", "Checking…"));
    api.watchGet().then((wg) => {
      const r = wg.router || {};
      const s = wg.status || {};
      const state = !r.enabled ? "" : s.error ? `Problem: ${s.error}` : s.connected ? `Watching. Last check ${s.lastCheck ? new Date(s.lastCheck).toLocaleTimeString() : "soon"}.` : "Starting…";
      el.querySelector(".hint")?.remove();
      el.append(
        row("24/7 watching", "The VyGi server keeps checking this router while no tab is open: alerts, traffic and log history (Activity), backups and update checks." + (state ? ` ${state}` : ""),
          toggle(!!r.enabled, (on) => api.watchSet({ ...r, enabled: on, name: r.name || session.info?.hostname || "" }), render)),
        row("Alerts and phone notifications", "What to be alerted about, and where to send it (ntfy, Discord, a webhook).", button("Open…", () => document.getElementById("btn-alerts")?.click())));
    }).catch((e) => {
      el.querySelector(".hint").textContent = errorText(e);
    });
    return el;
  }

  registerView("settings", { show: render });
  onSessionChange(() => {
    seq++;
    if (!root.hidden) render();
  });

  // Security > Content Filtering: region and ad blocking (the same building blocks as Settings)
  const froot = document.getElementById("filtering");
  let fseq = 0;
  async function renderFiltering() {
    const my = ++fseq;
    if (!isConnected()) {
      clear(froot).append(welcome(() => document.getElementById("btn-connect").click()));
      return;
    }
    if (!froot.querySelector(".page")) clear(froot).append(loadingPage(2));
    let st;
    try {
      st = await loadState();
    } catch (e) {
      if (my === fseq) clear(froot).append(h("div.page", h("div.err-box", errorText(e)), h("p", button("Try again", renderFiltering))));
      return;
    }
    if (my !== fseq) return;
    clear(froot).append(h("div.page.settings", ...filtering(st, renderFiltering)));
  }
  registerView("filtering", { show: renderFiltering });
  onSessionChange(() => {
    fseq++;
    if (!froot.hidden) renderFiltering();
  });
}
