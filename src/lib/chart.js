// Small live line chart on <canvas>, used for traffic and resource graphs.
import { h } from "./dom.js";

/**
 * series: [{ label, color, fill? }]
 * opts: { points: history length, format(value) -> label, min?, max? }
 * Returns { el, push(values[]), resize() }.
 */
export function liveChart(series, { points = 60, format = String, max = null, height = 160 } = {}) {
  const canvas = h("canvas", { style: { width: "100%", height: `${height}px`, display: "block" } });
  const legend = h("div.chart-legend");
  const el = h("div.chart", canvas, legend);
  const data = series.map(() => []);

  const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (!w || !hgt) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);

    const padL = 64;
    const padB = 4;
    const padT = 6;
    const plotW = w - padL - 4;
    const plotH = hgt - padT - padB;
    const all = data.flat().filter(Number.isFinite);
    const top = max ?? niceMax(Math.max(1, ...all));

    // grid + y labels
    ctx.font = `11px ${css("--font", "sans-serif")}`;
    ctx.fillStyle = css("--muted", "#666");
    ctx.strokeStyle = css("--grid", "rgba(0,0,0,0.08)");
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    // 5 steps for a 5×10^n top (0,1,2,3,4,5), otherwise 4 (e.g. 0,25,50,75,100).
    const steps = /^5/.test(String(top)) ? 5 : 4;
    for (let i = 0; i <= steps; i++) {
      const y = padT + (plotH * i) / steps;
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(y) + 0.5);
      ctx.lineTo(padL + plotW, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillText(format(top * (1 - i / steps)), padL - 6, y);
    }

    // series, newest on the right
    const step = plotW / Math.max(1, points - 1);
    series.forEach((s, si) => {
      const vals = data[si];
      if (vals.length < 2) return;
      const x0 = padL + plotW - (vals.length - 1) * step;
      const yOf = (v) => padT + plotH - (Math.min(v, top) / top) * plotH;
      ctx.beginPath();
      vals.forEach((v, i) => {
        const x = x0 + i * step;
        const y = yOf(Number.isFinite(v) ? v : 0);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      if (s.fill !== false) {
        ctx.lineTo(x0 + (vals.length - 1) * step, padT + plotH);
        ctx.lineTo(x0, padT + plotH);
        ctx.closePath();
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      // emphasise the latest point
      const lx = x0 + (vals.length - 1) * step;
      const ly = yOf(vals[vals.length - 1] || 0);
      ctx.beginPath();
      ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
    });
  }

  function renderLegend() {
    legend.textContent = "";
    series.forEach((s, i) => {
      const vals = data[i].filter(Number.isFinite);
      const last = vals[vals.length - 1];
      const peak = vals.length ? Math.max(...vals) : NaN;
      legend.append(
        h("span.chart-key", h("i", { style: { background: s.color } }), `${s.label} `, h("b", Number.isFinite(last) ? format(last) : "–"), h("span.hint", Number.isFinite(peak) ? ` peak ${format(peak)}` : "")),
      );
    });
  }

  const ro = new ResizeObserver(draw);
  ro.observe(canvas);
  renderLegend();

  return {
    el,
    push(values) {
      values.forEach((v, i) => {
        data[i].push(v);
        if (data[i].length > points) data[i].shift();
      });
      draw();
      renderLegend();
    },
    resize: draw,
    dispose: () => ro.disconnect(),
  };
}

/** Rounds up to 1/2/5 × 10^n so axis labels are readable. */
export function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
