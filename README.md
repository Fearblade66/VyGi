# VyGi

A Winbox-style desktop app for managing [VyOS](https://vyos.io) routers. It runs on Windows, macOS and Linux and is built with Tauri (a Rust backend with a web UI).

It talks to the router in two ways:

- **HTTPS REST API**: reads and changes the configuration, commits (including Safe Mode), saves, and runs `show` commands.
- **SSH**: the terminal, live interface traffic, routes, WireGuard peers, the log stream, ping, traceroute and packet capture.

Targets current VyOS (1.5 / rolling). The API calls were checked against `vyos-1x/src/services/api/rest/routers.py`.

## Two ways to work

- **Dashboard and Clients** (UniFi-style). The **Dashboard** shows internet status and latency, a live WAN traffic graph, CPU and memory, clients online, networks with DHCP pool use, the most active clients, VPN devices and alerts. **Clients** lists every device the router knows about (from ARP, DHCP, fixed IPs, local DNS names and WireGuard). Click a device for details and to **Rename** it, give it a **Fixed IP**, **Limit speed**, **Block** it from the internet, or **Ping** it.
  - **Per-device speeds**: live download/upload per device (Clients and the Dashboard). This needs per-connection traffic counting, which VyOS leaves off; Clients has a one-click **Turn on traffic counting** (sets `system sysctl parameter net.netfilter.nf_conntrack_acct value 1`).
  - **Sites**: where each device's traffic goes, with site icons, the network owner and the country, UniFi-style. The Dashboard shows **Top sites now** and **Traffic by country**. Site names (e.g. YouTube, github.com) come from Technitium's query log. Without it, traffic is grouped by network owner (e.g. Google, Fastly). Countries and owners come from DB-IP Lite (IP data by DB-IP, db-ip.com, CC BY 4.0), downloaded once (about 18 MB) and looked up locally. Icons are downloaded from each site itself and cached; they can be turned off in Clients.
- **Windows** (Winbox-style): every feature as a draggable window, opened from the menu on the left.

Switch with the **Dashboard / Clients / Windows** buttons in the toolbar. **+ Window** opens another app window, so you can manage several routers at once (like several Winbox sessions). Each window has its own connection, Safe Mode timer and terminals, and closing a window disconnects its router. The **look** menu next to them picks **Classic** (Winbox gray) or **Modern** (light, dark, or following your OS).

## What it does

| Area | What you get |
|---|---|
| Quick Set | Winbox-style one-page home router setup: internet port (DHCP, static or PPPoE), LAN port(s) (several make a bridge), router address, DHCP server, DNS for devices, NAT, and an optional basic firewall. You see the exact commands before anything is applied. |
| IP → Addresses | Every address on every interface, including ones from DHCP. Add and remove static addresses. |
| IP → ARP / Neighbors | The ARP/NDP table (with static ARP entries), and devices found by **LLDP** (switches, access points, other routers). One click turns LLDP on. |
| IP → Services | SSH, HTTPS API, DNS, DHCP, NTP, LLDP, SNMP, mDNS repeater and more, with on/off, ports and details. You can't switch off the access VyGi itself needs. |
| Firewall → Address Lists, Connections | Address/network/port/MAC groups as editable lists, and the live connection-tracking table with the busiest hosts. |
| System → Resources, Identity & Clock, Images, Reboot / Shut Down | Live CPU and memory graphs, uptime, temperatures and storage. Router name, domain, time zone and NTP servers. Install, set as default and delete VyOS images (VyOS's equivalent of Winbox Packages). Reboot and shut down, with a warning about unsaved or unconfirmed changes. |
| Interfaces → Traffic | A live Rx/Tx graph for one interface. |
| Tools → IP Scan, Profile | Find which addresses in a subnet answer, with MAC addresses and DHCP names. See the router's busiest processes. |
| Interfaces | Live table with flags, type, comment, IPs, MAC, MTU, Tx/Rx rates and a traffic sparkline. You can add VLAN, bridge or dummy interfaces, remove, enable and disable them, and double-click a row to edit it. |
| IP → Routes | The kernel routing table per VRF, for IPv4 or IPv6. You can add and remove static routes. |
| VPN → WireGuard | **Quick Setup** creates a WireGuard server and your first device in one step, optionally opening the firewall port, adding NAT for internet access and DNS for clients. **+ Device** adds more phones and laptops. Each device gets a config file and a **QR code** for the WireGuard app. Keys are generated on your computer, so a device's private key never touches the router. Also shows live peers (handshake age, traffic). |
| VPN → IPsec / OpenVPN | Status. |
| Firewall | Rule table per chain (forward / input / output / custom chains) for IPv4 and IPv6. Add, edit, remove, enable, disable and reorder rules, set the default action (with lock-out warnings), and create custom chains. Groups open in the config editor. |
| NAT | Source NAT (masquerade) and Destination NAT (port forwards) as rule tables with guided forms. |
| IP → DHCP Server | Set up a DHCP server on an interface (pool, gateway, DNS and lease are suggested for you), edit or remove it, see leases, and manage static mappings. **Make Static** turns a lease into a reservation. |
| IP → DNS | The router's own DNS servers, DNS forwarding (the router answers DNS for your network) and static host names. |
| IP → DNS Server (Technitium) | Link a [Technitium DNS Server](https://technitium.com/dns/) to the router (API token, or username/password once to create one). Then:<br>- **Stats**: queries, blocked %, clients, cache hits, failures, a queries/blocked graph and answer types, for the last hour, day, week or month.<br>- **Top clients, top domains, top blocked domains**: block a domain or allow a blocked one with one click.<br>- **Block / Allow lists**: your own always-blocked and never-blocked domains.<br>- **Blocking**: pause for 5 minutes or 1 hour, turn off or on, and flush the cache.<br>- **Query log**: every query, filtered by device, domain or blocked only. Needs Technitium's "Query Logs (Sqlite)" app.<br>- **Use for LAN**: makes the router's DHCP hand out Technitium as the DNS server, so it sees each device.<br>The Dashboard gets a DNS card, and Clients shows each device's DNS queries with a **DNS log** button. |
| System → Users | Router login accounts: add or remove users, change passwords, add or remove SSH keys. Stops you from deleting the account you're logged in with. |
| Check-up on connect | Every time you connect, VyGi:<br>1. **Backs up** the config to your computer if it changed since last time (last 30 versions kept per router).<br>2. Shows **what changed since your last visit**, as `set` lines, including changes made by others or from the CLI. Secrets are masked.<br>3. Runs a **health check**: uptime and recent reboots, load, memory, disk, interfaces that should be up but aren't, errors logged in the last 24 hours, and whether the running config differs from the saved boot config.<br>The window only pops up when there's something to see; otherwise there's a one-line summary in the status bar. Run it any time from System → Check-up. |
| System → Backup / Restore | Save the config to a file on your computer (config.boot or `set` commands), or restore a config.boot backup live, protected by Safe Mode. The **History** tab lists the automatic snapshots, shows what changed in each one, and restores any of them. |
| Protocols, VRF, System, Services | A config tree editor for that section: browse it, set values, delete nodes, and view it as `set` commands. |
| Tools → Torch | Like Winbox Torch: live Tx/Rx rate and packets per second for every conversation on an interface, with totals. Optional tcpdump-style filter; VyGi's own SSH traffic is hidden by default. Also opens from **Interfaces → Torch**. |
| Queues | Like Winbox Simple Queues: a max download and/or upload speed per device (by IPv4 address). Download is shaped on the LAN port (HTB shaper `VYGI-DOWN-<port>`), upload is policed as it arrives (limiter `VYGI-UP-<port>`). VyGi won't touch a port that already has another QoS policy. |
| Tools | Ping, Traceroute, Packet Sniffer (raw tcpdump), IP Scan and Profile. |
| Log | Live system journal with severity and text filters. |
| System → Revisions | Commit history, a colored diff of each commit, and rollback to any revision **without rebooting**. |
| New Terminal | A full SSH terminal (xterm.js). |
| Safe Mode | Every change is applied with VyOS `commit-confirm`. If you don't press **Confirm** in time, the router reverts it, so a change that cuts you off undoes itself. VyOS allows only one pending confirm at a time, so when you make another change while one is pending, VyGi confirms the earlier one first (you're evidently still connected) and starts a new timer. |
| Save | Commits are live but are lost on reboot until you press **Save**. The button turns red while changes are unsaved. |

### Security

- **HTTPS certificate pinning.** VyOS uses a self-signed certificate. On the first connection the app shows its SHA-256 fingerprint and asks you to trust it. If the certificate changes later, you get a loud warning. TLS verification is never switched off.
- **SSH host key pinning** works the same way.
- **Secrets stay in the OS keychain.** The API key and SSH password go to the Windows Credential Manager, macOS Keychain or GNOME Keyring/KWallet. `routers.json` holds only host, ports, user and fingerprints.
- **Local backups contain secrets** (WireGuard keys, password hashes, API keys), just like any VyOS config backup. On macOS and Linux they are created readable only by your user account. Keep the computer secure.
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

## Testing against a real VyOS router

`e2e/` contains everything to test VyGi against a real VyOS router running in Docker, built from the official rolling ISO:

```
e2e/vyos-image/build-image.sh     # download the ISO, build the vyos:test image
e2e/vyos-image/run-router.sh      # start it with 4 ports and a LAN client
npx tauri build --debug --no-bundle
cd e2e && node smoke.mjs ../src-tauri/target/debug/vygi .
```

`smoke.mjs` drives the real app through `tauri-driver` (WebDriver; needs `webkit2gtk-driver`, `cargo install tauri-driver`, and a display or `Xvfb`). It connects, opens the Dashboard, Clients and every window, and fails on any error. Docker containers have no kernel modules and often no IPv6, so WireGuard interfaces, time zones, and firewall changes combined with NAT can't be applied there. Everything else can.

Testing on the real router found and fixed several things mocks didn't show: VyOS wraps list and value nodes in their own name in `/retrieve`, only one commit-confirm can be pending, the DHCP lease JSON output crashes on this VyOS build (VyGi falls back to the table), and the correct OpenVPN status command.

## Limitations

- Torch rates come from tcpdump with a 96-byte snapshot. On a very busy link (hundreds of Mbit/s) tcpdump itself costs CPU on the router and may drop packets, so rates read low.
- Firewall and NAT forms cover the common fields (addresses, ports, interfaces, state, groups). Other options (rate limits, TCP flags, etc.) are kept when you edit a rule but are only editable in the config tree.
- Routing protocols, IPsec/OpenVPN setup and most system settings use the generic config tree editor, not purpose-built forms.
- The forms target VyOS 1.5 config paths (e.g. DHCP `subnet-id` and `option …`). VyOS 1.4 is not supported by those forms.
- Backup restore only accepts config.boot-format files, not `set` command exports.
- Clients only shows what the router can see (ARP, DHCP, WireGuard). Per-client traffic needs connection accounting, which VyOS leaves off, so Activity counts open connections instead.
- Blocking a client drops its forwarded traffic by MAC address (IPv4 forward chain). Devices with private, changing MAC addresses can get around it.
- Simple Queues limit IPv4 only, and match the device's IP address, so give it a fixed IP. The download shaper assumes a 1 Gbit/s LAN port as its total. Upload limiting drops packets above the limit (policing) instead of queueing them, so TCP uploads can look bursty. The queues were checked against VyOS's config validation in the test container, but that container's kernel can't run the actual traffic control, so the real speed limiting has not been measured yet.
- Sites only cover connections open right now (the app isn't always running, so there's no history). CDNs can make a site show up under the CDN's name when no Technitium query log is available.
- Technitium: the query log was written to Technitium's API documentation but not tested, because the test setup couldn't download the query-log app. Everything else was tested against Technitium 15.6. Devices only show up by name in Technitium if they query it directly (use **Use for LAN**). If they go through the router's DNS forwarding, Technitium only sees the router.
- Log, Torch, Packet Sniffer and DHCP Leases use `sudo` over SSH. That works by default for VyOS admin users.

## Project layout

```
index.html, src/              UI (plain JavaScript + Vite)
  main.js                     menu and app startup
  lib/                        windows (mdi.js), tables, dialogs, charts, session/Safe Mode,
                              rules.js (shared firewall/NAT rule editor),
                              netdata.js (client list), views.js (views and themes)
  components/                 one file per window
src-tauri/src/                Rust backend
  vyos_api.rs                 HTTPS API client
  tls.rs                      certificate pinning
  ssh.rs                      SSH terminal / commands / streams, host-key pinning
  connection.rs               connect/disconnect, saved routers
  transactions.rs             commit, Safe Mode confirm, save, revisions, rollback
  monitor.rs                  live stats, routes, WireGuard, log/ping/capture streams
  torch.rs                    Torch: per-flow rates from tcpdump
  technitium.rs               Technitium DNS Server API client (allow-listed calls)
  geoip.rs                    DB-IP Lite country/ASN download and lookups
  siteicons.rs                site icon fetching and cache
  sysinfo.rs                  resources, neighbors, LLDP, connections, IP scan, processes, images, DHCP leases
  backup.rs                   config export/import
  wireguard.rs                WireGuard key generation (local)
  checkup.rs                  connect check-up: snapshots, changes, health
  security.rs                 OS keychain + routers.json (Technitium links: dns-servers.json)
  state.rs                    per-window connection state
  error.rs
e2e/                          end-to-end tests against a real VyOS router in Docker
```

Run the backend tests with `cd src-tauri && cargo test`, and the UI logic tests with `npm test`.

## Credits and license

Licensed under the GNU GPL v3 (see `LICENSE`).

The Dashboard and Clients views take their layout ideas from Ubiquiti's UniFi Network app; Quick Set, IP Services, Address Lists, IP Scan and Profile follow MikroTik Winbox. No code or assets come from either.

Several features were designed after [VyManager](https://github.com/Community-VyProjects/VyManager) (GPLv3): the WireGuard Quick Setup flow and client config, the VyOS 1.5 DHCP option layout, and DNS forwarding paths. VyGi re-implements them in its own code and checks them against the vyos-1x interface definitions.
