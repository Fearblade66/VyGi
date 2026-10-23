// "New Terminal": xterm.js bound to an interactive SSH shell on the router.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, errorText } from "../lib/api.js";
import { h, setStatus } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { session } from "../lib/session.js";

let count = 0;

export async function openTerminal() {
  const n = ++count;
  const win = openWindow({ key: `terminal-${n}`, title: `Terminal <${session.info?.hostname ?? ""}>`, width: 760, height: 440 });
  const host = h("div.term-host");
  win.body.append(host);

  const term = new Terminal({
    fontFamily: '"DejaVu Sans Mono", Consolas, Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: "#000000" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();

  let id = null;
  const decoder = (msg) => {
    if (msg.event === "data") term.write(msg.data);
    else if (msg.event === "closed") {
      term.write("\r\n\x1b[33m[session closed]\x1b[0m\r\n");
      id = null;
    }
  };
  try {
    id = await api.openTerminal(term.cols, term.rows, decoder);
  } catch (e) {
    term.write(`\x1b[31m${errorText(e)}\x1b[0m\r\n`);
    setStatus(errorText(e), true);
  }

  term.onData((data) => {
    if (id != null) api.termWrite(id, data).catch(() => {});
  });

  let resizeTimer = null;
  const refit = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      fit.fit();
      if (id != null) api.termResize(id, term.cols, term.rows).catch(() => {});
    }, 60);
  };
  win.onResize(refit);
  const ro = new ResizeObserver(refit);
  ro.observe(host);

  win.onClose(() => {
    ro.disconnect();
    if (id != null) api.closeSession(id).catch(() => {});
    term.dispose();
  });
  term.focus();
}
