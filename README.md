# VyGi

A Winbox-style desktop app for managing [VyOS](https://vyos.io) routers. It runs on Windows, macOS and Linux and is built with Tauri (a Rust backend with a web UI).

It talks to the router in two ways:

- **HTTPS REST API**: reads and changes the configuration, commits (including Safe Mode), saves, and runs `show` commands.
- **SSH**: the terminal, live interface traffic, routes, WireGuard peers, the log stream, ping, traceroute and packet capture.

Targets current VyOS (1.5 / rolling). The API calls were checked against `vyos-1x/src/services/api/rest/routers.py`.

## What it does

| Area | What you get |
|---|---|
| Interfaces | Live table with flags, type, comment, IPs, MAC, MTU, Tx/Rx rates and a traffic sparkline. You can add VLAN, bridge or dummy interfaces, remove, enable and disable them, and double-click a row to edit it. |
| IP → Routes | The kernel routing table per VRF, for IPv4 or IPv6. You can add and remove static routes. |
| VPN | WireGuard peers (handshake age, traffic, named from your config). IPsec and OpenVPN status. |
| Firewall, NAT, DHCP, DNS, Protocols, VRF, System, Services | A config tree editor for that section: browse it, set values, delete nodes, and view it as `set` commands. |
| Tools | Ping, Traceroute, and Packet Capture ("Torch", using tcpdump). |
| Log | Live system journal with severity and text filters. |
| System → Revisions | Commit history, a colored diff of each commit, and rollback to any revision **without rebooting**. |
| New Terminal | A full SSH terminal (xterm.js). |
| Safe Mode | Every change is applied with VyOS `commit-confirm`. If you don't press **Confirm** in time, the router reverts it, so a change that cuts you off undoes itself. |
| Save | Commits are live but are lost on reboot until you press **Save**. The button turns red while changes are unsaved. |

### Security

- **HTTPS certificate pinning.** VyOS uses a self-signed certificate. On the first connection the app shows its SHA-256 fingerprint and asks you to trust it. If the certificate changes later, you get a loud warning. TLS verification is never switched off.
- **SSH host key pinning** works the same way.
- **Secrets stay in the OS keychain.** The API key and SSH password go to the Windows Credential Manager, macOS Keychain or GNOME Keyring/KWallet. `routers.json` holds only host, ports, user and fingerprints.
- **No shell injection from the UI.** Interface and VRF names are validated, and capture filters and ping targets are shell-quoted.

## 1. Prepare the router (once)

Log in to the router's console or SSH and run:

```
configure
set service https api keys id vygi key 'PUT-A-LONG-RANDOM-STRING-HERE'
set service https api rest
set service ssh
# Make Safe Mode revert by reloading the old config instead of REBOOTING (VyOS default is reboot):
set system config-management commit-confirm action reload
# Recommended: only allow the API from your admin network
set service https allow-client address 192.168.1.0/24
commit
save
exit
```

To make a random key on Linux or macOS, run `openssl rand -hex 32`.

If you skip the `commit-confirm action reload` line, the app warns you when you connect and offers to set it.

## 2. Get the app

**Easiest:** open the repository's **Actions** tab on GitHub, pick the latest successful **Build** run, and download the installer for your OS from *Artifacts*:

- Windows: `.msi` or `.exe`
- macOS: `.dmg`
- Linux: `.deb`, `.rpm` or `.AppImage`

The builds are not code-signed, so Windows SmartScreen or macOS Gatekeeper will warn you. On macOS, right-click the app → Open.

**Build it yourself:**

1. Install the tools:
   - [Rust](https://rustup.rs)
   - [Node.js 20+](https://nodejs.org)
   - The [Tauri system prerequisites](https://tauri.app/start/prerequisites/) for your OS. On Debian/Ubuntu: `sudo apt install libwebkit2gtk-4.1-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev build-essential`.
2. Build:
   ```
   npm install
   npm run tauri dev     # run it in development mode
   npm run tauri build   # make an installer in src-tauri/target/release/bundle/
   ```

## 3. Use it

1. Click **Connect**. Fill in the router address, login (usually `vyos`), the SSH password and the API key, then click Connect.
2. Compare the fingerprints it shows with the router before you click **Trust**. On the router:
   - SSH key: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
   - HTTPS certificate: `show pki certificate`, or `openssl x509 -noout -fingerprint -sha256 -in <cert file>`
3. Leave **Safe Mode** on while you learn. After each change, press **Confirm (m:ss)** once you've checked you still have access. Then press **Save**.

## How this differs from the original blueprint

The original plan had a few problems:

- **"VRF header context"**: the VyOS API has no such thing. VRF is a config path (`vrf name X ...`) or a command argument. The Routes window has a VRF selector.
- **`show interfaces json` via the API**: not a real call. Live interface data comes from `ip -j` over SSH, and config comes from `/retrieve`.
- **LLDP/mDNS auto-discovery**: dropped. VyOS doesn't advertise itself over mDNS, and listening for LLDP needs root or raw-socket rights on your PC. You enter the router address instead, and it is remembered.
- **Rollback**: VyOS's own `rollback N` reboots the router. This app instead loads the old revision's file through the API (`/config-file load`), live and protected by Safe Mode.
- **Safe Mode**: VyOS's default revert action is a *reboot*. The app detects this and offers to switch it to `reload`.
- **AES-GCM on top of the keychain**: dropped. The OS keychain already encrypts its contents.
- **`russh-keys`**: merged into `russh` upstream.

## Limitations

- Packet Capture shows raw tcpdump lines. It is not Winbox Torch's per-flow rate table.
- The Firewall, NAT, DHCP and other sections use the generic config tree editor, not purpose-built forms.
- You can be connected to one router at a time.
- Log and Packet Capture use `sudo` over SSH. That works by default for VyOS admin users.

## Project layout

```
index.html, src/              UI (plain JavaScript + Vite)
  main.js                     menu and app startup
  lib/                        windows (mdi.js), tables, dialogs, session/Safe Mode
  components/                 one file per window
src-tauri/src/                Rust backend
  vyos_api.rs                 HTTPS API client
  tls.rs                      certificate pinning
  ssh.rs                      SSH terminal / commands / streams, host-key pinning
  connection.rs               connect/disconnect, saved routers
  transactions.rs             commit, Safe Mode confirm, save, revisions, rollback
  monitor.rs                  live stats, routes, WireGuard, log/ping/capture streams
  security.rs                 OS keychain + routers.json
  state.rs, error.rs
```

Run the backend tests with `cd src-tauri && cargo test`.
