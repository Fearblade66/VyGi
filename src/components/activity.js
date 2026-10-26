// Activity log (web version): logins, API tokens and every change made to a
// router, from the UI or through the API, newest first.
import { h, clear } from "../lib/dom.js";
import { modal } from "../lib/dialog.js";
import { webAudit } from "../lib/platform.js";

const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" });

function row(e) {
  const detail = e.detail ? h("pre.activity-detail", e.detail) : null;
  if (detail) detail.hidden = true;
  const el = h(`div.activity-row${e.ok ? "" : ".bad"}`, { title: e.detail ? "Click for details" : "" },
    h("div.activity-top",
      h("span.activity-when", when(e.at)),
      h("span.activity-action", e.action),
      e.router ? h("span.badge", e.router) : null,
      h("span.grow"),
      h("span.hint", [e.who, e.ip].filter(Boolean).join(" · "))),
    e.detail ? h("div.hint.activity-first", e.detail.split("\n")[0]) : null,
    detail);
  if (detail) el.addEventListener("click", () => (detail.hidden = !detail.hidden));
  return el;
}

export async function openActivityLog() {
  const list = h("div.activity-list", h("div.hint", "Loading…"));
  const search = h("input", { type: "search", placeholder: "Search: login, token, firewall, an IP address…" });
  const more = h("button", { hidden: true }, "Older entries");
  let entries = [];
  let timer = null;

  async function load(append = false) {
    try {
      const before = append && entries.length ? entries[entries.length - 1].at : 0;
      const got = await webAudit({ before, q: search.value, limit: 200 });
      entries = append ? [...entries, ...got] : got;
      clear(list).append(...(entries.length ? entries.map(row) : [h("div.hint", search.value ? "Nothing matches." : "Nothing logged yet.")]));
      more.hidden = got.length < 200;
    } catch (e) {
      clear(list).append(h("div.err-box", e.message));
    }
  }
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(), 300);
  });
  more.addEventListener("click", () => load(true));
  load();
  await modal("Activity log", h("div", { style: { width: "760px", maxWidth: "100%" } },
    h("div.hint", { style: { marginBottom: "8px" } }, "Logins, API tokens, and every change made to a router from VyGi or through the API (Claude), with who, when and from which address. Passwords and keys in commands are hidden. Kept for a year on the VyGi server."),
    search, list, more),
  [{ label: "Close", value: "ok", primary: true }]);
}
