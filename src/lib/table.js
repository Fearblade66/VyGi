// Data grid with single-row selection, used by most windows.
import { h, clear } from "./dom.js";

/**
 * columns: [{ key, label, width?, className?, render?(row) -> string|Node }]
 * opts: { rowKey(row), onOpen(row), rowClass(row) }
 */
export function makeTable(columns, opts = {}) {
  const rowKey = opts.rowKey || ((r, i) => i);
  const thead = h("thead", h("tr", columns.map((c) => h("th", { style: c.width ? { width: c.width } : {} }, c.label))));
  const tbody = h("tbody");
  const table = h("table.grid", thead, tbody);
  const wrap = h("div.table-wrap", table);
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

/** A "Find" box for a window toolbar. */
export function filterBox(table) {
  return h("input", { type: "text", placeholder: "Find", style: { width: "140px" }, on: { input: (e) => table.setFilter(e.target.value) } });
}
