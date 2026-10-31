// API access (web version): tokens for Claude (MCP) and scripts, with the
// commands to connect Claude Code or Claude Desktop.
import { h, clear, setStatus } from "../lib/dom.js";
import { modal, formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { webTokens, webTokenCreate, webTokenRevoke, webTokenAllow } from "../lib/platform.js";
import { openClaudeSetup } from "./claude_setup.js";

const when = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "never");

function copyBox(text) {
  const area = h("textarea.copy-box", { readOnly: true, rows: Math.min(6, text.split("\n").length + 1), value: text });
  const btn = h("button", { on: { click: async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
    } catch {
      area.select();
      document.execCommand("copy");
    }
  } } }, "Copy");
  return h("div.copy-wrap", area, btn);
}

/** Shows a new token once, with ready-to-paste setup for Claude. */
export async function showNewToken(info, secret) {
  const url = `${location.origin}/mcp`;
  const claudeCode = `claude mcp add --transport http vygi ${url} --header "Authorization: Bearer ${secret}"`;
  const desktop = JSON.stringify({ mcpServers: { vygi: { command: "npx", args: ["-y", "mcp-remote", url, "--header", `Authorization: Bearer ${secret}`] } } }, null, 2);
  const selfSigned = location.protocol === "https:";
  await modal(`Token "${info.name}" (${info.scope === "full" ? "full access" : "read-only"})`, h("div", { style: { width: "620px" } },
    h("div.warn-box", "Copy it now: VyGi only keeps a fingerprint of it and can't show it again. Anyone with it can use VyGi" + (info.scope === "full" ? " and change your routers' settings (through Safe Mode)." : " to read your routers' settings and history.")),
    copyBox(secret),
    h("h4", "Claude Code (on a computer in your home network)"),
    copyBox(claudeCode),
    selfSigned ? h("div.hint", "VyGi uses its own certificate, so tell Claude Code to trust it: download it with the button below, then start Claude Code with NODE_EXTRA_CA_CERTS set to that file, e.g. NODE_EXTRA_CA_CERTS=~/vygi-cert.pem claude") : null,
    selfSigned && !["localhost", "127.0.0.1", "vygi"].includes(location.hostname)
      ? h("div.warn-box", { style: { marginTop: "6px" } }, `The certificate must cover the address in these commands (${location.hostname}): add it to VYGI_HOSTNAMES in your Docker setup (e.g. VYGI_HOSTNAMES=${location.hostname}) and restart VyGi; it remakes its certificate. Download the certificate after that.`)
      : null,
    h("h4", "Claude Desktop (Settings → Developer → Edit config)"),
    copyBox(desktop),
    selfSigned ? h("div.hint", "Claude Desktop needs the certificate trusted too: add \"env\": {\"NODE_EXTRA_CA_CERTS\": \"/path/to/vygi-cert.pem\"} next to \"args\".") : null,
    h("div.hint", { style: { marginTop: "8px" } }, "Then ask Claude things like \"check my router's setup and suggest improvements\" or \"why was the internet slow last night?\". Changes Claude makes use Safe Mode: they undo themselves unless Claude confirms them after checking everything still works.")),
  [
    ...(selfSigned ? [{ label: "Download certificate", value: "cert" }] : []),
    { label: "Done", value: "ok", primary: true },
  ], (v) => {
    if (v === "cert") {
      const a = document.createElement("a");
      a.href = "/api/cert";
      a.download = "vygi-cert.pem";
      a.click();
      return false;
    }
    return true;
  });
}

/** How long a new token works ("4h", "7d", "0" = never): Claude gets a few hours at a time. */
export const LIFETIMES = [
  { value: "1h", label: "1 hour" },
  { value: "4h", label: "4 hours" },
  { value: "12h", label: "12 hours" },
  { value: "1d", label: "1 day" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "0", label: "never (scripts, Home Assistant)" },
];
export const lifetime = (v) => (v.endsWith("h") ? { hours: parseInt(v, 10) } : v.endsWith("d") ? { days: parseInt(v, 10) } : {});

export async function openApiAccess() {
  const list = h("div.token-list");
  async function load() {
    try {
      const tokens = await webTokens();
      clear(list).append(tokens.length
        ? h("table.grid", h("thead", h("tr", h("th", "Name"), h("th", "Access"), h("th", "Made"), h("th", "Last used"), h("th", "Expires"), h("th", ""))),
            h("tbody", tokens.map((t) => h("tr",
              h("td", t.name), h("td", t.scope === "full" ? "full (changes with Safe Mode)" : "read-only"), h("td", when(t.created)), h("td", when(t.lastUsed)),
              h("td", !t.expires ? "never" : t.expires < Date.now() ? h("span.badge.bad", "ended") : `until ${when(t.expires)}`),
              h("td", { style: { whiteSpace: "nowrap" } }, t.expires ? h("button", {
                title: "Let this token work for the next 4 hours (the computer using it keeps its setup)",
                on: { click: async () => {
                  await webTokenAllow(t.id, 4).catch((e) => alertBox("Allow", e.message));
                  load();
                } },
              }, t.expires < Date.now() ? "Allow for 4 hours" : "Extend 4 hours") : null, " ", h("button.danger", { on: { click: async () => {
                if (!(await confirmBox("Revoke token", `Revoke "${t.name}"? Anything using it (Claude, scripts) stops working.`, "Revoke"))) return;
                await webTokenRevoke(t.id).catch((e) => alertBox("Revoke", e.message));
                load();
              } } }, "Revoke"))))))
        : h("div.hint", { style: { padding: "8px 0" } }, "No tokens yet."));
    } catch (e) {
      clear(list).append(h("div.err-box", e.message));
    }
  }
  async function create() {
    let made = null;
    await formDialog("New API token", [
      { name: "name", label: "Name", value: "Claude", placeholder: "e.g. Claude, Home Assistant" },
      { name: "scope", label: "Access", type: "select", value: "full", options: [
        { value: "full", label: "Full: read and change settings (always with Safe Mode)" },
        { value: "read", label: "Read-only: settings, devices, history, logs" },
      ] },
      { name: "life", label: "Works for", type: "select", value: "4h", options: LIFETIMES,
        hint: "Afterwards it stops working on its own; \"Allow for 4 hours\" here turns it back on without a new setup." },
    ], async (v) => {
      made = await webTokenCreate(v.name, v.scope, lifetime(v.life));
      return true;
    }, { okLabel: "Create" });
    if (made) {
      await showNewToken(made.token, made.secret);
      load();
    }
  }
  load();
  await modal("API access", h("div", { style: { width: "640px" } },
    h("div.hint", { style: { marginBottom: "8px" } }, "Tokens let Claude (through MCP) or your own programs use VyGi. Keep VyGi inside your home network: tokens give the same control as your login, except over the routers' logins, their API and Safe Mode."),
    list,
    h("div", { style: { marginTop: "10px", display: "flex", gap: "8px" } },
      h("button.primary", { on: { click: () => openClaudeSetup().then(load) } }, "Connect Claude…"),
      h("button", { on: { click: create } }, "New token (scripts, manual setup)"))),
  [{ label: "Close", value: "ok", primary: true }]);
  setStatus("");
}
