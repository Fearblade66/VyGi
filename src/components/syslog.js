// Log window: follows the router's systemd journal with severity + text filters.
import { api, errorText } from "../lib/api.js";
import { h, setStatus } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { makeTable, filterBox } from "../lib/table.js";

const MAX_ROWS = 3000;
const SEVERITY = ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"];

export function openSyslog() {
  const win = openWindow({ key: "log", title: "Log", width: 980, height: 440 });
  if (!win.isNew) return;

  const table = makeTable(
    [
      { key: "time", label: "Time", width: "150px" },
      { key: "severity", label: "Severity", width: "70px" },
      { key: "ident", label: "Topics", width: "140px" },
      { key: "message", label: "Message" },
    ],
    { rowKey: (r) => r.seq, rowClass: (r) => (r.prio <= 3 ? "err-row" : r.prio === 4 ? "warn-row" : "") },
  );
  const level = h("select", SEVERITY.map((s, i) => h("option", { value: i, selected: i === 6 }, `${s} and worse`)));
  const pauseBtn = h("button", "Pause");
  win.body.append(h("div.win-toolbar", h("span", "Show:"), level, pauseBtn, h("span.grow"), filterBox(table)), table.wrap, table.count);

  const all = [];
  let seq = 0;
  let paused = false;
  let buffer = "";
  let renderQueued = false;

  const render = () => {
    renderQueued = false;
    const max = Number(level.value);
    table.setRows(all.filter((r) => r.prio <= max).slice().reverse());
  };
  const queueRender = () => {
    if (paused || renderQueued) return;
    renderQueued = true;
    setTimeout(render, 250);
  };
  level.addEventListener("change", render);
  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "Resume" : "Pause";
    if (!paused) render();
  });

  const addLine = (line) => {
    if (!line.trim()) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      e = { MESSAGE: line };
    }
    const prio = Number(e.PRIORITY ?? 6);
    const ts = Number(e.__REALTIME_TIMESTAMP) / 1000;
    let message = e.MESSAGE;
    if (Array.isArray(message)) message = new TextDecoder().decode(new Uint8Array(message)); // binary-safe journal field
    all.push({
      seq: seq++,
      prio,
      time: Number.isFinite(ts) ? new Date(ts).toLocaleString() : "",
      severity: SEVERITY[prio] || String(prio),
      ident: e.SYSLOG_IDENTIFIER || e._COMM || "",
      message: String(message ?? ""),
    });
    if (all.length > MAX_ROWS) all.splice(0, all.length - MAX_ROWS);
  };

  let id = null;
  api
    .openStream({ type: "syslog", lines: 300 }, (msg) => {
      if (msg.event === "data") {
        buffer += msg.data;
        const lines = buffer.split("\n");
        buffer = lines.pop();
        lines.forEach(addLine);
        queueRender();
      } else if (msg.event === "closed") {
        setStatus(msg.data === 77
          ? "The log can't be read: VyGi's login on the router may not use sudo."
          : "The log stopped (the connection dropped, or the router or its SSH restarted). Close and reopen Log to continue.", true);
      }
    })
    .then((sid) => (id = sid))
    .catch((e) => setStatus(errorText(e), true));

  win.onClose(() => {
    if (id != null) api.closeSession(id).catch(() => {});
  });
}
