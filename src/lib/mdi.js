// Floating, draggable, resizable sub-windows inside #workspace (Winbox MDI style).
import { h } from "./dom.js";
import { currentView, showView } from "./views.js";

const open = new Map(); // key -> window object
let zTop = 10;
let cascade = 0;

function workspace() {
  return document.getElementById("workspace");
}

/** Keeps windows reachable when the app window gets smaller. */
function keepInside() {
  const ws = workspace();
  if (!ws || ws.hidden || !ws.clientWidth) return;
  for (const el of ws.querySelectorAll(".mdi-win:not(.maximized)")) {
    const w = Math.min(el.offsetWidth, ws.clientWidth - 10);
    const hgt = Math.min(el.offsetHeight, ws.clientHeight - 10);
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
    focus() {
      for (const other of open.values()) other.el.classList.remove("active");
      el.classList.add("active");
      el.style.zIndex = ++zTop;
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
    },
    setTitle(t) {
      titleText.textContent = t;
    },
    onClose(fn) {
      closeHandlers.push(fn);
    },
    onResize(fn) {
      resizeHandlers.push(fn);
    },
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

  drag(bar, (dx, dy, start) => {
    if (el.classList.contains("maximized")) return;
    const maxX = ws.clientWidth - 40;
    const maxY = ws.clientHeight - 22;
    el.style.left = `${Math.max(-el.offsetWidth + 60, Math.min(maxX, start.left + dx))}px`;
    el.style.top = `${Math.max(0, Math.min(maxY, start.top + dy))}px`;
  });
  drag(grip, (dx, dy, start) => {
    el.style.width = `${Math.max(260, start.width + dx)}px`;
    el.style.height = `${Math.max(140, start.height + dy)}px`;
    fireResize();
  });

  if (key) open.set(key, win);
  win.focus();
  return { ...win, isNew: true };
}

function drag(handle, move) {
  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.tagName === "BUTTON") return;
    e.preventDefault();
    const el = handle.parentElement;
    const start = { x: e.clientX, y: e.clientY, left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
    const onMove = (ev) => move(ev.clientX - start.x, ev.clientY - start.y, start);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

export function closeAllWindows() {
  for (const w of [...open.values()]) w.close();
  for (const el of [...workspace().querySelectorAll(".mdi-win")]) el.remove();
}

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
