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
