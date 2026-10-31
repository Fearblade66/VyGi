# Claude (AI)

[← Documentation](../README.md#documentation)

Claude can use VyGi to check your setup, explain problems ("why was the internet slow last night?") and make changes for you.

## Connect Claude (web version)

System → VyGi → **Connect Claude…**:

1. Choose Claude Code, Claude Desktop or both, what Claude may do (read-only is the default), and when its access ends.
2. VyGi downloads a setup file. Run it once on the computer where you use Claude:
   ```
   node vygi-claude-setup.mjs
   ```
   (needs [Node.js](https://nodejs.org) 18 or newer).
3. It saves VyGi's certificate in `~/.vygi/`, checks it can reach VyGi (and says exactly what to fix if not), adds VyGi to Claude Code and/or Claude Desktop (keeping a `.before-vygi` copy of the config), then deletes itself, because it holds the token.

If the address you opened VyGi with isn't in its certificate, the setup tells you the `VYGI_HOSTNAMES` line to add first.

### By hand

Account menu → **API tokens and Claude** → **New token**. A **full** token reads and changes settings; a **read-only** one only reads. VyGi shows the token once, with setup lines for Claude Code:

```
claude mcp add --transport http vygi https://<vygi>:8443/mcp --header "Authorization: Bearer <token>"
```

and for Claude Desktop. Because VyGi's certificate is its own, start Claude with `NODE_EXTRA_CA_CERTS=<the certificate file>`.

## What Claude can do

- List routers; read status, devices, the configuration (passwords, keys and secrets removed), Intrusion Prevention alerts and the 24/7 history (alerts, traffic, data per device, connections, logs); run `show` commands and ping.
- **Change settings, always through Safe Mode**: changes undo themselves after a few minutes unless Claude calls `confirm_changes` after checking the router still works (it then also saves them).

What it can't do:

- change the routers' logins, the HTTPS API or Safe Mode settings;
- touch settings that run commands as root or copy the configuration elsewhere (task scheduler, event handler, config sync, containers);
- delete whole sections;
- run `show` commands that print secrets.

## Tokens

- Claude's tokens last 4 hours by default (1 hour to 30 days). An ended token keeps its setup: **Allow for 4 hours** in the token list turns it back on, so Claude only gets in when you open a window for it.
- Tokens are stored only as fingerprints, can be revoked at any time (which also closes their router connections), and only work from programs, not from web pages.
- Everything a token does is in the activity log.

## Without the web version

Advanced → System → **Diagnostics Report** makes a Markdown file describing the router (health, interfaces, networks, rules, forwards, security findings, recent alerts, and the configuration with secrets removed). Attach it in a chat with Claude.
