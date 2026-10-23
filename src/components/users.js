// System > Users: router login accounts (system login user), passwords and SSH keys.
import { api, errorText } from "../lib/api.js";
import { h, setStatus } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { makeTable, filterBox } from "../lib/table.js";
import { formDialog, alertBox, confirmBox } from "../lib/dialog.js";
import { applyChanges, session } from "../lib/session.js";
import { openConfigTree } from "./config_tree.js";

const USERS = ["system", "login", "user"];
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const KEY_TYPES = ["ssh-dss", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-ed25519", "sk-ecdsa-sha2-nistp256@openssh.com", "sk-ssh-ed25519@openssh.com"];

/** "ssh-ed25519 AAAA... me@laptop" -> {type, key, comment} */
export function parseSshKey(line) {
  const parts = line.trim().split(/\s+/);
  const i = parts.findIndex((p) => KEY_TYPES.includes(p));
  if (i < 0 || !parts[i + 1] || !/^[A-Za-z0-9+/=]+$/.test(parts[i + 1])) return null;
  return { type: parts[i], key: parts[i + 1], comment: parts.slice(i + 2).join(" ") };
}

function keyName(comment, existing) {
  let base = (comment || "key").replace(/[^A-Za-z0-9._@-]/g, "-").slice(0, 40) || "key";
  let name = base;
  for (let n = 2; existing.includes(name); n++) name = `${base}-${n}`;
  return name;
}

function keyCommands(user, parsed, name) {
  const base = [...USERS, user, "authentication", "public-keys", name];
  return [
    { op: "set", path: [...base, "type"], value: parsed.type },
    { op: "set", path: [...base, "key"], value: parsed.key },
  ];
}

function checkPassword(p1, p2) {
  if (p1.length < 8) throw new Error("Password must be at least 8 characters");
  if (p1 !== p2) throw new Error("Passwords do not match");
}

export function openUsers() {
  const win = openWindow({ key: "users", title: "Users", width: 760, height: 380 });
  if (!win.isNew) return;
  let users = {};

  const table = makeTable(
    [
      { key: "name", label: "Name", width: "120px" },
      { key: "fullName", label: "Full Name", width: "160px" },
      { key: "kind", label: "Access", width: "80px" },
      { key: "auth", label: "Login with", width: "150px" },
      { key: "keys", label: "SSH Keys" },
    ],
    { rowKey: (r) => r.name },
  );
  const sel = (fn) => () => {
    const r = table.selected();
    if (!r) return setStatus("Select a user first.", true);
    fn(r);
  };
  win.body.append(
    h(
      "div.win-toolbar",
      h("button.icon-add", { on: { click: addUser } }, "+"),
      h("button.icon-remove", { on: { click: sel(removeUser) } }, "−"),
      h("button", { on: { click: sel(changePassword) } }, "Password…"),
      h("button", { on: { click: sel(addKey) } }, "+ SSH Key…"),
      h("button", { on: { click: sel(removeKey) } }, "− SSH Key…"),
      h("button", { on: { click: () => openConfigTree(["system", "login"], "Login Config") } }, "Config…"),
      h("button", { on: { click: load } }, "⟳"),
      h("span.grow"),
      filterBox(table),
    ),
    table.wrap,
    table.count,
  );

  async function load() {
    try {
      users = (await api.getConfig(USERS)) || {};
    } catch (e) {
      return setStatus(errorText(e), true);
    }
    table.setRows(
      Object.entries(users).map(([name, c]) => {
        const auth = c?.authentication || {};
        const keys = Object.entries(auth["public-keys"] || {});
        return {
          name,
          fullName: c?.["full-name"] || "",
          kind: c?.operator ? "operator" : "admin",
          auth: [auth["encrypted-password"] || auth["plaintext-password"] ? "password" : null, keys.length ? "SSH key" : null].filter(Boolean).join(" + ") || "(none)",
          keys: keys.map(([k, v]) => `${k} (${v?.type || "?"})`).join(", "),
          keyNames: keys.map(([k]) => k),
        };
      }),
    );
  }

  const me = () => session.info?.profile.sshUser;

  async function addUser() {
    await formDialog("New User", [
      { name: "name", label: "Username", placeholder: "lowercase, e.g. alice" },
      { name: "fullName", label: "Full name" },
      { name: "p1", label: "Password", type: "password" },
      { name: "p2", label: "Repeat password", type: "password" },
      { name: "key", label: "SSH public key", type: "textarea", rows: 3, placeholder: "optional: ssh-ed25519 AAAA... you@laptop" },
    ], async (v) => {
      const name = v.name.trim();
      if (!USER_RE.test(name)) throw new Error("Username: lowercase letters, digits, - and _, starting with a letter");
      if (users[name]) throw new Error(`${name} already exists`);
      const parsed = v.key.trim() ? parseSshKey(v.key) : null;
      if (v.key.trim() && !parsed) throw new Error("That doesn't look like an SSH public key (ssh-ed25519 AAAA… comment)");
      if (!v.p1 && !parsed) throw new Error("Give a password, an SSH key, or both");
      if (v.p1 || v.p2) checkPassword(v.p1, v.p2);
      const base = [...USERS, name];
      const cmds = [];
      if (v.fullName.trim()) cmds.push({ op: "set", path: [...base, "full-name"], value: v.fullName.trim() });
      if (v.p1) cmds.push({ op: "set", path: [...base, "authentication", "plaintext-password"], value: v.p1 });
      if (parsed) cmds.push(...keyCommands(name, parsed, keyName(parsed.comment, [])));
      await applyChanges(cmds, `user ${name}`);
      load();
      return true;
    }, { okLabel: "Create", intro: "New users have full admin rights (VyOS default). The password is sent over the pinned HTTPS connection and hashed by the router." });
  }

  async function removeUser(r) {
    if (r.name === me()) return alertBox("Remove user", `You are logged in as ${r.name}. Removing it would lock this app out. Log in as another admin first.`);
    if (Object.keys(users).length <= 1) return alertBox("Remove user", "This is the only user; removing it would lock everyone out.");
    if (!(await confirmBox("Remove user", `Delete user ${r.name}? They will no longer be able to log in.`, "Remove"))) return;
    try {
      await applyChanges([{ op: "delete", path: [...USERS, r.name] }], `remove user ${r.name}`);
    } catch (e) {
      alertBox("Apply failed", errorText(e));
    }
    load();
  }

  async function changePassword(r) {
    await formDialog(`Password for ${r.name}`, [
      { name: "p1", label: "New password", type: "password" },
      { name: "p2", label: "Repeat password", type: "password" },
    ], async (v) => {
      checkPassword(v.p1, v.p2);
      await applyChanges([{ op: "set", path: [...USERS, r.name, "authentication", "plaintext-password"], value: v.p1 }], `password ${r.name}`);
      if (r.name === me()) setStatus("Password changed. Update the saved password next time you connect.");
      load();
      return true;
    }, { okLabel: "Apply" });
  }

  async function addKey(r) {
    await formDialog(`Add SSH key for ${r.name}`, [
      { name: "key", label: "Public key", type: "textarea", rows: 4, placeholder: "ssh-ed25519 AAAA... you@laptop  (contents of ~/.ssh/id_ed25519.pub)" },
    ], async (v) => {
      const parsed = parseSshKey(v.key);
      if (!parsed) throw new Error("That doesn't look like an SSH public key (ssh-ed25519 AAAA… comment)");
      await applyChanges(keyCommands(r.name, parsed, keyName(parsed.comment, r.keyNames)), `SSH key for ${r.name}`);
      load();
      return true;
    }, { okLabel: "Add" });
  }

  async function removeKey(r) {
    if (!r.keyNames.length) return setStatus(`${r.name} has no SSH keys.`, true);
    await formDialog(`Remove SSH key from ${r.name}`, [
      { name: "key", label: "Key", type: "select", options: r.keyNames, value: r.keyNames[0] },
    ], async (v) => {
      await applyChanges([{ op: "delete", path: [...USERS, r.name, "authentication", "public-keys", v.key] }], `remove key ${v.key}`);
      load();
      return true;
    }, { okLabel: "Remove" });
  }

  load();
}
