// Claude setup (web version): builds a small Node.js script that connects
// Claude Code and/or Claude Desktop to VyGi's MCP endpoint on the user's
// computer: saves VyGi's certificate, checks the connection, adds VyGi to the
// apps' settings, then deletes itself (it holds the token). Pure: no API calls.

// mcp-remote turns Claude's local (stdio) connection into HTTPS to VyGi and
// trusts VyGi's certificate through NODE_EXTRA_CA_CERTS. Pinned version.
export const MCP_REMOTE = "mcp-remote@0.14.3";

/** Whether `host` (from the address bar) is covered by the certificate's names. */
export function certCovers(names, host) {
  if (!names?.length) return true; // your own certificate: can't tell, assume yes
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return names.some((n) => n.toLowerCase() === h);
}

/**
 * The script's text. url: VyGi's MCP address (https://…/mcp); token: the API
 * token; cert: VyGi's certificate (PEM) or "" when it has a trusted one;
 * apps: { code, desktop }.
 */
export function setupScript({ url, token, cert, apps }) {
  const settings = JSON.stringify({ url, token, cert, code: !!apps.code, desktop: !!apps.desktop, pkg: MCP_REMOTE });
  return `// VyGi: connect Claude to your routers. Run it once with:  node ${"vygi-claude-setup.mjs"}
// It holds an API token, so it deletes itself when it's done.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { execFileSync } from "node:child_process";

const S = ${settings};
const win = process.platform === "win32";
const say = (m) => console.log(m);
const fail = (m) => {
  console.log("\\n✗ " + m + "\\n");
  process.exit(1);
};

// 1. VyGi's certificate (it makes its own, so Claude has to be told to trust it)
const dir = path.join(os.homedir(), ".vygi");
const certFile = path.join(dir, "vygi-cert.pem");
if (S.cert) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(certFile, S.cert);
  say("✓ Saved VyGi's certificate to " + certFile);
}

// 2. Can this computer reach VyGi, with this token?
function check() {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "vygi-setup", version: "1" } } });
  return new Promise((resolve) => {
    const req = https.request(S.url, {
      method: "POST",
      ca: S.cert || undefined,
      timeout: 15000,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + S.token },
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 ? null
        : res.statusCode === 401 || res.statusCode === 403 ? "VyGi refused the token (revoked or expired?). Make a new one in VyGi and download the setup file again."
        : "VyGi answered with HTTP " + res.statusCode + ".");
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", (e) => {
      const host = new URL(S.url).host;
      resolve(/ALTNAME|Hostname\\/IP does not match/i.test(e.code + e.message)
        ? "VyGi's certificate doesn't cover " + new URL(S.url).hostname + ". Add it to VYGI_HOSTNAMES in VyGi's Docker setup, restart VyGi, then download the setup file again."
        : /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(e.code + e.message)
        ? "This computer doesn't trust VyGi's certificate (" + e.code + "). Download the setup file again from VyGi (the certificate may have changed)."
        : /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/.test(e.code)
        ? "Can't reach VyGi at " + host + " (" + e.code + "). Is this computer on your home network (or its VPN), and is VyGi running?"
        : "Couldn't connect to VyGi: " + e.message);
    });
    req.end(body);
  });
}
say("… Checking the connection to VyGi");
const problem = await check();
if (problem) fail(problem);
say("✓ VyGi answers and accepts the token");

// 3. Add VyGi to the Claude apps
// the bare token (VyGi accepts it without "Bearer "): no spaces or placeholders to mangle
const env = S.cert ? { NODE_EXTRA_CA_CERTS: certFile } : {};
const args = ["-y", S.pkg, S.url, "--transport", "http-only", "--header", "Authorization:" + S.token];
const done = [];

function writeJson(file, update) {
  let cfg = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    try {
      cfg = text.trim() ? JSON.parse(text) : {};
    } catch {
      fail(file + " isn't valid JSON, so it wasn't changed. Fix or remove it and run this again.");
    }
    fs.copyFileSync(file, file + ".before-vygi");
  }
  update(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}

if (S.desktop) {
  const file = win ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
    : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
  writeJson(file, (cfg) => {
    cfg.mcpServers = { ...(cfg.mcpServers || {}), vygi: { command: "npx", args, env } };
  });
  say("✓ Added VyGi to Claude Desktop (" + file + ")");
  done.push("Claude Desktop: quit it completely (also from the tray / menu bar) and open it again.");
}

if (S.code) {
  const server = win ? { type: "stdio", command: "cmd", args: ["/c", "npx", ...args], env } : { type: "stdio", command: "npx", args, env };
  let viaCli = false;
  for (const bin of win ? ["claude.exe", "claude"] : ["claude"]) {
    try {
      try {
        execFileSync(bin, ["mcp", "remove", "vygi", "--scope", "user"], { stdio: "ignore" });
      } catch {
        /* wasn't there */
      }
      execFileSync(bin, ["mcp", "add-json", "vygi", JSON.stringify(server), "--scope", "user"], { stdio: "ignore" });
      viaCli = true;
      break;
    } catch {
      /* try the next way */
    }
  }
  if (!viaCli) {
    // Claude Code keeps its user-wide MCP servers in ~/.claude.json
    writeJson(path.join(os.homedir(), ".claude.json"), (cfg) => {
      cfg.mcpServers = { ...(cfg.mcpServers || {}), vygi: server };
    });
  }
  say("✓ Added VyGi to Claude Code (for all your projects)");
  done.push("Claude Code: start a new session (run claude again). /mcp shows VyGi.");
}

// 4. Check npx is there (Claude starts VyGi's connection with it)
try {
  execFileSync(win ? "npx.cmd" : "npx", ["--version"], { stdio: "ignore", shell: win });
} catch {
  say("! npx wasn't found. It comes with Node.js: reinstall Node.js from https://nodejs.org (LTS) if Claude can't start VyGi.");
}

try {
  fs.rmSync(process.argv[1]);
  say("✓ Deleted this setup file (it held the token)");
} catch {
  say("! Delete this setup file now: it holds the token.");
}
say("\\nDone. Next:\\n  - " + done.join("\\n  - ") + "\\nThen ask Claude: \\"list my routers\\".\\n");
`;
}
