# Web server and phone app

[← Documentation](../README.md#documentation)

The same app runs as a web server in Docker, so you can use it from any browser or the Android app. It can also watch your routers around the clock.

- [Running it](#running-it)
- [Settings](#settings)
- [Logging in](#logging-in)
- [Your data](#your-data)
- [VyGi access: activity log, browsers, tokens](#vygi-access)
- [24/7 watching](#247-watching)
- [Phone notifications](#phone-notifications)
- [Android app](#android-app)

## Running it

```
docker compose up -d          # with docker-compose.yml from this repository
docker compose logs vygi      # first start only: shows the web password
```

Open `https://<that machine>:8443` and accept the certificate warning once. The image is `ghcr.io/fearblade66/vygi:latest`, built from this repository; `docker build -t vygi .` builds it yourself.

To update:
```
docker compose pull vygi && docker compose up -d vygi
```

## Settings

Environment variables, in the compose file or an env file (`env_file: ./vygi.env`):

| Variable | What it does |
|---|---|
| `VYGI_PASSWORD` | The web password, at least 10 characters. Without it, VyGi makes one on first start and prints it in the log. |
| `VYGI_HOSTNAMES` | Extra names or addresses for VyGi's certificate, e.g. `vygi.lan,192.168.1.10`. VyGi remakes its certificate when this changes. |
| `VYGI_TLS=off` | Plain HTTP on port 8080, only behind your own HTTPS reverse proxy. Addresses then come from `X-Forwarded-For`. |
| `VYGI_LISTEN` | Address and port, default `0.0.0.0:8443`. Use `192.168.1.10:8443` to listen on one address only. |
| `VYGI_KEEP_DAYS` | Days of traffic and log history to keep (default 30). |

To use your own certificate, replace `tls/cert.pem` and `tls/key.pem` in the data volume and delete `tls/made-by-vygi-for.txt`, so VyGi leaves them alone.

## Logging in

- A browser stays logged in for 30 days, also across restarts and updates. Logins are stored as hashes that can't be used to log in.
- **Too many wrong passwords**: after 10 from one address in 5 minutes, that address waits 5 minutes (50 from all addresses together locks everyone). `docker restart vygi` clears it right away.
- **Forgot the password?** Set `VYGI_PASSWORD` to a new one and restart the container. This also logs every browser out. While `VYGI_PASSWORD` is set it wins at every start, so a password changed inside VyGi goes back to it; remove the line after logging in if you'd rather change it in VyGi.
- Changing the password inside VyGi (account menu → **Change web password**) logs out every other browser.
- Each browser tab has its own router connection. A tab that's closed, or silent for 10 minutes, is disconnected.

Keep port 8443 inside your home network: whoever logs in to VyGi controls your routers. From outside, come in over your WireGuard VPN, not a port forward.

## Your data

Everything lives in the `/data` volume:

- saved routers, with their passwords and API keys (in a file only the container's user can read; a server has no OS keychain);
- config backups, change history, traffic and log history;
- VPN device configs, Technitium links, GeoIP data, site icons;
- the TLS certificate, the web password hash, logins and API tokens (as hashes);
- the activity log.

Keep the volume private, and back it up if you care about the history.

## VyGi access

System → VyGi:

- **Activity log**: logins (and failed ones, lockouts), password changes, API tokens created, revoked or rejected, and every change made to a router from VyGi or through the API (Claude), with its commands. Also Safe Mode confirms and undos, restores, restarts, VyOS updates and terminal sessions. Each entry has who, when, from which address and on which router. Passwords and keys are hidden. Kept for 12 months, with search.
- **Logged-in browsers**: each one's browser, address, login time and last use, with **Log out**.
- **API tokens**: for Claude and scripts. See [Claude](claude.md).
- **Alerts**: logins locked after wrong passwords, a login from an address not seen before, and a new API token.

## 24/7 watching

In the alerts bell, switch on **Watch this router 24/7 on the VyGi server**. The server then keeps its own connection to that router (reconnecting by itself) and:

- **every minute**, runs the alert checks, even with no VyGi tab open: internet down or back, new devices, Dynamic DNS failures, router restarts, VPN devices, and hosts you asked it to watch (it pings them, like RouterOS Netwatch);
- records internet traffic, data used per device (needs traffic counting: Devices → Turn on traffic counting), connections, and the router's system log;
- **every 6 hours**, backs up the configuration when it changed;
- **once a day**, checks for a new VyOS version.

It also alerts you when:

- **settings change outside VyGi** (the command line, another tool) or Safe Mode undoes a change, with who and what changed;
- **the router comes back different after a restart**: it compares the settings with the newest backup, so a router that lost its settings is noticed;
- **someone logs in to the router**: any SSH or console login that isn't VyGi's own, SSH guessing protection blocking an address, or 5 wrong passwords from one address within 10 minutes;
- **the router can't be reached for 5 minutes**, and again when it's back. Restarts and updates are shorter than that.

The server needs the router's password and API key saved (tick **Remember** when connecting).

## Phone notifications

In the bell, **Phone notifications**:

- **[ntfy](https://ntfy.sh)** (simplest): install the free app, subscribe to a topic with a hard-to-guess name (anyone who knows it can read it), and paste its URL, e.g. `https://ntfy.sh/vygi-6f3a9c2e`. Your own ntfy server works too, with an access token for protected topics.
- **Webhook**: Discord and Slack webhooks get a message; anything else (Home Assistant, n8n…) gets JSON `{title, text, level, kind, at}`.

**Save and test** sends a test message.

## Android app

Included in the Docker image (Android 10 or newer). It's the same VyGi with a phone layout, plus alerts as notifications. It connects to your VyGi server, so it works at home or away over your VPN; router passwords stay on the server.

- **Install**: account menu → **Phone app** shows a QR code for `https://<vygi>:8443/vygi.apk` and the server's certificate fingerprint. Open the link on the phone, install the file (Android asks to allow installs from the browser), open VyGi, enter the server address, check the fingerprint matches, and log in.
- **Notifications**: after login the app makes itself a read-only API token ("Android app (<phone>)", under API tokens) and checks for new alerts every 15 minutes, the shortest Android allows. Reinstalling replaces the old token. For instant alerts, also use ntfy.
- **Updates**: when the server has a newer app (after `docker compose pull`), the app offers to install it.
- **Back** closes the open dialog, menu or page, then leaves the app. Saved files go to **Downloads**. **Change server** is in the menu.
