// Floating, draggable, resizable sub-windows inside #workspace (Winbox MDI style).
import { h } from "./dom.js";
import { currentView, showView } from "./views.js";

const open = new Map(); // key -> window object
const all = new Set(); // every open window (also the ones without a key)
let zTop = 10;
let cascade = 0;

/** Where windows live (below the strip of open windows). */
function workspace() {
  return document.getElementById("ws-area");
}
const outer = () => document.getElementById("workspace");

// Floating windows (Winbox style: the default on a desktop-sized screen) or
// tabs (one window at a time, full size: the default on smaller screens).
// Either way a strip lists the open windows.
const LAYOUT_KEY = "vygi.advanced.layout";
function layout() {
  let saved = null;
  try {
    saved = localStorage.getItem(LAYOUT_KEY);
  } catch {
    /* not remembered */
  }
  if (saved === "float" || saved === "tabs") return saved;
  return window.innerWidth > 1000 ? "float" : "tabs";
}

/** Floating windows: arrange them all side by side, in a grid that fills the area. */
function tile() {
  const ws = workspace();
  const wins = [...all];
  const n = wins.length;
  if (!n || !ws) return;
  const gap = 6;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const rh = (ws.clientHeight - gap * (rows + 1)) / rows;
  wins.forEach((w, i) => {
    const r = Math.floor(i / cols);
    const inRow = r === rows - 1 ? n - cols * (rows - 1) : cols; // the last row shares its width
    const c = i - r * cols;
    const cw = (ws.clientWidth - gap * (inRow + 1)) / inRow;
    w.el.classList.remove("maximized");
    Object.assign(w.el.style, {
      left: `${Math.round(gap + c * (cw + gap))}px`,
      top: `${Math.round(gap + r * (rh + gap))}px`,
      width: `${Math.round(cw)}px`,
      height: `${Math.round(rh)}px`,
    });
    w.refit();
  });
}
function setLayout(v) {
  try {
    localStorage.setItem(LAYOUT_KEY, v);
  } catch {
    /* not remembered */
  }
  applyLayout();
}
function applyLayout() {
  const ws = outer();
  if (!ws) return;
  ws.classList.toggle("tabbed", layout() === "tabs");
  renderStrip();
  window.dispatchEvent(new Event("resize"));
}

/** The strip of open windows at the top of the workspace. */
function renderStrip() {
  const ws = outer();
  const strip = document.getElementById("ws-tabs");
  if (!ws || !strip) return;
  ws.classList.toggle("has-windows", all.size > 0);
  const wins = [...all];
  const tabs = wins.map((w) => h(`div.ws-tab${w.el.classList.contains("active") && !ws.classList.contains("launcher-open") ? ".on" : ""}`, {
    title: w.titleText(),
    on: { click: () => w.focus(), auxclick: (e) => e.button === 1 && w.close() },
  }, h("span", w.titleText()), h("button.ws-tab-x", { title: "Close", on: { click: (e) => {
    e.stopPropagation();
    w.close();
  } } }, "✕")));
  const lay = layout();
  strip.replaceChildren(...[
    ...tabs,
    h(`button.ws-tab-new${ws.classList.contains("launcher-open") ? ".on" : ""}`, { title: "Open another tool", on: { click: () => {
      ws.classList.add("launcher-open");
      renderStrip();
    } } }, "+"),
    h("span.grow"),
    lay === "float" && wins.length > 1 ? h("button.ws-tile", { title: "Arrange all windows side by side", on: { click: tile } }, "Tile") : null,
    h("span.seg.ws-layout",
      h(`button${lay === "tabs" ? ".on" : ""}`, { title: "One tool at a time, full size", on: { click: () => setLayout("tabs") } }, "Tabs"),
      h(`button${lay === "float" ? ".on" : ""}`, { title: "Floating windows you can arrange side by side (Winbox style)", on: { click: () => setLayout("float") } }, "Windows")),
  ].filter(Boolean));
}

/** Keeps windows reachable when the app window gets smaller. */
function keepInside() {
  const ws = workspace();
  if (!ws || !ws.clientWidth || outer().hidden || outer().classList.contains("tabbed")) return;
  for (const el of ws.querySelectorAll(".mdi-win:not(.maximized)")) {
    const w = Math.min(el.offsetWidth, ws.clientWidth);
    const hgt = Math.min(el.offsetHeight, ws.clientHeight);
    if (w !== el.offsetWidth) el.style.width = `${w}px`;
    if (hgt !== el.offsetHeight) el.style.height = `${hgt}px`;
    el.style.left = `${Math.max(0, Math.min(el.offsetLeft, ws.clientWidth - w))}px`;
    el.style.top = `${Math.max(0, Math.min(el.offsetTop, ws.clientHeight - hgt))}px`;
  }
}
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(keepInside, 120);
});

/**
 * Opens a window, or focuses the existing one with the same `key`.
 * Returns { el, body, close(), setTitle(), onClose(fn), onResize(fn), isNew }.
 */
export function openWindow({ key, title, width = 640, height = 380 }) {
  // Windows live on the Advanced page; opening one from another page (e.g. the
  // Terminal button) goes there, or it would open out of sight.
  if (currentView() !== "windows") showView("windows");
  if (key && open.has(key)) {
    const w = open.get(key);
    w.focus();
    return { ...w, isNew: false };
  }

  const titleText = h("span", title);
  const body = h("div.mdi-body");
  const btnMax = h("button", { title: "Maximize" }, "□");
  const btnClose = h("button", { title: "Close" }, "✕");
  const bar = h("div.mdi-title", titleText, btnMax, btnClose);
  const grip = h("div.mdi-resize");
  const el = h("div.mdi-win", bar, body, grip);

  const ws = workspace();
  const off = (cascade++ % 8) * 24;
  el.style.left = `${Math.min(20 + off, Math.max(0, ws.clientWidth - width))}px`;
  el.style.top = `${Math.min(14 + off, Math.max(0, ws.clientHeight - height))}px`;
  el.style.width = `${Math.min(width, ws.clientWidth - 10)}px`;
  el.style.height = `${Math.min(height, ws.clientHeight - 10)}px`;
  ws.appendChild(el);

  const closeHandlers = [];
  const resizeHandlers = [];
  const fireResize = () => resizeHandlers.forEach((fn) => fn());

  const win = {
    el,
    body,
    titleText: () => titleText.textContent,
    focus() {
      for (const other of all) other.el.classList.remove("active");
      el.classList.add("active");
      el.style.zIndex = ++zTop;
      outer().classList.remove("launcher-open");
      renderStrip();
      fireResize();
    },
    close() {
      closeHandlers.forEach((fn) => {
        try {
          fn();
        } catch (e) {
          console.error(e);
        }
      });
      el.remove();
      if (key) open.delete(key);
      all.delete(win);
      // the most recently used window comes forward
      const next = [...all].sort((a, b) => (Number(b.el.style.zIndex) || 0) - (Number(a.el.style.zIndex) || 0))[0];
      if (next && el.classList.contains("active")) next.focus();
      else renderStrip();
    },
    setTitle(t) {
      titleText.textContent = t;
      renderStrip();
    },
    onClose(fn) {
      closeHandlers.push(fn);
    },
    onResize(fn) {
      resizeHandlers.push(fn);
    },
    refit: fireResize,
  };

  el.addEventListener("mousedown", () => win.focus());
  btnClose.addEventListener("click", (e) => {
    e.stopPropagation();
    win.close();
  });
  const toggleMax = () => {
    el.classList.toggle("maximized");
    fireResize();
  };
  btnMax.addEventListener("click", toggleMax);
  bar.addEventListener("dblclick", toggleMax);

  // moving: stays inside the area, clings to its edges and to other windows,
  // and snaps to a half (left/right edge) or the whole area (top edge)
  let zone = null;
  drag(bar, (dx, dy, start, ev) => {
    if (el.classList.contains("maximized")) return;
    const W = ws.clientWidth;
    const H = ws.clientHeight;
    // a snapped window gets its own size back as soon as it's moved
    if (el.dataset.snapped && !start.unsnapped) {
      start.unsnapped = true;
      const [w0, h0] = el.dataset.snapped.split("x").map(Number);
      delete el.dataset.snapped;
      start.left += (start.width - w0) * ((start.x - ws.getBoundingClientRect().left - start.left) / start.width);
      start.width = w0;
      start.height = h0;
      el.style.width = `${w0}px`;
      el.style.height = `${h0}px`;
      fireResize();
    }
    const w = Math.min(el.offsetWidth, W);
    const hgt = Math.min(el.offsetHeight, H);
    const [left, top] = magnet(start.left + dx, start.top + dy, w, hgt, W, H, el);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    const r = ws.getBoundingClientRect();
    const px = ev.clientX - r.left;
    const py = ev.clientY - r.top;
    zone = py <= EDGE ? "max" : px <= EDGE ? "left" : px >= W - EDGE ? "right" : null;
    snapPreview(zone, W, H);
  }, () => {
    snapPreview(null);
    if (!zone) return;
    if (!el.dataset.snapped) el.dataset.snapped = `${el.offsetWidth}x${el.offsetHeight}`;
    const W = ws.clientWidth;
    const H = ws.clientHeight;
    const half = Math.round(W / 2);
    Object.assign(el.style, zone === "max"
      ? { left: "0px", top: "0px", width: `${W}px`, height: `${H}px` }
      : { left: zone === "left" ? "0px" : `${W - half}px`, top: "0px", width: `${half}px`, height: `${H}px` });
    zone = null;
    fireResize();
  });
  // resizing: not past the area's right and bottom edges
  drag(grip, (dx, dy, start) => {
    delete el.dataset.snapped;
    el.style.width = `${Math.max(260, Math.min(ws.clientWidth - el.offsetLeft, start.width + dx))}px`;
    el.style.height = `${Math.max(140, Math.min(ws.clientHeight - el.offsetTop, start.height + dy))}px`;
    fireResize();
  });

  if (key) open.set(key, win);
  all.add(win);
  win.focus();
  return { ...win, isNew: true };
}

/** Pointer drag on `handle`: move(dx, dy, start, event) while moving, end() when let go. */
function drag(handle, move, end = () => {}) {
  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.tagName === "BUTTON") return;
    e.preventDefault();
    const el = handle.parentElement;
    const start = { x: e.clientX, y: e.clientY, left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
    const onMove = (ev) => move(ev.clientX - start.x, ev.clientY - start.y, start, ev);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      end();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

/** How close (px) a window edge must come to cling to an edge. */
const SNAP = 14;
/** How close (px) the pointer must come to an edge to snap to a half or the whole area. */
const EDGE = 6;

/**
 * Where a window of w×h dragged to (left, top) ends up in a W×H area: always
 * fully inside, clinging to the area's edges and to other windows' edges. Pure
 * apart from reading the other windows' positions.
 */
function magnet(left, top, w, h, W, H, self) {
  const others = [...workspace().querySelectorAll(".mdi-win")].filter((o) => o !== self && o.offsetParent)
    .map((o) => ({ l: o.offsetLeft, t: o.offsetTop, r: o.offsetLeft + o.offsetWidth, b: o.offsetTop + o.offsetHeight }));
  const xs = [0, W, ...others.flatMap((o) => [o.l, o.r])];
  const ys = [0, H, ...others.flatMap((o) => [o.t, o.b])];
  const cling = (pos, size, lines) => {
    for (const x of lines) {
      if (Math.abs(pos - x) < SNAP) return x; // near edge to a line
      if (Math.abs(pos + size - x) < SNAP) return x - size; // far edge to a line
    }
    return pos;
  };
  left = cling(left, w, xs);
  top = cling(top, h, ys);
  return [Math.max(0, Math.min(W - w, left)), Math.max(0, Math.min(H - h, top))];
}

/** The outline where a window will snap (null: none). */
function snapPreview(zone, W, H) {
  let p = document.getElementById("mdi-snap");
  if (!zone) {
    p?.remove();
    return;
  }
  if (!p) {
    p = h("div#mdi-snap");
    workspace().appendChild(p);
  }
  const half = Math.round(W / 2);
  Object.assign(p.style, zone === "max"
    ? { left: "0px", top: "0px", width: `${W}px`, height: `${H}px` }
    : { left: zone === "left" ? "0px" : `${W - half}px`, top: "0px", width: `${half}px`, height: `${H}px` });
}

export function closeAllWindows() {
  for (const w of [...all]) w.close();
  for (const el of [...workspace().querySelectorAll(".mdi-win")]) el.remove();
  renderStrip();
}

if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", applyLayout);

/** Tab strip; returns { el, pages: {name: element}, select(name) }. */
export function tabs(names, onSelect) {
  const strip = h("div.tabs");
  const pages = {};
  const tabEls = {};
  const wrap = h("div", { style: { display: "contents" } }, strip);
  const select = (name) => {
    for (const n of names) {
      tabEls[n].classList.toggle("active", n === name);
      pages[n].classList.toggle("active", n === name);
    }
    if (onSelect) onSelect(name);
  };
  for (const n of names) {
    tabEls[n] = h("div.tab", { on: { click: () => select(n) } }, n);
    strip.appendChild(tabEls[n]);
    pages[n] = h("div.tab-page");
    wrap.appendChild(pages[n]);
  }
  return { el: wrap, pages, select };
}

// Winbox-style right-click on a row in any window: select it, then offer the
// buttons of the toolbar that belongs to that table (Add, Remove, Enable,
// Disable, Edit, Move up…). Tables with their own menu handle it themselves.
function toolbarFor(table) {
  for (let el = table.parentElement; el && !el.classList.contains("mdi-win"); el = el.parentElement) {
    const bars = [...el.querySelectorAll(":scope > .win-toolbar, :scope > * > .win-toolbar")].filter((b) => !b.closest("table"));
    if (bars.length) return bars;
  }
  return [];
}

const SYMBOL_NAMES = { "+": "Add", "−": "Remove", "-": "Remove", "✓": "Enable", "✗": "Disable", "▲": "Move up", "▼": "Move down", "⟳": "Reload" };

// Icon-only buttons without a tooltip get their name as one.
function symbolTitle(e) {
  const b = e.target.closest?.("button");
  if (b && !b.title && SYMBOL_NAMES[b.textContent.trim()]) b.title = SYMBOL_NAMES[b.textContent.trim()];
}

function rowMenu(e) {
  const tr = e.target.closest(".mdi-win tbody tr");
  if (!tr || e.defaultPrevented) return;
  const bars = toolbarFor(tr.closest("table"));
  const buttons = bars.flatMap((b) => [...b.querySelectorAll("button")]).filter((b) => !b.disabled && b.offsetParent !== null);
  if (!buttons.length) return;
  e.preventDefault();
  tr.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  const label = (b) => {
    const text = b.textContent.trim();
    return /[a-z]{2}/i.test(text) ? text : b.title || SYMBOL_NAMES[text] || text;
  };
  import("./menu.js").then(({ popupMenu }) => popupMenu(buttons.map((b) => ({ label: label(b), fn: () => b.click() })), { event: e }));
}

if (typeof document !== "undefined") {
  document.addEventListener("contextmenu", rowMenu);
  document.addEventListener("mouseover", symbolTitle);
}
