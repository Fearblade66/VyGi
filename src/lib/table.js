// Data grid with single-row selection, used by most windows.
import { h, clear } from "./dom.js";

/**
 * columns: [{ key, label, width?, className?, render?(row) -> string|Node }]
 * opts: { rowKey(row), onOpen(row), rowClass(row) }
 */
export function makeTable(columns, opts = {}) {
  const rowKey = opts.rowKey || ((r, i) => i);
  const ths = columns.map((c) => h("th", { style: c.width ? { width: c.width } : {} }, c.label));
  const thead = h("thead", h("tr", ths));
  const tbody = h("tbody");
  const table = h("table.grid", thead, tbody);
  const wrap = h("div.table-wrap", table);
  resizableColumns(table, ths, `vygi.cols.${columns.map((c) => c.key).join(",")}`);
  const count = h("div.row-count");
  let rows = [];
  let selectedKey = null;
  let filterText = "";

  function matches(row) {
    if (!filterText) return true;
    const needle = filterText.toLowerCase();
    return columns.some((c) => String(row[c.key] ?? "").toLowerCase().includes(needle));
  }

  function render() {
    const scroll = wrap.scrollTop;
    clear(tbody);
    let shown = 0;
    rows.forEach((row, i) => {
      if (!matches(row)) return;
      shown++;
      const key = rowKey(row, i);
      const tr = h(
        "tr",
        columns.map((c) => {
          const v = c.render ? c.render(row) : row[c.key];
          return h(`td${c.className ? "." + c.className : ""}`, { title: typeof v === "string" ? v : "" }, v ?? "");
        }),
      );
      if (key === selectedKey) tr.classList.add("sel");
      const extra = opts.rowClass && opts.rowClass(row);
      if (extra) tr.classList.add(extra);
      tr.addEventListener("mousedown", () => {
        selectedKey = key;
        for (const other of tbody.children) other.classList.remove("sel");
        tr.classList.add("sel");
        if (opts.onSelect) opts.onSelect(row);
      });
      if (opts.onOpen) tr.addEventListener("dblclick", () => opts.onOpen(row));
      tbody.appendChild(tr);
    });
    count.textContent = shown === rows.length ? `${rows.length} items` : `${shown} of ${rows.length} items`;
    wrap.scrollTop = scroll;
  }

  return {
    wrap,
    count,
    setRows(newRows) {
      rows = newRows;
      if (selectedKey != null && !rows.some((r, i) => rowKey(r, i) === selectedKey)) selectedKey = null;
      render();
    },
    selected() {
      return rows.find((r, i) => rowKey(r, i) === selectedKey) || null;
    },
    setFilter(text) {
      filterText = text.trim();
      render();
    },
  };
}

/**
 * Drag a header's right edge to resize that column (the table grows and
 * scrolls sideways, like Winbox); double-click it to reset every column.
 * Widths are remembered per kind of table under `key`.
 */
export function resizableColumns(table, ths, key) {
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  };
  const store = (widths) => {
    try {
      if (widths) localStorage.setItem(key, JSON.stringify(widths));
      else localStorage.removeItem(key);
    } catch {
      /* not remembered */
    }
  };
  const defaults = ths.map((th) => th.style.width);
  const apply = (widths) => {
    ths.forEach((th, i) => (th.style.width = widths ? `${widths[i]}px` : defaults[i]));
    table.style.width = widths ? `${widths.reduce((a, b) => a + b, 0)}px` : "";
  };
  const saved = load();
  if (Array.isArray(saved) && saved.length === ths.length) apply(saved);

  ths.forEach((th, i) => {
    const grip = h("span.col-grip");
    th.append(grip);
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      // fix every column at its current width, then only this one changes
      const widths = ths.map((x) => Math.round(x.getBoundingClientRect().width));
      const x0 = e.clientX;
      const w0 = widths[i];
      apply(widths);
      document.body.classList.add("col-resizing");
      const move = (ev) => {
        widths[i] = Math.max(30, w0 + ev.clientX - x0);
        apply(widths);
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        document.body.classList.remove("col-resizing");
        store(widths);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
    grip.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      apply(null);
      store(null);
    });
  });
}

/** A "Find" box for a window toolbar. */
export function filterBox(table) {
  return h("input", { type: "text", placeholder: "Find", style: { width: "140px" }, on: { input: (e) => table.setFilter(e.target.value) } });
}
