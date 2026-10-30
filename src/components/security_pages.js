// Security → Network Policies (who can reach whom, mDNS) and Security →
// Intrusion Prevention: the sections that used to live on the Networks and
// Settings pages, as pages of their own.
import { api, errorText } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { isConnected, onSessionChange } from "../lib/session.js";
import { registerView, welcome, loadingPage } from "../lib/views.js";
import { readNetworks } from "../lib/netplan.js";
import { wanInfo } from "../lib/wan.js";
import { policySection, mdnsSection } from "./policies_view.js";
import { idsSection } from "./ids_view.js";

async function loadState() {
  const [cfg, w] = await Promise.all([api.getConfig([]).then((c) => c || {}), wanInfo()]);
  return { cfg, wan: w.wan };
}

/** A page that reloads the router's config and renders `build(st, render)`. */
function simplePage(name, elId, hint, build) {
  const root = document.getElementById(elId);
  let seq = 0;
  async function render() {
    const my = ++seq;
    if (!isConnected()) {
      clear(root).append(welcome(() => document.getElementById("btn-connect").click()));
      return;
    }
    if (!root.querySelector(".page")) clear(root).append(loadingPage(2));
    let st;
    try {
      st = await loadState();
    } catch (e) {
      if (my === seq) clear(root).append(h("div.page", h("div.err-box", errorText(e))));
      return;
    }
    if (my !== seq) return;
    clear(root).append(h("div.page", h("div.hint", hint), ...build(st, render)));
  }
  onSessionChange(() => {
    if (!root.hidden) render();
  });
  registerView(name, { show: render });
}

export function initSecurityPages() {
  simplePage("access", "access", "Which networks can reach which, exceptions for single devices, and discovery (casting, printers) across networks.", (st, render) => {
    const nets = readNetworks(st.cfg, st.wan);
    if (!nets.length) return [h("div.empty", "No local networks yet: create one on the Networks page.")];
    return [policySection(st, nets, render), nets.length > 1 ? mdnsSection(st, nets, render) : ""];
  });
  simplePage("ids", "idspage", "Suricata on the router watches traffic for known attacks, scans and infected devices.", (st, render) => [
    h("section.card.policy-section", idsSection(st, render)),
  ]);
}
