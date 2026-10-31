# Getting started

[← Documentation](../README.md#documentation)

## 1. Choose how to run VyGi

| | Web server (Docker) | Desktop app |
|---|---|---|
| Use it from | any browser, the Android app | one computer |
| Watches the router 24/7, alerts to your phone | yes | only while it's open |
| Keeps backups and history | on the server, all the time | on the computer, when you connect |

The web server is the recommended way. Run it on something that's always on: a NAS, a mini PC, a home server, or a Raspberry Pi 4/5 with a 64-bit OS.

### Web server (Docker)

Copy [docker-compose.yml](../docker-compose.yml) to that machine, then:

```
docker compose up -d
docker compose logs vygi
```

The log shows a web password on first start. Open `https://<that machine>:8443`. Your browser warns about the certificate once, because VyGi makes its own. Accept it, then log in.

You can choose the password yourself instead: put `VYGI_PASSWORD=<at least 10 characters>` in the compose file or in an env file. All settings are in [Web server and phone app](web-server.md).

To update:
```
docker compose pull vygi && docker compose up -d vygi
```

### Desktop app

Open this repository's **Actions** tab on GitHub, pick the latest successful **Build** run, and download the installer for your system under *Artifacts*:

- Windows: `.msi` or `.exe`
- macOS: `.dmg`
- Linux: `.deb`, `.rpm` or `.AppImage`

The builds aren't code-signed, so Windows SmartScreen and macOS Gatekeeper warn you. On macOS, right-click the app and choose Open.

## 2. Prepare the router

VyGi needs VyOS installed, an address it can reach, and SSH turned on. Until a router is saved, VyGi's welcome page walks you through this and writes out the commands for the address you choose, with a Copy button.

In short, on the router's console:

1. **Install VyOS** to disk with `install image`, then remove the installer ISO or USB stick. A router running from the installer forgets everything when it restarts.
2. **Give it an address and turn on SSH**, for example:
   ```
   configure
   set interfaces ethernet eth0 address 192.168.1.2/24
   set protocols static route 0.0.0.0/0 next-hop 192.168.1.1
   set system name-server 192.168.1.1
   set service ssh
   commit
   save
   exit
   ```
   Use a fixed address, not DHCP: if the address changes, VyGi can't find the router.

That's enough. When VyGi connects without an API key, it logs in over SSH, turns on VyOS's HTTPS API with a new random key, saves it, and remembers the key.

<details>
<summary>Doing the API part by hand instead</summary>

```
configure
set service https api keys id vygi key 'A-LONG-RANDOM-STRING'
set service https api rest
set system config-management commit-confirm action reload
commit
save
exit
```

`openssl rand -hex 32` makes a good key. The `commit-confirm action reload` line makes Safe Mode undo a change by reloading the old settings instead of restarting the router. VyGi offers to set it if it's missing.
</details>

## 3. Connect

1. Click **Connect to a router** (or the router card at the top of the sidebar, then **+ Add router**).
2. Enter the router's address, login (usually `vyos`) and password. Name, API key and ports are under **More options**.
3. VyGi shows the router's SSH key and HTTPS certificate fingerprints. Check them against the router before you click **Trust**:
   - SSH key: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
   - HTTPS certificate: `show pki certificate`

   VyGi remembers them and warns you loudly if they ever change.

## 4. Set it up

The first time you connect, **Set up this router** opens: a checklist of the basics, each with a button that fixes it.

- **Make it a router** (at the top of the checklist when the internet or a home network is missing): one form for the internet port and how it connects (DHCP, PPPoE or a fixed address), the home network and its address range. It sets up DHCP, DNS, NAT and a basic firewall in one change. See [A tour of VyGi](using-vygi.md#make-it-a-router).
- **Router address**: makes a DHCP address fixed, so VyGi keeps finding the router.
- **VyGi's own login**: creates the router login `vygi` with an SSH key only VyGi keeps, so VyGi doesn't use your password and the router's history shows what VyGi changed.
- **Router password**: changes the factory password.
- **Security check, saving automatically, backups and alerts, time zone.**

You can open the checklist again from System → Router, or by typing "setup" in the search bar.

## 5. Day to day

- Leave **Safe Mode** on (top bar). After a change, VyGi waits for you to **Confirm** that you still have access. If you don't, the router undoes the change after the countdown. See [Safety net](safety.md).
- **Save changes automatically** is on by default, so confirmed changes survive a restart. Without it, press **Save**.
- **Ctrl+K** (or the search icon) finds any page, device or setting, and does things: "add port forward", "save", "switch to …".
