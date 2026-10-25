// Modal dialogs: alert, confirm, and form dialogs.
import { h } from "./dom.js";

/**
 * Shows a modal. `buttons`: [{label, value, primary?}]. `onButton(value)` may
 * return false (or a Promise of false) to keep the dialog open.
 * Resolves to the clicked value, or null if dismissed with Escape.
 */
export function modal(title, content, buttons, onButton) {
  return new Promise((resolve) => {
    const btnEls = buttons.map((b) =>
      h(`button${b.primary ? ".primary" : ""}${b.danger ? ".danger" : ""}${b.left ? ".left" : ""}`, { on: { click: () => press(b.value) } }, b.label),
    );
    const dialog = h("div.dialog", h("div.mdi-title", h("span", title)), h("div.dialog-body", content), h("div.dialog-buttons", btnEls));
    const back = h("div.modal-back", dialog);
    const onKey = (e) => {
      if (e.key === "Escape") finish(null);
      if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
        const primary = buttons.find((b) => b.primary);
        if (primary) {
          e.preventDefault();
          press(primary.value);
        }
      }
    };
    let busy = false;
    async function press(value) {
      if (busy) return;
      if (onButton && value !== null && value !== "cancel") {
        busy = true;
        btnEls.forEach((b) => (b.disabled = true));
        let keep = false;
        try {
          keep = (await onButton(value)) === false;
        } finally {
          busy = false;
          btnEls.forEach((b) => (b.disabled = false));
        }
        if (keep) return;
      }
      finish(value);
    }
    function finish(value) {
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      resolve(value);
    }
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(back);
    const first = dialog.querySelector("input, select, textarea");
    (first || btnEls[btnEls.length - 1] || dialog).focus();
  });
}

export function alertBox(title, message) {
  return modal(title, h("div", { style: { whiteSpace: "pre-wrap", userSelect: "text" } }, message), [{ label: "OK", value: "ok", primary: true }]);
}

export async function confirmBox(title, message, okLabel = "OK") {
  const r = await modal(title, h("div", { style: { whiteSpace: "pre-wrap" } }, message), [
    { label: "Cancel", value: "cancel" },
    { label: okLabel, value: "ok", primary: true },
  ]);
  return r === "ok";
}

/**
 * Form dialog. fields: [{name, label, type: text|password|number|checkbox|select|textarea, value, options, hint}]
 * `submit(values)` runs on OK; throw or return false to keep the dialog open.
 * Resolves to the values, or null on cancel.
 */
export async function formDialog(title, fields, submit, { intro, okLabel = "OK", onChange, initChange = false, extra = null } = {}) {
  const inputs = {};
  const parts = {}; // field -> its grid elements (for show/hide)
  const hints = {};
  const errBox = h("div.err-box", { hidden: true });
  const grid = h("div.form");
  for (const f of fields) {
    let input;
    if (f.type === "select") {
      input = h("select", (f.options || []).map((o) => h("option", { value: o.value ?? o, selected: (o.value ?? o) === f.value }, o.label ?? o)));
    } else if (f.type === "textarea") {
      input = h("textarea", { rows: f.rows || 4, value: f.value ?? "" });
    } else if (f.type === "checkbox") {
      input = h("input", { type: "checkbox", checked: !!f.value });
    } else if (f.type === "multicheck") {
      const chosen = new Set(f.value || []);
      const opts = f.options || [];
      input = h(`span.multicheck${opts.length > 7 ? ".long" : ""}`, opts.map((o) => h("label", h("input", { type: "checkbox", value: o, checked: chosen.has(o) }), " ", o)));
    } else {
      input = h("input", { type: f.type || "text", value: f.value ?? "", placeholder: f.placeholder || "" });
    }
    inputs[f.name] = input;
    const els = f.type === "checkbox"
      ? [h("span"), h("label", { style: { textAlign: "left" } }, input, " ", f.label)]
      : [h("label", f.label), input];
    if (f.hint !== undefined) {
      hints[f.name] = h("span.hint", f.hint);
      els.push(h("span"), hints[f.name]);
    }
    parts[f.name] = els;
    grid.append(...els);
  }
  const read = () => {
    const out = {};
    for (const f of fields) {
      const el = inputs[f.name];
      if (f.type === "multicheck") out[f.name] = [...el.querySelectorAll("input:checked")].map((c) => c.value);
      else out[f.name] = f.type === "checkbox" ? el.checked : f.type === "number" ? Number(el.value) : el.value;
    }
    return out;
  };
  if (onChange) {
    // onChange(fieldName, values, set) lets a form refill fields, e.g. when a select changes.
    const set = (name, value) => {
      if (inputs[name] && "value" in inputs[name]) inputs[name].value = value;
    };
    // set.show(name, bool) hides a field; set.hint(name, text) rewrites its hint.
    set.show = (name, on) => {
      (parts[name] || []).forEach((el) => (el.hidden = !on));
      if (hints[name] && !hints[name].textContent) hints[name].hidden = hints[name].previousSibling.hidden = true;
    };
    set.hint = (name, text) => {
      if (hints[name]) {
        hints[name].textContent = text;
        hints[name].hidden = !text;
        hints[name].previousSibling.hidden = !text;
      }
    };
    for (const f of fields) inputs[f.name].addEventListener("change", () => onChange(f.name, read(), set));
    if (initChange) onChange(null, read(), set);
  }
  let result = null;
  // extra: { label, onClick } adds a left-aligned danger button (e.g. Delete) that closes the form.
  const r = await modal(title, h("div", intro ? h("div.warn-box", intro) : null, errBox, grid), [
    { label: "Cancel", value: "cancel" },
    { label: okLabel, value: "ok", primary: true },
    // last in the DOM (Cancel stays the first button), shown on the left by CSS
    ...(extra ? [{ label: extra.label, value: "extra", danger: true, left: true }] : []),
  ], async (value) => {
    if (value === "extra") return true;
    errBox.hidden = true;
    try {
      const values = read();
      if (submit && (await submit(values)) === false) return false;
      result = values;
      return true;
    } catch (e) {
      errBox.textContent = e && e.message ? e.message : String(e);
      errBox.hidden = false;
      return false;
    }
  });
  if (r === "extra") await extra.onClick();
  return r === "ok" ? result : null;
}
