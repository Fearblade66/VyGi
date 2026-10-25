// Simple page: plain on/off switches for common setups, plus the Health
// check. Each switch manages only the settings VyGi made; when the same thing
// was set up by hand (Advanced, the CLI) it shows that and leaves it alone.
// Every change goes through applyChanges, so conflicts are checked first.
import { api, errorText } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges, isConnected, onSessionChange, session } from "../lib/session.js";
import { registerView, welcome, loadingPage, showView } from "../lib/views.js";
import { icon } from "../lib/icons.js";
import { toArray } from "../lib/vyos.js";
import { isDesktop } from "../lib/platform.js";
import { wanInfo } from "../lib/wan.js";
import { readNetworks, suggestVlan, suggestSubnet, suggestPool, networkCommands, deleteNetworkCommands } from "../lib/netplan.js";
import {
  protectStatus, protectOn, protectOff, countingStatus, countingOn, countingOff, smoothStatus, smoothOn, smoothOff, smoothBandwidth,
  vpnStatus, vpnOff, guestNetwork, adblockStatus, BLOCKLISTS,
} from "../lib/switches.js";
import { quickSetup } from "./wireguard.js";
import { dnsServerUrl, dnsCall } from "./technitium.js";
import { loadDoctor, renderDoctor } from "./doctor.js";

async function loadState() {
  const [cfg, w] = await Promise.all([api.getConfig([]).then((c) => c || {}), wanInfo()]);
  const env = {
    wan: w.wan,
    wanCidr: w.wanCidr,
    mgmtHost: session.info?.profile?.host,
    defaultPassword: !!session.info?.defaultPassword,
    user: session.info?.profile?.sshUser || "vyos",
  };
  const [dns, watch] = await Promise.all([
    dnsServerUrl().then((url) => (url ? dnsCall("settings/get") : null)).catch(() => null),
    isDesktop ? null : api.watchGet().catch(() => null),
  ]);
  return { cfg, env, wan: w.wan, nets: readNetworks(cfg, w.wan), dns, watch };
}

/** Upload speed (Mbit/s) from the last Dashboard speed test, or "". */
function lastUpload() {
  try {
    const r = JSON.parse(localStorage.getItem(`vygi.speed.${session.info?.profileId}`));
    return r?.upBps ? String(Math.round(r.upBps / 1e6)) : "";
  } catch {
    return "";
  }
}

export function initSimple() {
  const root = document.getElementById("simple");
  let seq = 0;

  async function render() {
    const my = ++seq;
    if (!isConnected()) {
      clear(root).append(welcome(() => document.getElementById("btn-connect").click()));
      return;
    }
    if (!root.querySelector(".page")) clear(root).append(loadingPage(3));
    let st;
    try {
      st = await loadState();
    } catch (e) {
      if (my === seq) clear(root).append(h("div.page", h("div.err-box", errorText(e))));
      return;
    }
    if (my !== seq) return;
    const health = h("div", h("div.hint", "Checking…"));
    clear(root).append(h("div.page",
      h("div.page-head", h("div.hint", "The common things, as simple switches. VyGi checks each change for conflicts and shows what it will change first. Anything you set up by hand in Advanced is left alone.")),
      h("section.card", h("h3", "Health check"), health),
      h("div.rule-grid", switches(st).map(card))));
    loadDoctor().then((f) => my === seq && renderDoctor(health, f, render)).catch((e) => clear(health).append(h("div.err-box", errorText(e))));
  }

  /** One switch card. s: { icon, title, text, status, detail?, on(), off(), extra? } */
  function card(s) {
    const manual = s.status === "manual";
    const unavailable = s.status === "unavailable";
    if (s.status === "link") {
      return h("div.rule-card", { style: { cursor: "default" } },
        h("div.rule-top", h("span.rule-icon", icon(s.icon, 18)), h("div.grow", h("div.rule-name", s.title))),
        h("div.hint", s.text),
        h("div.card-actions", s.extra));
    }
    const sw = h("input", { type: "checkbox", checked: s.status === "on", disabled: manual || unavailable });
    sw.addEventListener("change", async () => {
      const want = sw.checked;
      sw.disabled = true;
      try {
        await (want ? s.on() : s.off());
      } catch (e) {
        if (!/^Cancelled/.test(e?.message || "")) alertBox(s.title, errorText(e));
      }
      render();
    });
    return h("div.rule-card", { style: { cursor: "default" } },
      h("div.rule-top",
        h("span.rule-icon", icon(s.icon, 18)),
        h("div.grow", h("div.rule-name", s.title)),
        h("label.switch", sw)),
      h("div.hint", s.text),
      h("div.badges",
        manual ? h("span.badge", "Set up by hand: VyGi leaves it alone")
          : unavailable ? h("span.badge", s.unavailableText || "Not available")
          : s.status === "on" ? h("span.badge.ok", s.detail || "On") : h("span.badge", "Off")),
      s.extra ? h("div.card-actions", s.extra) : null);
  }

  // Each switch reads the state it was rendered from; `render` reloads after a change.
  function switches(st) {
    const { cfg, env, wan, nets } = st;
    const guest = guestNetwork(nets, cfg);
    const smoothBw = smoothBandwidth(cfg);
    return [
      {
        icon: "shield",
        title: "Protect the router",
        text: "Blocks connections from the internet to the router itself (its settings, SSH, DNS). Replies to your own traffic and VPNs VyGi set up still work.",
        status: protectStatus(cfg, env) === "off" && !protectOn(cfg, env) ? "unavailable" : protectStatus(cfg, env),
        unavailableText: "VyGi is connected through the internet port, so blocking would cut it off: connect from your home network",
        on: async () => {
          const cmds = protectOn(cfg, env);
          if (!cmds) throw new Error("Nothing to change.");
          await applyChanges(cmds, "keep the internet out of the router");
        },
        off: async () => {
          if (!(await confirmBox("Open the router to the internet?", "Anyone on the internet could then try to log in to the router. Only do this if you know you need it.", "Turn off protection"))) throw new Error("Cancelled");
          await applyChanges(protectOff(cfg), "stop keeping the internet out of the router");
        },
      },
      {
        icon: "dashboard",
        title: "Count data per device",
        text: "Shows how much each device downloads and uploads on Clients and the Dashboard. Costs a little router speed.",
        status: countingStatus(cfg),
        on: () => applyChanges(countingOn(), "count data per device"),
        off: () => applyChanges(countingOff(), "stop counting data per device"),
      },
      {
        icon: "rules",
        title: "Smooth gaming and calls",
        text: "Stops big uploads (backups, cloud photos) from making games and calls lag. Uses your upload speed; shapes a little below it.",
        status: smoothStatus(cfg, wan),
        detail: smoothBw ? `On (${smoothBw} upload)` : "On",
        on: async () => {
          let cmds = null;
          await formDialog("Smooth gaming and video calls", [
            { name: "up", label: "Upload speed (Mbit/s)", value: lastUpload(), hint: lastUpload() ? "From your last speed test on the Dashboard." : "Run the speed test on the Dashboard, or use the upload speed your provider sells you." },
          ], (v) => {
            cmds = smoothOn(cfg, wan, v.up);
            return true;
          }, { okLabel: "Turn on" });
          if (!cmds) throw new Error("Cancelled");
          await applyChanges(cmds, "smooth gaming and video calls");
        },
        off: () => applyChanges(smoothOff(cfg), "stop smoothing gaming and video calls"),
      },
      {
        icon: "vpn",
        title: "Remote access (VPN)",
        text: "A WireGuard VPN: use your home network and internet from your phone or laptop, from anywhere.",
        status: vpnStatus(cfg),
        on: () => quickSetup(),
        off: async () => {
          if (!(await confirmBox("Remove the VPN?", "Every phone and laptop set up for it stops working, and would need a new QR code if you turn it on again.", "Remove VPN"))) throw new Error("Cancelled");
          await applyChanges(vpnOff(cfg), "remove the VPN");
        },
        extra: vpnStatus(cfg) === "on" ? h("button", { on: { click: () => showView("vpn") } }, "Devices…") : null,
      },
      guestCard(st, guest),
      adblockCard(st),
      ...(st.watch ? [watchCard(st)] : []),
      {
        icon: "clock",
        title: "Bedtime for kids",
        text: "Turn off the internet for chosen devices at night. Set it up as a Traffic Rule with a schedule.",
        status: "link",
        extra: h("button", { on: { click: () => showView("rules") } }, "Open Traffic Rules"),
      },
    ];
  }

  function guestCard(st, guest) {
    const { cfg, env, nets } = st;
    const main = nets.find((n) => !n.vlan && (n.type === "ethernet" || n.type === "bridge")) || nets[0];
    return {
      icon: "wifi",
      title: "Guest network",
      text: "A separate network for visitors: internet only, they can't see your devices. Needs a Wi-Fi access point or switch that supports VLANs (most business-style ones do).",
      status: !guest ? (main ? "off" : "unavailable") : guest.ours ? "on" : "manual",
      unavailableText: "No home network to add it to",
      detail: guest ? `On: ${guest.net.network}${guest.net.vlan ? `, VLAN ${guest.net.vlan}` : ""}` : "",
      on: async () => {
        const vlan = suggestVlan(cfg, main.parent);
        const cidr = suggestSubnet(cfg, vlan);
        const pool = suggestPool(cidr);
        const cmds = networkCommands(cfg, {
          name: "Guest", mode: "vlan", parent: main.iface, vlan, cidr, dhcp: true, poolStart: pool.start, poolStop: pool.stop,
          dnsMode: "router", internet: true, isolate: true,
        }, env);
        if (!(await confirmBox("Guest network", `VyGi makes a guest network on VLAN ${vlan} (${cidr.replace(/\.1\//, ".0/")}) on ${main.iface}.\n\nThen, in your access point's settings, make a guest Wi-Fi with VLAN ID ${vlan}.`, "Create"))) throw new Error("Cancelled");
        await applyChanges(cmds, "guest network");
      },
      off: async () => {
        if (!(await confirmBox("Remove the guest network?", `Devices on ${guest.net.name} lose their connection.`, "Remove"))) throw new Error("Cancelled");
        await applyChanges(deleteNetworkCommands(cfg, guest.net, env), "remove the guest network");
      },
    };
  }

  function adblockCard(st) {
    const s = st.dns;
    const lists = toArray(s?.blockListUrls);
    return {
      icon: "ban",
      title: "Block ads and trackers",
      text: "Blocks ads, trackers and known bad sites for every device, using your Technitium DNS server.",
      status: adblockStatus(s),
      unavailableText: "Needs a Technitium DNS server: link one in Advanced → DNS Server",
      detail: `On (${lists.length} block list${lists.length === 1 ? "" : "s"})`,
      on: () => dnsCall("settings/set", { enableBlocking: "true", ...(lists.length ? {} : { blockListUrls: BLOCKLISTS.join(",") }) }),
      off: () => dnsCall("settings/set", { enableBlocking: "false" }),
    };
  }

  function watchCard(st) {
    const r = st.watch.router || {};
    return {
      icon: "bell",
      title: "Watch this router 24/7",
      text: "The VyGi server keeps checking the router while no tab is open, records history for Insights and sends alerts (set up phone notifications under the bell).",
      status: r.enabled ? "on" : "off",
      detail: st.watch.status?.error ? `On, problem: ${st.watch.status.error}` : "On",
      on: () => api.watchSet({ ...r, enabled: true, name: r.name || session.info?.hostname || "" }),
      off: () => api.watchSet({ ...r, enabled: false }),
    };
  }

  registerView("simple", { show: render });
  onSessionChange(() => {
    seq++;
    if (!root.hidden) render();
  });
}
