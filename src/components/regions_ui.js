// Region blocking card and country picker (Traffic Rules page).
import { errorText } from "../lib/api.js";
import { h } from "../lib/dom.js";
import { modal, alertBox } from "../lib/dialog.js";
import { applyChanges } from "../lib/session.js";
import { icon } from "../lib/icons.js";
import { countryName, flagEmoji } from "../lib/sites.js";
import { COUNTRY_CODES, parseRegions, regionCommands } from "../lib/regions.js";

const label = (c) => `${flagEmoji(c)} ${countryName(c.toUpperCase())}`;

export function regionCard(cfg, refresh) {
  const { countries } = parseRegions(cfg);
  return h("div.rule-card.region-card", { on: { click: () => editRegions(cfg, refresh) }, title: "Click to change" },
    h("div.rule-top",
      h("span.rule-icon", icon("globe", 18)),
      h("div.grow",
        h("div.rule-name", "Region blocking"),
        h("div.hint", countries.length
          ? `No traffic to or from ${countries.length === 1 ? "1 country" : `${countries.length} countries`}: ${countries.slice(0, 6).map(label).join(", ")}${countries.length > 6 ? ", …" : ""}`
          : "Off. Block all traffic to and from chosen countries, for every device.")),
      h("span.badge" + (countries.length ? ".bad" : ""), countries.length ? "On" : "Off")));
}

export async function editRegions(cfg, refresh) {
  const chosen = new Set(parseRegions(cfg).countries);
  const all = COUNTRY_CODES.map((c) => ({ c, name: countryName(c.toUpperCase()) })).sort((a, b) => a.name.localeCompare(b.name));
  const search = h("input", { type: "search", placeholder: "Search countries" });
  const count = h("span.hint");
  const rows = all.map(({ c, name }) => {
    const cb = h("input", { type: "checkbox", checked: chosen.has(c) });
    cb.addEventListener("change", () => {
      if (cb.checked) chosen.add(c);
      else chosen.delete(c);
      count.textContent = `${chosen.size} selected`;
    });
    return { c, name, el: h("label.country-row", cb, ` ${flagEmoji(c)} ${name}`) };
  });
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    for (const r of rows) r.el.hidden = !!q && !r.name.toLowerCase().includes(q) && r.c !== q;
  });
  count.textContent = `${chosen.size} selected`;
  const body = h("div", { style: { width: "440px" } },
    h("div.hint", { style: { marginBottom: "8px" } }, "Devices can't reach these countries, and nothing from them can reach your network or the router. Country data comes from DB-IP; the router downloads it itself. Services hosted in several countries (CDNs) may still work, or break in unexpected places."),
    h("div", { style: { display: "flex", gap: "8px", alignItems: "center", marginBottom: "6px" } }, search, count),
    h("div.country-list", rows.map((r) => r.el)));
  await modal("Region blocking", body, [
    { label: "Cancel", value: "cancel" },
    { label: "Apply", value: "ok", primary: true },
  ], async () => {
    try {
      await applyChanges(regionCommands(cfg, [...chosen]), chosen.size ? `block ${chosen.size} countr${chosen.size === 1 ? "y" : "ies"}` : "turn off region blocking");
    } catch (e) {
      alertBox("Failed", errorText(e));
      return false;
    }
    refresh();
    return true;
  });
}
