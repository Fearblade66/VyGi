// Shared numbered-rule editor used by the Firewall and NAT windows.
// Rules live at `<base> rule <N> ...` in the VyOS config.
import { api, errorText } from "./api.js";
import { h, setStatus } from "./dom.js";
import { makeTable, filterBox } from "./table.js";
import { formDialog, confirmBox, alertBox } from "./dialog.js";
import { applyChanges } from "./session.js";
import { getPath, setPath, toCommands, has, toArray, diffMulti } from "./vyos.js";
import { ownerOf, manualDescription } from "./owner.js";
import { ownerBadge, confirmOwned } from "../components/owned.js";

const MAX_RULE = 999999;

/**
 * Field spec: { name, label, path: [...relative to the rule], type: text|select|multicheck|flag,
 *               options?, hint?, placeholder? }
 * opts: {
 *   page: element to render into,
 *   getBase(): config path of the node that holds `rule` (e.g. ["nat","source"]),
 *   columns: table columns (row = { number, cfg, ...}) ,
 *   getFields(): field specs (may depend on the selected chain),
 *   newDefaults: values for a new rule's form,
 *   validate?(values): throw Error to reject,
 *   extraToolbar?: elements appended to the toolbar,
 *   onNode?(node): called with the whole base node after each load,
 *   what: "rule" noun for messages
 * }
 */
export function ruleEditor(opts) {
  const what = opts.what || "rule";
  let rules = []; // [{number, cfg}]

  const table = makeTable(
    [
      { key: "flags", label: "", width: "26px", className: "flag" },
      { key: "number", label: "#", width: "52px", className: "num" },
      { key: "owner", label: "Managed by", width: "150px", render: (r) => ownerBadge(r.cfg.description), sortValue: (r) => r.owner },
      ...opts.columns,
    ],
    {
      rowKey: (r) => r.number,
      onOpen: (r) => edit(r),
      rowClass: (r) => (r.disabled ? "disabled" : ""),
    },
  );

  const needSel = (fn) => () => {
    const r = table.selected();
    if (!r) return setStatus(`Select a ${what} first.`, true);
    fn(r);
  };
  const toolbar = h(
    "div.win-toolbar",
    h("button.icon-add", { title: `Add ${what}`, on: { click: () => edit(null) } }, "+"),
    h("button.icon-remove", { title: "Remove", on: { click: needSel(remove) } }, "−"),
    h("button.icon-ok", { title: "Enable", on: { click: needSel((r) => setDisabled(r, false)) } }, "✓"),
    h("button.icon-x", { title: "Disable", on: { click: needSel((r) => setDisabled(r, true)) } }, "✗"),
    h("button", { title: "Edit", on: { click: needSel(edit) } }, "Edit"),
    h("button", { title: "Move up (earlier = checked first)", on: { click: needSel((r) => move(r, -1)) } }, "▲"),
    h("button", { title: "Move down", on: { click: needSel((r) => move(r, 1)) } }, "▼"),
    h("button", { title: "Reload", on: { click: () => load() } }, "⟳"),
    ...(opts.extraToolbar || []),
    h("span.grow"),
    filterBox(table),
  );
  opts.page.append(toolbar, table.wrap, table.count);

  const ruleBase = () => [...opts.getBase(), "rule"];

  async function load() {
    let node = {};
    try {
      node = (await api.getConfig(opts.getBase())) || {};
    } catch (e) {
      setStatus(errorText(e), true);
    }
    if (opts.onNode) opts.onNode(node);
    rules = Object.entries(node.rule || {})
      .map(([n, cfg]) => ({ number: Number(n), cfg: cfg || {} }))
      .sort((a, b) => a.number - b.number);
    table.setRows(
      rules.map((r) => {
        const disabled = has(r.cfg, "disable");
        const o = ownerOf(r.cfg.description);
        const row = { number: r.number, cfg: r.cfg, disabled, flags: disabled ? "X" : "", owner: o ? `${o.feature} ${o.name}` : "" };
        for (const c of opts.columns) {
          if (c.path) row[c.key] = toArray(getPath(r.cfg, c.path)).join(", ");
          else if (c.value) row[c.key] = c.value(r.cfg);
        }
        return row;
      }),
    );
  }

  async function run(cmds, label) {
    try {
      await applyChanges(cmds, label);
    } catch (e) {
      alertBox("Apply failed", errorText(e));
      setStatus(errorText(e), true);
    }
    await load();
  }

  /** Asks before touching a rule a simple page made; false = stop. */
  async function owned(r, action) {
    const choice = await confirmOwned(r.cfg.description, what, { canDetach: true });
    if (!choice) return false;
    if (choice === "manual") {
      await run([{ op: "set", path: [...ruleBase(), String(r.number), "description"], value: manualDescription(r.cfg.description) }], `${what} ${r.number}: make it manual`);
      const fresh = rules.find((x) => x.number === r.number);
      if (fresh && action) action({ ...r, cfg: fresh.cfg });
      return false;
    }
    return true;
  }

  async function setDisabled(r, disable) {
    if (!(await owned(r, (fresh) => setDisabled(fresh, disable)))) return;
    run([{ op: disable ? "set" : "delete", path: [...ruleBase(), String(r.number), "disable"] }], `${disable ? "disable" : "enable"} ${what} ${r.number}`);
  }

  async function remove(r) {
    if (ownerOf(r.cfg.description) && !(await owned(r, null))) return;
    if (!(await confirmBox(`Remove ${what}`, `Delete ${what} ${r.number}?`, "Remove"))) return;
    run([{ op: "delete", path: [...ruleBase(), String(r.number)] }], `remove ${what} ${r.number}`);
  }

  /** Swaps a rule with its neighbour by exchanging rule numbers, in one commit. */
  async function move(r, dir) {
    const i = rules.findIndex((x) => x.number === r.number);
    const other = rules[i + dir];
    if (!other) return setStatus(`Already at the ${dir < 0 ? "top" : "bottom"}.`);
    // VyGi's pages keep their rules in a set order
    for (const x of [r, other]) if (ownerOf(x.cfg.description) && !(await owned(x, null))) return;
    const base = ruleBase();
    const cmds = [
      { op: "delete", path: [...base, String(r.number)] },
      { op: "delete", path: [...base, String(other.number)] },
      ...toCommands(r.cfg, [...base, String(other.number)]),
      ...toCommands(other.cfg, [...base, String(r.number)]),
    ];
    run(cmds, `move ${what} ${r.number}`);
  }

  function nextNumber() {
    const max = rules.length ? rules[rules.length - 1].number : 0;
    return Math.min(MAX_RULE, Math.floor(max / 10) * 10 + 10);
  }

  async function edit(r) {
    if (r && ownerOf(r.cfg.description) && !(await owned(r, (fresh) => edit(fresh)))) return;
    const fields = opts.getFields();
    const cfg = r ? r.cfg : {};
    const formFields = [
      { name: "__number", label: "Number", value: String(r ? r.number : nextNumber()), hint: "Rules are checked in number order." },
      ...fields.map((f) => {
        const cur = getPath(cfg, f.path);
        const value = r ? (f.type === "flag" ? getPath(cfg, f.path) !== undefined : f.type === "multicheck" ? toArray(cur) : toArray(cur).join(" ")) : opts.newDefaults?.[f.name];
        return { name: f.name, label: f.label, type: f.type === "flag" ? "checkbox" : f.type || "text", options: f.options, hint: f.hint, placeholder: f.placeholder, value };
      }),
      { name: "__disabled", label: "Disabled", type: "checkbox", value: r ? r.disabled : false },
    ];

    await formDialog(r ? `${opts.title || "Rule"} <${r.number}>` : `New ${what}`, formFields, async (v) => {
      const number = Number(v.__number);
      if (!Number.isInteger(number) || number < 1 || number > MAX_RULE) throw new Error(`Number must be 1-${MAX_RULE}`);
      if ((!r || number !== r.number) && rules.some((x) => x.number === number)) throw new Error(`${what} ${number} already exists`);
      if (opts.validate) opts.validate(v);

      // Build the new rule from the old one so settings this form doesn't show are kept.
      const next = structuredClone(cfg);
      for (const f of fields) {
        const raw = v[f.name];
        if (f.type === "flag") setPath(next, f.path, raw ? {} : undefined);
        else if (f.type === "multicheck") setPath(next, f.path, raw.length ? raw : undefined);
        else {
          const val = String(raw ?? "").trim();
          setPath(next, f.path, val ? val : undefined);
        }
      }
      setPath(next, ["disable"], v.__disabled ? {} : undefined);

      const base = ruleBase();
      let cmds;
      if (!r || number !== r.number) {
        cmds = [...(r ? [{ op: "delete", path: [...base, String(r.number)] }] : []), ...toCommands(next, [...base, String(number)])];
      } else {
        cmds = diffRule(cfg, next, [...base, String(number)], fields);
      }
      if (!cmds.length) return true;
      await applyChanges(cmds, `${what} ${number}`);
      await load();
      return true;
    }, { okLabel: "Apply", intro: opts.intro });
  }

  return { load, table };
}

/** Minimal set/delete commands to turn rule `a` into `b` for the given fields. */
function diffRule(a, b, rulePath, fields) {
  const cmds = [];
  const paths = [...fields.map((f) => ({ path: f.path, type: f.type })), { path: ["disable"], type: "flag" }];
  for (const { path, type } of paths) {
    const before = getPath(a, path);
    const after = getPath(b, path);
    const full = [...rulePath, ...path];
    if (type === "flag") {
      if (!!before !== !!after) cmds.push(after ? { op: "set", path: full } : { op: "delete", path: full });
    } else if (type === "multicheck") {
      cmds.push(...diffMulti(full.slice(0, -1), full[full.length - 1], toArray(before), toArray(after)));
    } else if (toArray(before).join(" ") !== toArray(after).join(" ")) {
      cmds.push(after == null ? { op: "delete", path: full } : { op: "set", path: full, value: String(after) });
    }
  }
  return cmds;
}
