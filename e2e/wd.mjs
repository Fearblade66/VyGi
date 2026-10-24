// Minimal WebDriver client for tauri-driver.
const BASE = "http://127.0.0.1:4444";
async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(`${path}: ${j.value.error}: ${j.value.message}`);
  return j.value;
}
export async function session(app) {
  const v = await call("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: app } } } });
  const id = v.sessionId;
  const s = {
    id,
    js: (script, ...args) => call("POST", `/session/${id}/execute/sync`, { script, args }),
    jsAsync: (script, ...args) => call("POST", `/session/${id}/execute/async`, { script, args }),
    async shot(file) { const b64 = await call("GET", `/session/${id}/screenshot`); (await import("fs")).writeFileSync(file, Buffer.from(b64, "base64")); },
    close: () => call("DELETE", `/session/${id}`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async waitFor(script, timeout = 20000, ...args) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) { const v = await s.js(HELPERS + script, ...args).catch(() => null); if (v) return v; await s.sleep(250); }
      throw new Error("timeout waiting for: " + script.slice(0, 120));
    },
  };
  return s;
}
let HELPERS = '';
export function setHelpers(x) { HELPERS = x; }
// In-page helpers injected with every script
export const H = `
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const byText = (sel, text) => $$(sel).find((e) => e.textContent.trim() === text);
  const clickText = (sel, text) => { const e = byText(sel, text); if (!e) throw new Error('no ' + sel + ' ' + text); e.click(); return true; };
  const status = () => document.getElementById('status-text').textContent;
  const setVal = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); };
  const dlg = () => $$('.dialog').at(-1);
  const dlgBtn = (text) => { const d = dlg(); const b = d && [...d.querySelectorAll('.dialog-buttons button')].find(x => x.textContent.trim() === text); if (!b) throw new Error('no dialog button ' + text); b.click(); return true; };
  const menu = (label, parent) => { if (parent) { const g = byText('#menu .menu-item', parent); if (g && !g.classList.contains('open')) g.click(); } return clickText('#menu .menu-item, #menu .menu-sub', label); };
`;
export const F = `
  const scope = () => dlg() || document.querySelector('.mdi-win.active');
  const fieldIn = (root, label) => { const l = [...root.querySelectorAll('.form label')].find(x => x.textContent.trim() === label); if (!l) throw new Error('no field ' + label); return l.nextElementSibling; };
  const fill = (map) => { const r = scope(); for (const [k, v] of Object.entries(map)) { const el = fieldIn(r, k); if (el.tagName === 'SELECT') setVal(el, v); else setVal(el, v); } return true; };
  const check = (text, on) => { const r = scope(); const l = [...r.querySelectorAll('label')].find(x => x.textContent.trim().startsWith(text)); if (!l) throw new Error('no checkbox ' + text); const c = l.querySelector('input'); if (c.checked !== on) c.click(); return true; };
  const winBtn = (text) => { const w = document.querySelector('.mdi-win.active'); const b = [...w.querySelectorAll('button')].find(x => x.textContent.trim() === text || x.title === text); if (!b) throw new Error('no button ' + text); b.click(); return true; };
  const rowClick = (text) => { const w = document.querySelector('.mdi-win.active'); const td = [...w.querySelectorAll('.tab-page.active td, .mdi-body > .table-wrap td, .split td, .table-wrap td')].find(x => x.textContent.trim() === text); if (!td) throw new Error('no row ' + text); td.dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); return true; };
  const errText = () => { const e = [...document.querySelectorAll('.dialog .err-box')].find(x => !x.hidden); return e ? e.textContent : ''; };
`;
export async function connect(s, log, router = "172.17.0.2") {
  await s.waitFor(`return document.querySelector('.dialog .form') !== null`);
  await s.js(`${H} const d = dlg(); const field = (label) => [...d.querySelectorAll('.form label')].find(x => x.textContent.trim() === label).nextElementSibling;
    setVal(field('Connect To'), arguments[0]); setVal(field('Login'), 'vyos'); setVal(field('Password'), 'vyos'); setVal(field('API Key'), 'vygi-test-key'); dlgBtn('Connect'); return true;`, router);
  for (let i = 0; i < 4; i++) {
    const t = await s.waitFor(`const t = [...document.querySelectorAll('.dialog .mdi-title span')].at(-1)?.textContent || ''; if (/Trust|REBOOT/.test(t)) return t; return document.getElementById('conn-label').classList.contains('on') && !document.querySelector('.dialog') ? 'connected' : null;`, 40000);
    if (t === "connected") break;
    log?.("prompt:", t);
    await s.js(`${H} dlgBtn(/REBOOT/.test(arguments[0]) ? 'Switch to reload' : 'Trust'); return true;`, t);
  }
  await s.waitFor(`const t = document.getElementById('status-text').textContent; return /Check-up/.test(t) && t`, 60000);
}
// Waits for an apply to finish: status no longer "Applying".
export async function waitApplied(s) {
  return s.waitFor(`const t = document.getElementById('status-text').textContent; return !/Applying/.test(t) && t`, 120000);
}
