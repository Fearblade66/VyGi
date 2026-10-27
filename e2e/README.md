# End-to-end tests

Runs the real VyGi app against a real VyOS router in Docker.

1. Build the router image (downloads the newest rolling ISO, about 650 MB):
   `vyos-image/build-image.sh`
2. Start the router. It has 4 ports: `eth0` for management, and `eth1`-`eth3` on test networks `10.20.1-3.0/24`, plus an Alpine LAN client on `eth2`'s network:
   `vyos-image/run-router.sh`
3. Build the app: `npx tauri build --debug --no-bundle` (from the repo root).
4. Start a display and the WebDriver bridge:
   ```
   Xvfb :99 -screen 0 1440x900x24 &
   DISPLAY=:99 dbus-run-session -- tauri-driver --port 4444 &
   ```
5. Run the smoke test: `node smoke.mjs ../src-tauri/target/debug/vygi . 172.17.0.2`

Test router credentials: SSH `vyos` / `vyos`, API key `vygi-test-key`.

`wd.mjs` is a tiny WebDriver client with in-page helpers (`menu`, `fill`, `dlgBtn`, ...) to write more flows.

## Does a VyOS version accept what VyGi writes?

`config-check.mjs` builds the settings each simple page makes (networks with DHCP and isolation, a VLAN, device groups, traffic rules with schedules and site lists, a port forward, a network-access policy, mDNS, logging, region blocking, the router's internet protection, Smart Queues, intrusion-detection blocks, a WireGuard VPN client, PPPoE on a VLAN with IPv6 prefix delegation, and removing some of them) with VyGi's own code, commits them to the router one after another and reads them back with VyGi's readers:

```
node config-check.mjs <router IP>
```

Each step starts from the last one that worked (the config is saved after a success and loaded back after a failure). It finds which port is management by its address, so the order Docker hands out ports doesn't matter. The router's kernel needs VLAN, WireGuard and CAKE support (`modprobe -a 8021q wireguard sch_cake pppoe` on the host); `SKIP=vlan,vpn` skips steps a sandbox can't do. CI runs it against the newest VyOS nightly and the one from about 3 months earlier.
