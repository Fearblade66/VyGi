// Tools: Ping, Traceroute and Packet Capture ("Torch"). All stream over SSH.
import { api, errorText } from "../lib/api.js";
import { h, setStatus } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";

const MAX_OUTPUT_CHARS = 400_000;

/**
 * Generic "inputs + Start/Stop + streaming output" window.
 * buildKind(inputs) returns the StreamKind object for the Rust side.
 */
function streamWindow({ key, title, inputs, buildKind, width = 700, height = 420 }) {
  const win = openWindow({ key, title, width, height });
  if (!win.isNew) return win;

  const out = h("pre.out");
  const btn = h("button", { style: { fontWeight: "bold" } }, "Start");
  const toolbar = h("div.win-toolbar", Object.entries(inputs).flatMap(([label, el]) => [h("span", label), el]), btn, h("span.grow"), h("button", { on: { click: () => (out.textContent = "") } }, "Clear"));
  win.body.append(toolbar, out);

  let id = null;
  let pending = "";
  let flushQueued = false;
  const flush = () => {
    flushQueued = false;
    const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 4;
    out.textContent += pending;
    pending = "";
    if (out.textContent.length > MAX_OUTPUT_CHARS) out.textContent = out.textContent.slice(-MAX_OUTPUT_CHARS / 2);
    if (atBottom) out.scrollTop = out.scrollHeight;
  };
  const stop = async () => {
    if (id != null) await api.closeSession(id).catch(() => {});
    id = null;
    btn.textContent = "Start";
  };
  btn.addEventListener("click", async () => {
    if (id != null) return stop();
    let kind;
    try {
      kind = buildKind();
    } catch (e) {
      return setStatus(e.message, true);
    }
    btn.textContent = "Stop";
    try {
      id = await api.openStream(kind, (msg) => {
        if (msg.event === "data") {
          pending += msg.data;
          if (!flushQueued) {
            flushQueued = true;
            requestAnimationFrame(flush);
          }
        } else if (msg.event === "closed") {
          pending += `\n--- finished${msg.data != null ? ` (exit ${msg.data})` : ""} ---\n`;
          requestAnimationFrame(flush);
          id = null;
          btn.textContent = "Start";
        }
      });
    } catch (e) {
      btn.textContent = "Start";
      setStatus(errorText(e), true);
    }
  });
  win.onClose(stop);
  return win;
}

export function openPing() {
  const target = h("input", { type: "text", placeholder: "address or host", style: { width: "180px" } });
  const count = h("input", { type: "number", value: 5, min: 1, max: 1000, style: { width: "60px" } });
  streamWindow({
    key: "ping",
    title: "Ping",
    inputs: { "To:": target, "Count:": count },
    buildKind: () => {
      if (!target.value.trim()) throw new Error("Enter an address to ping");
      return { type: "ping", target: target.value.trim(), count: Number(count.value) || 5 };
    },
  });
}

export function openTraceroute() {
  const target = h("input", { type: "text", placeholder: "address or host", style: { width: "220px" } });
  streamWindow({
    key: "traceroute",
    title: "Traceroute",
    inputs: { "To:": target },
    buildKind: () => {
      if (!target.value.trim()) throw new Error("Enter an address");
      return { type: "traceroute", target: target.value.trim() };
    },
  });
}

export function openCapture(iface = "") {
  const ifEl = h("input", { type: "text", value: iface, placeholder: "eth0", style: { width: "90px" } });
  const filter = h("input", { type: "text", placeholder: "tcpdump filter, e.g. port 53 or host 192.0.2.5", style: { width: "300px" } });
  const win = streamWindow({
    key: `capture`,
    title: "Packet Capture (Torch)",
    width: 900,
    inputs: { "Interface:": ifEl, "Filter:": filter },
    buildKind: () => {
      if (!ifEl.value.trim()) throw new Error("Enter an interface");
      return { type: "capture", interface: ifEl.value.trim(), filter: filter.value };
    },
  });
  if (!win.isNew && iface) {
    const input = win.body.querySelector("input");
    if (input) input.value = iface;
  }
}
