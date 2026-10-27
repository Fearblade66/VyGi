// Dashboard (web version, two or more saved routers): every router the
// VyGi server knows, with its 24/7 watching and today's alerts. Open
// connects to it in a new tab.
import { api } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { session } from "../lib/session.js";

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** Fills `card` ({ el, body }); hides it unless there are two or more routers. */
export async function renderRouters(card) {
  let list;
  try {
    list = await api.routersOverview();
  } catch {
    card.el.hidden = true;
    return;
  }
  card.el.hidden = list.length < 2;
  if (list.length < 2) return;
  const me = session.info?.profileId;
  clear(card.body).append(h("div.router-list", list.map((r) => {
    const st = r.status || {};
    const state = !r.watch ? ["muted", "not watched"]
      : st.error ? ["bad", "can't reach it"]
      : st.connected ? ["ok", st.lastCheck ? `checked ${ago(st.lastCheck)}` : "watching"]
      : ["warn", "connecting…"];
    return h("div.router-row",
      h(`span.pill.${state[0]}`, state[1]),
      h("div.grow",
        h("b", r.name || r.host), h("span.hint", ` ${r.host}`),
        h("div.hint", r.alerts24h
          ? `${r.alerts24h} alert${r.alerts24h === 1 ? "" : "s"} today${r.bad24h ? ` (${r.bad24h} serious)` : ""}${r.lastAlert ? `: ${r.lastAlert.text}` : ""}`
          : r.watch ? "No alerts today." : "Turn on 24/7 watching (bell) to see its alerts here.")),
      r.id === me ? h("span.badge", "this one") : h("button", { on: { click: () => window.open(`${location.pathname}#router=${encodeURIComponent(r.id)}`, "_blank", "noopener") } }, "Open"));
  })));
}
