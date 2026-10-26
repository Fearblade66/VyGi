// Winbox "Traffic" tab: live Rx/Tx graph for one interface.
import { api, errorText } from "../lib/api.js";
import { h, setStatus, formatBits, formatBytes, every } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { liveChart } from "../lib/chart.js";

export function openTraffic(ifname) {
  const win = openWindow({ key: `traffic:${ifname}`, title: `Traffic <${ifname}>`, width: 640, height: 340 });
  if (!win.isNew) return;
  const chart = liveChart(
    [
      { label: "Rx", color: "#2b6cb0" },
      { label: "Tx", color: "#c05621" },
    ],
    { points: 120, format: formatBits, minTop: 1000, height: 200 },
  );
  const totals = h("div.hint", { style: { padding: "4px 10px" } });
  win.body.style.overflow = "auto";
  win.body.append(chart.el, totals);
  win.onResize(() => chart.resize());

  let prev = null;
  async function poll() {
    let stats;
    try {
      stats = await api.interfaceStats();
    } catch (e) {
      return setStatus(errorText(e), true);
    }
    const link = (stats.links || []).find((l) => l.ifname === ifname);
    if (!link) {
      totals.textContent = `${ifname} is not present on the router.`;
      return;
    }
    const s = link.stats64 || link.stats || {};
    const now = performance.now();
    const cur = { t: now, rx: s.rx?.bytes ?? 0, tx: s.tx?.bytes ?? 0 };
    if (prev && now > prev.t) {
      const dt = (now - prev.t) / 1000;
      chart.push([Math.max(0, ((cur.rx - prev.rx) * 8) / dt), Math.max(0, ((cur.tx - prev.tx) * 8) / dt)]);
    }
    prev = cur;
    totals.textContent = `Total received ${formatBytes(cur.rx)} (${s.rx?.packets ?? 0} packets, ${s.rx?.errors ?? 0} errors, ${s.rx?.dropped ?? 0} dropped) · sent ${formatBytes(cur.tx)} (${s.tx?.packets ?? 0} packets, ${s.tx?.errors ?? 0} errors)`;
  }
  poll();
  const timer = every(poll, 1000);
  win.onClose(() => {
    clearInterval(timer);
    chart.dispose();
  });
}
