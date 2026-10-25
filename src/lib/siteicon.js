// Small site icons (favicons) with a colored-letter placeholder, loaded in batches.
import { api } from "./api.js";
import { h } from "./dom.js";

const KEY = "vygi.siteIcons";
const cache = new Map(); // domain -> data URL | null
const waiting = new Map(); // domain -> [img elements]
let timer = null;

export function iconsEnabled() {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setIconsEnabled(on) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* private mode */
  }
}

function hue(s) {
  let x = 0;
  for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x % 360;
}

function apply(el, url) {
  if (!url) return;
  el.textContent = "";
  el.style.background = "transparent";
  el.append(h("img", { src: url, alt: "", draggable: "false" }));
}

async function flush() {
  timer = null;
  const domains = [...waiting.keys()].filter((d) => !cache.has(d));
  if (!domains.length) return;
  let res = {};
  try {
    res = await api.siteIcons(domains);
  } catch {
    /* offline: keep letters */
  }
  for (const d of domains) {
    const url = res[d] ?? null;
    cache.set(d, url);
    for (const el of waiting.get(d) || []) apply(el, url);
    waiting.delete(d);
  }
}

/**
 * Icon for a site. `domain` is where the icon comes from (null = letter only),
 * `label` gives the letter and color of the placeholder.
 */
export function siteIcon(domain, label) {
  const name = String(label || domain || "?");
  const el = h("span.site-icon", { style: { background: `hsl(${hue(name)} 55% 45%)` } }, name.replace(/^www\./, "").charAt(0).toUpperCase());
  if (!domain || !iconsEnabled()) return el;
  if (cache.has(domain)) {
    apply(el, cache.get(domain));
    return el;
  }
  if (!waiting.has(domain)) waiting.set(domain, []);
  waiting.get(domain).push(el);
  timer ||= setTimeout(flush, 60);
  return el;
}
