// Small DOM helpers so components stay readable without a framework.

/**
 * h("div.cls#id", {attrs, on: {click}}, ...children)
 * Strings become text nodes (never HTML), so router data can't inject markup.
 */
export function h(tag, props = {}, ...children) {
  const [, name, rest] = tag.match(/^([a-z0-9]+)(.*)$/i) || [null, "div", ""];
  const el = document.createElement(name);
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === ".") el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (props && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = {};
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k in el && k !== "list" && k !== "type") el[k] = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Status bar text (Classic) + a toast (Modern). silent: status bar only. */
export function setStatus(text, isError = false, { silent = false } = {}) {
  const bar = document.getElementById("statusbar");
  document.getElementById("status-text").textContent = text;
  bar.classList.toggle("error", isError);
  if (!silent) toast(text, { error: isError });
}

let lastToast = null;

/**
 * Pop-up message (Modern look; Classic uses the status bar).
 * opts: { error, action: { label, fn }, timeout ms }
 * A message ending in "…" is progress: the next message replaces it.
 */
export function toast(text, { error = false, warn = false, action = null, timeout } = {}) {
  const box = document.getElementById("toasts");
  if (!box || !text) return null;
  const progress = /…$/.test(text);
  if (lastToast?.isConnected && (lastToast.dataset.progress === "1" || lastToast.dataset.text === text)) lastToast.remove();
  const close = () => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 200);
  };
  const el = h(`div.toast${error ? ".bad" : warn ? ".warn" : progress ? ".busy" : ""}`,
    h("span.toast-dot"),
    h("span.toast-text", text),
    action ? h("button.toast-action", { on: { click: () => { close(); action.fn(); } } }, action.label) : null,
    h("button.toast-close", { title: "Dismiss", on: { click: close } }, "×"));
  el.dataset.text = text;
  el.dataset.progress = progress ? "1" : "0";
  box.append(el);
  while (box.children.length > 4) box.firstChild.remove();
  lastToast = el;
  const ms = timeout ?? (progress ? 60000 : error ? 9000 : action ? 12000 : 4500);
  setTimeout(() => el.isConnected && close(), ms);
  return el;
}

export function formatBits(bitsPerSec) {
  if (!Number.isFinite(bitsPerSec)) return "";
  const units = ["bps", "kbps", "Mbps", "Gbps", "Tbps"];
  let v = bitsPerSec;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return "";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function formatAge(unixSeconds) {
  if (!unixSeconds) return "never";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Tiny inline SVG line chart. */
export function sparkline(values, width = 70, height = 14) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.classList.add("spark");
  if (values.length < 2) return svg;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 1 - (v / max) * (height - 2)).toFixed(1)}`);
  const line = document.createElementNS(ns, "polyline");
  line.setAttribute("points", pts.join(" "));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "#2b6cb0");
  line.setAttribute("stroke-width", "1");
  svg.appendChild(line);
  return svg;
}
