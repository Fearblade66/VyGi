// "Connect Claude" wizard (web version): makes a token and a setup file that
// connects Claude Code / Claude Desktop on the user's computer in one step.
import { h } from "../lib/dom.js";
import { modal, formDialog, alertBox } from "../lib/dialog.js";
import { webTokenCreate } from "../lib/platform.js";
import { setupScript, certCovers } from "../lib/claudesetup.js";
import { showNewToken } from "./apiaccess.js";

const FILE = "vygi-claude-setup.mjs";

function download(text) {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/javascript" })), download: FILE });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

const code = (t) => h("code.copy-line", t);

export async function openClaudeSetup() {
  // The address Claude will use must be one VyGi's certificate covers.
  let info = { tls: location.protocol === "https:", names: [] };
  try {
    info = await (await fetch("/api/cert/names", { credentials: "same-origin" })).json();
  } catch {
    /* assume it's fine; the setup file checks again */
  }
  const host = location.hostname;
  if (info.tls && !certCovers(info.names, host)) {
    return alertBox("Connect Claude",
      `Claude will connect to VyGi at ${host}, but VyGi's certificate only covers ${info.names.join(", ")}, so the connection would be refused.\n\n` +
      `Fix (once): add ${host} to VYGI_HOSTNAMES in VyGi's Docker setup, e.g.\n    VYGI_HOSTNAMES=${host}\nthen run\n    docker compose up -d --force-recreate vygi\n` +
      "VyGi makes a new certificate for it. Reload this page (accept the new certificate warning) and open Connect Claude again.");
  }

  let made = null;
  let apps = null;
  await formDialog("Connect Claude", [
    { name: "app", label: "Claude app", type: "select", value: "code", options: [
      { value: "code", label: "Claude Code (terminal)" },
      { value: "desktop", label: "Claude Desktop (app)" },
      { value: "both", label: "Both" },
    ], hint: "On the computer where you'll use Claude. It must be on your home network (or its VPN)." },
    { name: "scope", label: "Claude may", type: "select", value: "full", options: [
      { value: "full", label: "Read and change settings (changes always use Safe Mode)" },
      { value: "read", label: "Only read: settings, devices, history, logs" },
    ] },
    { name: "days", label: "Access ends", type: "select", value: "90", options: [
      { value: "30", label: "in 30 days" },
      { value: "90", label: "in 90 days" },
      { value: "365", label: "in a year" },
      { value: "0", label: "never" },
    ], hint: "Run the setup again for a new token when it ends." },
  ], async (v) => {
    apps = { code: v.app !== "desktop", desktop: v.app !== "code" };
    const name = v.app === "both" ? "Claude" : v.app === "code" ? "Claude Code" : "Claude Desktop";
    made = await webTokenCreate(name, v.scope, Number(v.days) || null);
    return true;
  }, {
    okLabel: "Make setup file",
    intro: "VyGi makes a small setup file. You run it once on your computer and it does the rest: trusts VyGi's certificate, checks the connection, and adds VyGi to Claude.",
  });
  if (!made) return;

  let cert = "";
  if (info.tls) {
    try {
      cert = await (await fetch("/api/cert", { credentials: "same-origin" })).text();
    } catch (e) {
      return alertBox("Connect Claude", `Couldn't read VyGi's certificate: ${e.message}`);
    }
  }
  const script = setupScript({ url: `${location.origin}/mcp`, token: made.secret, cert, apps });
  download(script);

  const win = /Windows/.test(navigator.userAgent);
  const runCmd = win ? `node $HOME\\Downloads\\${FILE}` : `node ~/Downloads/${FILE}`;
  const next = [apps.desktop ? "quit Claude Desktop completely and open it again" : null, apps.code ? "start a new Claude Code session" : null].filter(Boolean).join(", and ");
  await modal("Connect Claude: run the setup file", h("div.claude-steps", { style: { width: "600px" } },
    h("ol",
      h("li", h("b", "Node.js"), " must be installed on that computer (Claude uses it to reach VyGi). To check, run this in a terminal:", code("node -v"),
        "It should print a version (18 or newer). If not, install the LTS version from ", h("a", { href: "https://nodejs.org", target: "_blank", rel: "noopener" }, "nodejs.org"), "."),
      h("li", `Your browser just downloaded ${FILE}. If you're setting up another computer, copy it there.`),
      h("li", "Open ", h("b", win ? "PowerShell" : "Terminal"), " and run:", code(runCmd),
        h("div.hint", win ? `On a Mac or Linux: node ~/Downloads/${FILE}` : `On Windows (PowerShell): node $HOME\\Downloads\\${FILE}`),
        h("div.hint", "Saved somewhere else? Type node and a space, then drag the file into the window.")),
      h("li", `When it says Done: ${next}. Then ask Claude "list my routers".`)),
    h("div.hint", "The file holds the access token, so it deletes itself when it's done. If something fails it says exactly what to fix; you can run it again. Remove Claude's access any time in API access (Revoke).")),
  [
    { label: "Download again", value: "again", left: true },
    { label: "Set up by hand…", value: "manual", left: true },
    { label: "Done", value: "ok", primary: true },
  ], (v) => {
    if (v === "again") {
      download(script);
      return false;
    }
    if (v === "manual") {
      showNewToken(made.token, made.secret);
      return false;
    }
    return true;
  });
}
