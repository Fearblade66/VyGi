// Connects the real app to the test router and opens every page and window,
// reporting each one's contents, any error in the status bar, and any
// uncaught script error (e.g. a broken refresh timer).
// Usage: node smoke.mjs <app-binary> <screenshot-dir> [router-ip]
import { session, H, F, connect, setHelpers } from "./wd.mjs";
const [app = "../src-tauri/target/debug/vygi", out = ".", router = "172.17.0.2"] = process.argv.slice(2);
setHelpers("");
const s = await session((await import("path")).resolve(app));
const log = (...a) => console.log(...a);
const js = (code, ...a) => s.js(`${H}${F}${code}`, ...a);
let failures = 0;
try {
  // Collect uncaught errors from the start (timers and promises included).
  await s.js(`window.__smokeErrors = []; window.addEventListener('error', (e) => __smokeErrors.push(String(e.message))); window.addEventListener('unhandledrejection', (e) => __smokeErrors.push(String(e.reason?.message || e.reason))); return true;`);
  await connect(s, log, router);
  setHelpers(H + F);
  log("connected:", await js(`return status()`));
  await js(`[...document.querySelectorAll('.mdi-win .mdi-title button[title=Close]')].forEach(b => b.click()); return true;`);
  for (const v of ["dashboard", "clients", "networks", "rules"]) {
    await js(`document.querySelector('#view-switch button[data-view="${v}"]').click(); return true;`);
    await s.sleep(6000);
    await s.shot(`${out}/view-${v}.png`);
    log(`[${v}]`, (await js(`return document.getElementById('${v}').innerText.replace(/\\s+/g, ' ').slice(0, 200)`)));
  }
  const windows = [
    ["Quick Set"], ["Interfaces"], ["Addresses", "IP"], ["Routes", "IP"], ["ARP / Neighbors", "IP"], ["DHCP Server", "IP"],
    ["DHCP Leases", "IP"], ["DNS", "IP"], ["DNS Server (Technitium)", "IP"], ["Dynamic DNS", "IP"], ["Services", "IP"], ["Filter Rules", "Firewall"], ["NAT", "Firewall"],
    ["Address Lists", "Firewall"], ["Connections", "Firewall"], ["VPN"], ["Log"], ["Resources", "System"], ["Users", "System"],
    ["Images (Upgrade)", "System"], ["Revisions / Rollback", "System"], ["Backup / Restore", "System"], ["IP Scan", "Tools"],
    ["Profile", "Tools"], ["Torch", "Tools"], ["Packet Sniffer", "Tools"], ["Queues"], ["Routing Protocols"], ["New Terminal"],
  ];
  for (const [label, parent] of windows) {
    await js(`document.getElementById('status-text').textContent=''; document.getElementById('statusbar').classList.remove('error'); menu(arguments[0], arguments[1]); return true;`, label, parent || null);
    await s.sleep(label === "New Terminal" || label === "Log" ? 3000 : 2000);
    const err = await js(`return document.getElementById('statusbar').classList.contains('error') ? status() : ''`);
    const body = await js(`const w = document.querySelector('.mdi-win.active'); return w ? w.querySelector('.mdi-body').innerText.replace(/\\s+/g,' ').slice(0, 160) : ''`);
    if (err) failures++;
    log(`${err ? "FAIL" : "ok  "} [${label}] ${err || body}`);
    if (await js(`return !!dlg()`)) await js(`dlg().querySelector('.dialog-buttons button').click(); return true;`);
  }
  await s.sleep(5000); // let the open windows' refresh timers run
  const scriptErrors = [...new Set(await js(`return window.__smokeErrors`))];
  for (const e of scriptErrors) {
    failures++;
    log(`FAIL [script error] ${e}`);
  }
} catch (e) {
  failures++;
  log("ERROR:", e.message);
  await s.shot(`${out}/smoke-error.png`).catch(() => {});
} finally {
  await s.close().catch(() => {});
}
log(failures ? `${failures} failure(s)` : "all windows opened without errors");
process.exit(failures ? 1 : 0);
