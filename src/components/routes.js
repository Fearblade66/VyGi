// IP > Routes: kernel routing table per VRF, add/remove static routes.
import { api, errorText } from "../lib/api.js";
import { h, setStatus, every } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { makeTable, filterBox } from "../lib/table.js";
import { formDialog, confirmBox, alertBox } from "../lib/dialog.js";
import { applyChanges } from "../lib/session.js";

export function openRoutes() {
  const win = openWindow({ key: "routes", title: "Route List", width: 860, height: 420 });
  if (!win.isNew) return;

  const table = makeTable(
    [
      { key: "flags", label: "", width: "34px", className: "flag" },
      { key: "dst", label: "Dst. Address", width: "170px" },
      { key: "gateway", label: "Gateway", width: "150px" },
      { key: "dev", label: "Interface", width: "90px" },
      { key: "protocol", label: "Protocol", width: "80px" },
      { key: "metric", label: "Distance/Metric", width: "100px", className: "num" },
      { key: "prefsrc", label: "Pref. Source", width: "120px" },
    ],
    { rowKey: (r) => `${r.dst}|${r.gateway}|${r.dev}|${r.metric}` },
  );
  const vrf = h("select", h("option", { value: "default" }, "default"));
  const family = h("select", h("option", { value: 4 }, "IPv4"), h("option", { value: 6 }, "IPv6"));
  const toolbar = h(
    "div.win-toolbar",
    h("button.icon-add", { title: "Add static route", on: { click: addRoute } }, "+"),
    h("button.icon-remove", { title: "Remove static route", on: { click: removeRoute } }, "−"),
    h("button", { title: "Refresh", on: { click: load } }, "⟳"),
    h("span", " VRF:"), vrf,
    family,
    h("span.grow"),
    filterBox(table),
  );
  vrf.addEventListener("change", load);
  family.addEventListener("change", load);
  win.body.append(toolbar, table.wrap, table.count);

  async function loadVrfs() {
    try {
      const names = Object.keys((await api.getConfig(["vrf", "name"])) || {});
      for (const n of names) vrf.append(h("option", { value: n }, n));
    } catch {
      /* no VRFs configured */
    }
  }

  async function load() {
    try {
      const list = await api.routes(Number(family.value), vrf.value);
      table.setRows(
        list.map((r) => ({
          flags: (r.protocol === "static" ? "S" : r.protocol === "kernel" ? "C" : r.protocol?.[0]?.toUpperCase() || "") + ((r.flags || []).includes("linkdown") ? "X" : "A"),
          dst: r.dst === "default" ? (family.value === "4" ? "0.0.0.0/0" : "::/0") : r.dst,
          gateway: r.gateway || (r.nexthops || []).map((n) => n.gateway).filter(Boolean).join(", ") || "",
          dev: r.dev || (r.nexthops || []).map((n) => n.dev).join(", ") || "",
          protocol: r.protocol || "",
          metric: r.metric ?? "",
          prefsrc: r.prefsrc || "",
          type: r.type,
        })),
      );
    } catch (e) {
      setStatus(errorText(e), true);
    }
  }

  function staticBase() {
    const fam = family.value === "4" ? "route" : "route6";
    const base = vrf.value === "default" ? ["protocols", "static", fam] : ["vrf", "name", vrf.value, "protocols", "static", fam];
    return base;
  }

  async function addRoute() {
    await formDialog(`Add static route (${vrf.value} VRF)`, [
      { name: "dst", label: "Dst. Address", placeholder: family.value === "4" ? "10.0.0.0/8 or 0.0.0.0/0" : "2001:db8::/32" },
      { name: "gateway", label: "Gateway", placeholder: "next-hop address (or leave empty)" },
      { name: "iface", label: "Interface", placeholder: "only if no gateway, e.g. wg0" },
      { name: "distance", label: "Distance", placeholder: "optional, 1-255" },
    ], async (v) => {
      const dst = v.dst.trim();
      if (!/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(dst)) throw new Error("Dst. Address must be a prefix like 10.0.0.0/8");
      const base = [...staticBase(), dst];
      let path;
      if (v.gateway.trim()) path = [...base, "next-hop", v.gateway.trim()];
      else if (v.iface.trim()) path = [...base, "interface", v.iface.trim()];
      else throw new Error("Give a gateway or an interface");
      const cmds = [{ op: "set", path }];
      if (v.distance.trim()) cmds.push({ op: "set", path: [...path, "distance"], value: v.distance.trim() });
      if (dst === "0.0.0.0/0" || dst === "::/0") {
        if (!(await confirmBox("Default route", "Changing the default route can cut off your access to the router. Make sure Safe Mode is ON.", "Continue"))) return false;
      }
      await applyChanges(cmds, `route ${dst}`);
      await load();
      return true;
    }, { okLabel: "Apply" });
  }

  async function removeRoute() {
    const r = table.selected();
    if (!r) return setStatus("Select a route first.", true);
    if (r.protocol !== "static") return alertBox("Not a static route", `This route comes from "${r.protocol}". Only static routes can be removed here; change the ${r.protocol} config instead.`);
    if (!(await confirmBox("Remove route", `Delete static route ${r.dst}?`, "Remove"))) return;
    try {
      await applyChanges([{ op: "delete", path: [...staticBase(), r.dst] }], `remove route ${r.dst}`);
      await load();
    } catch (e) {
      alertBox("Apply failed", errorText(e));
    }
  }

  loadVrfs().then(load);
  const timer = every(load, 10000);
  win.onClose(() => clearInterval(timer));
}
