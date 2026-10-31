# Security

[← Documentation](../README.md#documentation)

How VyGi protects your routers, and what to keep in mind.

## Talking to the router

- VyGi uses VyOS's **HTTPS API** for settings (reading, changing, Safe Mode, saving, `show` commands) and **SSH** for the rest (terminal, live traffic, logs, ping, packet capture).
- **Certificates and host keys are pinned.** VyOS uses a self-signed certificate. The first connection shows its fingerprint and the SSH host key's, and asks you to trust them. If either changes later, you get a loud warning. Certificate checks are never switched off.
- **VyGi's own login**: the setup checklist can create a router login `vygi` with an Ed25519 SSH key that only VyGi keeps (no password anyone knows). Your own password then isn't stored in VyGi, the router's history shows what VyGi changed, and you can shut VyGi out without touching your login. Every VyOS login can change everything, so this keeps things separate; it doesn't limit VyGi.
- Interface names are checked and command arguments are quoted, so nothing typed in VyGi can run extra commands on the router.

## Where secrets are kept

- **Desktop app**: the API key and password go to the system keychain (Windows Credential Manager, macOS Keychain, GNOME Keyring or KWallet). Without a working keychain they go to `secrets.json` in VyGi's folder, readable only by your account but not encrypted, and VyGi tells you so.
- **Web server**: in the data volume, in a file only the container's user can read.
- **Backups and VPN configs hold secrets** (keys, password hashes), like any VyOS backup. They're readable only by your account or the container's user. Keep the computer or volume private.

## The web server

- Whoever can log in to VyGi controls your routers. Use a long password and keep port 8443 inside your home network; from outside, use your WireGuard VPN.
- Logins are limited (10 wrong passwords per address per 5 minutes, 50 overall), last 30 days, and are stored only as hashes.
- The activity log records logins, token use and every change, with who and from where.
- Alerts tell you about lockouts, logins from new addresses, new API tokens, logins to the router, and settings changed outside VyGi.

## Claude and API tokens

- Tokens are stored only as fingerprints, expire (Claude's after 4 hours by default), and can be revoked at any time.
- Changes through the API always go through Safe Mode. Logins, the API, Safe Mode settings and anything that runs commands as root can't be changed that way. Secrets are removed from what Claude reads. See [Claude](claude.md).

## Recommended on the router

The Health Check checks these and offers fixes:

- install VyOS to disk, and use a release (VyOS Stream) rather than a nightly build;
- change the "vyos" password;
- block new connections from the internet to the router;
- limit the HTTPS API to your own networks, with a long key;
- turn on SSH guessing protection;
- make Safe Mode reload instead of restart.

## Pen testing

Test from a machine on another network (or over the VPN) against the router's internet side and your networks. Run the Health Check before and after, and watch the activity log and alerts while you test.
