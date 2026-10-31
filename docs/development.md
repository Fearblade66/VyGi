# Development

[← Documentation](../README.md#documentation)

VyGi is a [Tauri](https://tauri.app) app: a Rust backend with a plain JavaScript UI (Vite, no framework). The same backend builds as the desktop app or, with `--features server`, as the web server.

## Building

Install [Rust](https://rustup.rs), [Node.js 20+](https://nodejs.org) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your system. On Debian/Ubuntu:
```
sudo apt install libwebkit2gtk-4.1-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev build-essential
```

Desktop app:
```
npm install
npm run tauri dev       # run in development mode
npm run tauri build     # installers in src-tauri/target/release/bundle/
```

Web server from a checkout:
```
npm run build
cd src-tauri
VYGI_DATA=./webdata VYGI_WEB=../dist cargo run --no-default-features --features server --bin vygi-server
```

Docker image: `docker build -t vygi .`

Android app: `cd android && gradle assembleRelease` (Android SDK platform 35, JDK 17).

## Tests

```
npm test                                                   # UI logic (node --test)
cd src-tauri && cargo test                                 # desktop backend
cargo clippy --no-default-features --features server --all-targets -- -D warnings
cargo test --no-default-features --features server         # web server
```

CI (`.github/workflows/build.yml`) runs all of these, a real VyOS router in a container (the newest and an older build) that commits what VyGi generates, the installers for Windows, macOS and Linux, the Android app, and the Docker image.

### Against a real router

`e2e/` builds a VyOS router in Docker from the official ISO and drives the real app against it:

```
e2e/vyos-image/build-image.sh     # download the ISO, build the vyos:test image
e2e/vyos-image/run-router.sh      # start it with 4 ports and a LAN client
npx tauri build --debug --no-bundle
cd e2e && node smoke.mjs ../src-tauri/target/debug/vygi .
```

`smoke.mjs` uses `tauri-driver` (needs `webkit2gtk-driver`, `cargo install tauri-driver`, and a display or Xvfb). It connects, opens every page and window, and fails on any error. Containers have no kernel modules and often no IPv6, so WireGuard, VLANs, traffic shaping and time zones can't all be applied there; see [Limitations](limitations.md#not-yet-tested-end-to-end).

## Project layout

```
index.html, src/           the UI
  main.js                  startup and the Advanced menu
  lib/                     shared code; the pure logic (tested by npm test):
                             netplan.js (networks), trafficrules.js, portfwd.js, policies.js,
                             wanconf.js (internet), makerouter.js, secure.js and doctor.js
                             (Health Check, conflict and lockout checks), describe.js
                             (plain-language previews), vyoserrors.js, searchindex.js, …
                           and the app's frame: views.js (pages and menu), session.js
                             (connection, Safe Mode), mdi.js (windows), phone.js, dialogs, charts
  components/              one file per page, window or dialog
src-tauri/src/             Rust backend
  vyos_api.rs              HTTPS API client          tls.rs        certificate pinning
  ssh.rs                   SSH, host-key pinning     connection.rs connect, saved routers
  transactions.rs          commits, Safe Mode, save, revisions, rollback
  monitor.rs, sysinfo.rs   live data, streams, DHCP leases, connections…
  checkup.rs               the connect check-up      backup.rs     export and restore
  security.rs              keychain and routers.json wireguard.rs  keys, VPN configs
  server/                  the web server: login, HTTPS, the API, streams, 24/7 watching
                           (watch.rs, alerts.rs, history.rs), API tokens, MCP for Claude,
                           the activity log
android/                   the Android app (a WebView on the VyGi server, no libraries)
e2e/                       tests against a real VyOS router
docs/                      this documentation
```

## Design notes

- **Rollback without restarting**: VyOS's own `rollback N` restarts the router; VyGi loads the old revision through the API instead (`/config-file load`), protected by Safe Mode.
- **Safe Mode** relies on `commit-confirm`, whose default undo is a restart; VyGi offers `reload`.
- **Live interface data** comes from `ip -j` over SSH; the API has no such call. VRF is a config path or command argument, not a request header.
- **No auto-discovery**: VyOS doesn't announce itself, and listening for LLDP needs raw sockets. You enter the address once.
- **Secrets**: the OS keychain already encrypts its contents, so there's no extra layer on top.
- VyOS quirks found on a real router: list and value nodes come back wrapped in their own name from `/retrieve`; only one commit-confirm can be pending; the DHCP lease JSON output crashes on some builds (VyGi falls back to the table).

## Credits

Licensed under the GNU GPL v3 (see [LICENSE](../LICENSE)).

Home and Devices take layout ideas from Ubiquiti's UniFi Network app; IP Services, Address Lists, IP Scan, Profile, Torch and Simple Queues follow MikroTik Winbox. No code or assets come from either.

Several features were designed after [VyManager](https://github.com/Community-VyProjects/VyManager) (GPLv3): the WireGuard Quick Setup flow and client config, the VyOS 1.5 DHCP option layout, and DNS forwarding paths. VyGi re-implements them in its own code and checks them against the vyos-1x interface definitions.

Country and network-owner data: [DB-IP](https://db-ip.com) Lite, CC BY 4.0. Intrusion detection: [Suricata](https://suricata.io) with the Emerging Threats Open rules.
