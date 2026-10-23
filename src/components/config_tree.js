// Config browser/editor for any part of the config (Firewall, NAT, Services, ...).
// Left: tree of nodes. Right: values of the selected node, with set/delete.
import { api, errorText } from "../lib/api.js";
import { h, clear, setStatus } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges } from "../lib/session.js";

const isLeafValue = (v) => typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"));

export function openConfigTree(root = [], title = "Configuration") {
  const key = `config:${root.join(" ")}`;
  const win = openWindow({ key, title, width: 900, height: 480 });
  if (!win.isNew) return;

  const tree = h("div.tree");
  const detail = h("div.tree-detail");
  const pathLabel = h("span.hint", { style: { userSelect: "text" } });
  const toolbar = h(
    "div.win-toolbar",
    h("button.icon-add", { title: "Set a value under the selected node", on: { click: setValue } }, "+ Set"),
    h("button.icon-remove", { title: "Delete the selected node", on: { click: deleteNode } }, "− Delete"),
    h("button", { title: "Reload", on: { click: load } }, "⟳"),
    h("button", { title: "Show as VyOS commands", on: { click: showCommands } }, "Commands"),
    h("span.grow"),
    pathLabel,
  );
  win.body.append(toolbar, h("div.tree-pane", tree, detail));

  let data = {};
  let selected = root;
  const expanded = new Set([root.join(" ")]);

  const nodeAt = (path) => {
    let n = data;
    for (const p of path.slice(root.length)) {
      if (n == null || typeof n !== "object") return undefined;
      n = n[p];
    }
    return n;
  };

  function renderTree() {
    clear(tree);
    const walk = (node, path, depth) => {
      for (const [k, v] of Object.entries(node || {})) {
        const p = [...path, k];
        const id = p.join(" ");
        const leaf = isLeafValue(v);
        const container = v && typeof v === "object" && !Array.isArray(v);
        const hasChildren = container && Object.keys(v).length > 0;
        const open = expanded.has(id);
        const row = h(
          "div.tree-node",
          { style: { paddingLeft: `${4 + depth * 14}px` } },
          h("span.twisty", hasChildren ? (open ? "▾" : "▸") : ""),
          k,
          leaf ? h("span.tree-leaf", ` ${Array.isArray(v) ? v.join(", ") : v}`) : null,
        );
        if (id === selected.join(" ")) row.classList.add("sel");
        row.addEventListener("click", () => {
          if (hasChildren) open ? expanded.delete(id) : expanded.add(id);
          select(p);
        });
        tree.append(row);
        if (hasChildren && open) walk(v, p, depth + 1);
      }
    };
    walk(data, root, 0);
    if (!Object.keys(data || {}).length) tree.append(h("div.hint", { style: { padding: "6px" } }, "(nothing configured here)"));
  }

  function select(path) {
    selected = path;
    pathLabel.textContent = path.join(" ") || "(root)";
    renderTree();
    renderDetail();
  }

  function renderDetail() {
    clear(detail);
    const node = nodeAt(selected);
    if (isLeafValue(node)) {
      detail.append(h("table.kv", h("tr", h("td", selected[selected.length - 1]), h("td.val", Array.isArray(node) ? node.join("\n") : node))));
      return;
    }
    const rows = Object.entries(node || {}).map(([k, v]) =>
      h("tr", h("td", k), h("td.val", isLeafValue(v) ? (Array.isArray(v) ? v.join(", ") : v) : Object.keys(v || {}).length ? `{${Object.keys(v).length} items}` : "(set)")),
    );
    detail.append(rows.length ? h("table.kv", rows) : h("div.hint", "Nothing below this node."));
  }

  async function load() {
    try {
      data = (await api.getConfig(root)) || {};
      if (selected.length > root.length && nodeAt(selected) === undefined) selected = root;
      select(selected);
    } catch (e) {
      setStatus(errorText(e), true);
    }
  }

  async function setValue() {
    await formDialog("Set configuration", [
      { name: "rel", label: `${selected.join(" ") || "(root)"} …`, placeholder: "e.g. rule 10 action accept", hint: "Path words after the selected node, separated by spaces. The last word is used as the value if 'Value' is empty and the node needs one." },
      { name: "value", label: "Value", placeholder: "optional" },
    ], async (v) => {
      const rel = v.rel.trim().split(/\s+/).filter(Boolean);
      const path = [...selected, ...rel];
      if (!path.length) throw new Error("Nothing to set");
      const cmd = { op: "set", path };
      if (v.value.trim()) cmd.value = v.value.trim();
      await applyChanges([cmd], `set ${path.join(" ")}`);
      await load();
      return true;
    }, { okLabel: "Apply" });
  }

  async function deleteNode() {
    if (selected.length <= root.length && !root.length) return setStatus("Select a node to delete.", true);
    if (!(await confirmBox("Delete", `delete ${selected.join(" ")}\n\nThis removes the node and everything under it.`, "Delete"))) return;
    try {
      await applyChanges([{ op: "delete", path: selected }], `delete ${selected.join(" ")}`);
      selected = selected.slice(0, -1).length >= root.length ? selected.slice(0, -1) : root;
      await load();
    } catch (e) {
      alertBox("Apply failed", errorText(e));
    }
  }

  function showCommands() {
    const lines = [];
    const quote = (s) => (/^[A-Za-z0-9._\/:@-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);
    const walk = (node, path) => {
      if (isLeafValue(node)) {
        for (const v of [].concat(node)) lines.push(`set ${[...path.map(quote), quote(v)].join(" ")}`);
        return;
      }
      const entries = Object.entries(node || {});
      if (!entries.length) lines.push(`set ${path.map(quote).join(" ")}`);
      for (const [k, v] of entries) walk(v, [...path, k]);
    };
    walk(nodeAt(selected), selected);
    alertBox(`Commands: ${selected.join(" ") || "(root)"}`, lines.join("\n") || "(empty)");
  }

  load();
}
