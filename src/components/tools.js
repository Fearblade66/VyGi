// Tools: Ping, Traceroute, Torch, Packet Sniffer, IP Scan and Profile. All run over SSH.
import { api, errorText } from "../lib/api.js";
import { h, setStatus, formatBits, every } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { makeTable, filterBox } from "../lib/table.js";
import { isPrivateMac } from "./neighbors.js";
import { parseIpv4Cidr, toArray, flattenInterfaces } from "../lib/vyos.js";
import { session } from "../lib/session.js";

const MAX_OUTPUT_CHARS = 400_000;

/**
 * Generic "inputs + Start/Stop + streaming output" window.
 * buildKind(inputs) returns the StreamKind object for the Rust side.
 */
function streamWindow({ key, title, inputs, buildKind, width = 700, height = 420 }) {
  const win = openWindow({ key, title, width, height });
  if (!win.isNew) return win;

  const out = h("pre.out");
  const btn = h("button", { style: { fontWeight: "bold" } }, "Start");
  const toolbar = h("div.win-toolbar", Object.entries(inputs).flatMap(([label, el]) => [h("span", label), el]), btn, h("span.grow"), h("button", { on: { click: () => (out.textContent = "") } }, "Clear"));
  win.body.append(toolbar, out);

  let id = null;
  let pending = "";
  let flushQueued = false;
  const flush = () => {
    flushQueued = false;
    const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 4;
    out.textContent += pending;
    pending = "";
    if (out.textContent.length > MAX_OUTPUT_CHARS) out.textContent = out.textContent.slice(-MAX_OUTPUT_CHARS / 2);
    if (atBottom) out.scrollTop = out.scrollHeight;
  };
  const stop = async () => {
    if (id != null) await api.closeSession(id).catch(() => {});
    id = null;
    btn.textContent = "Start";
  };
  btn.addEventListener("click", async () => {
    if (id != null) return stop();
    let kind;
    try {
      kind = buildKind();
    } catch (e) {
      return setStatus(e.message, true);
    }
    btn.textContent = "Stop";
    try {
      id = await api.openStream(kind, (msg) => {
        if (msg.event === "data") {
          pending += msg.data;
          if (!flushQueued) {
            flushQueued = true;
            requestAnimationFrame(flush);
          }
        } else if (msg.event === "closed") {
          pending += `\n--- finished${msg.data != null ? ` (exit ${msg.data})` : ""} ---\n`;
          requestAnimationFrame(flush);
          id = null;
          btn.textContent = "Start";
        }
      });
    } catch (e) {
      btn.textContent = "Start";
      setStatus(errorText(e), true);
    }
  });
  win.onClose(stop);
  return win;
}

export function openPing() {
  const target = h("input", { type: "text", placeholder: "address or host", style: { width: "180px" } });
  const count = h("input", { type: "number", value: 5, min: 1, max: 1000, style: { width: "60px" } });
  streamWindow({
    key: "ping",
    title: "Ping",
    inputs: { "To:": target, "Count:": count },
    buildKind: () => {
      if (!target.value.trim()) throw new Error("Enter an address to ping");
      return { type: "ping", target: target.value.trim(), count: Number(count.value) || 5 };
    },
  });
}

export function openTraceroute() {
  const target = h("input", { type: "text", placeholder: "address or host", style: { width: "220px" } });
  streamWindow({
    key: "traceroute",
    title: "Traceroute",
    inputs: { "To:": target },
    buildKind: () => {
      if (!target.value.trim()) throw new Error("Enter an address");
      return { type: "traceroute", target: target.value.trim() };
    },
  });
}

export function openCapture(iface = "") {
  const ifEl = h("input", { type: "text", value: iface, placeholder: "eth0", style: { width: "90px" } });
  const filter = h("input", { type: "text", placeholder: "tcpdump filter, e.g. port 53 or host 192.0.2.5", style: { width: "300px" } });
  const win = streamWindow({
    key: `capture`,
    title: "Packet Sniffer",
    width: 900,
    inputs: { "Interface:": ifEl, "Filter:": filter },
    buildKind: () => {
      if (!ifEl.value.trim()) throw new Error("Enter an interface");
      return { type: "capture", interface: ifEl.value.trim(), filter: filter.value };
    },
  });
  if (!win.isNew && iface) {
    const input = win.body.querySelector("input");
    if (input) input.value = iface;
  }
}

// ---------------- Torch ----------------

/** Rows stay visible this long after their last packet (Winbox keeps idle flows briefly too). */
const TORCH_KEEP_MS = 5000;

/**
 * Winbox-style Torch: live Tx/Rx rate per conversation on one interface.
 * Tx = leaving the router through the interface, Rx = arriving on it.
 */
export function openTorch(iface = "") {
  const existing = openWindow({ key: "torch", title: "Torch", width: 920, height: 460 });
  if (!existing.isNew) {
    if (iface) existing.body.dispatchEvent(new CustomEvent("torch-iface", { detail: iface }));
    return;
  }
  const win = existing;
  const ifSel = h("select", { style: { width: "110px" } }, iface ? h("option", { value: iface }, iface) : null);
  const filter = h("input", { type: "text", placeholder: "optional filter, e.g. host 192.168.1.20 or port 443", style: { width: "280px" } });
  const hideOwn = h("input", { type: "checkbox", checked: true });
  const btn = h("button", { style: { fontWeight: "bold" } }, "Start");
  const totals = h("span.hint");
  const table = makeTable(
    [
      { key: "proto", label: "Proto", width: "60px" },
      { key: "src", label: "Src.", width: "170px" },
      { key: "sport", label: "Src. Port", width: "70px", className: "num" },
      { key: "dst", label: "Dst.", width: "170px" },
      { key: "dport", label: "Dst. Port", width: "70px", className: "num" },
      { key: "txText", label: "Tx Rate", width: "90px", className: "num" },
      { key: "rxText", label: "Rx Rate", width: "90px", className: "num" },
      { key: "pps", label: "Tx/Rx Packets", className: "num" },
    ],
    { rowKey: (r) => r.key, rowClass: (r) => (r.idle ? "dim" : "") },
  );
  win.body.append(
    h("div.win-toolbar", h("span", "Interface:"), ifSel, h("span", "Filter:"), filter, h("label", hideOwn, " hide VyGi's SSH"), btn, h("span.grow"), filterBox(table)),
    table.wrap,
    h("div.row-count", totals),
  );

  api.getConfig(["interfaces"]).then((cfg) => {
    const names = [...flattenInterfaces(cfg).keys()].filter((n) => n !== "lo").sort();
    const cur = ifSel.value;
    ifSel.textContent = "";
    for (const n of new Set([...(cur ? [cur] : []), ...names])) ifSel.append(h("option", { value: n }, n));
    ifSel.value = cur || names[0] || "";
  }).catch(() => {});

  let id = null;
  const rows = new Map(); // key -> row, kept a few seconds after going idle
  const stop = async () => {
    if (id != null) await api.closeSession(id).catch(() => {});
    id = null;
    btn.textContent = "Start";
  };
  const onEvent = (msg) => {
    if (msg.event === "closed") {
      id = null;
      btn.textContent = "Start";
      if (msg.message) setStatus(`Torch: ${msg.message}`, true);
      return;
    }
    const now = Date.now();
    for (const r of rows.values()) Object.assign(r, { txBps: 0, rxBps: 0, txPps: 0, rxPps: 0, idle: true });
    for (const f of msg.flows) {
      const key = [f.proto, f.src, f.sport, f.dst, f.dport].join("|");
      rows.set(key, { ...f, key, seen: now, idle: false });
    }
    for (const [k, r] of rows) if (now - r.seen > TORCH_KEEP_MS) rows.delete(k);
    const list = [...rows.values()].sort((a, b) => (a.idle - b.idle) || (b.txBps + b.rxBps) - (a.txBps + a.rxBps));
    table.setRows(list.map((r) => ({ ...r, txText: r.txBps ? formatBits(r.txBps) : "", rxText: r.rxBps ? formatBits(r.rxBps) : "", pps: r.idle ? "" : `${r.txPps} / ${r.rxPps}` })));
    totals.textContent = `Total — Tx: ${formatBits(msg.txBps)}  Rx: ${formatBits(msg.rxBps)} · ${msg.flows.length} active`;
  };
  const start = async () => {
    if (!ifSel.value) return setStatus("Pick an interface", true);
    rows.clear();
    table.setRows([]);
    btn.textContent = "Stop";
    try {
      const port = hideOwn.checked ? Number(session.info?.profile?.sshPort) || 22 : null;
      id = await api.openTorch(ifSel.value, filter.value, port, onEvent);
    } catch (e) {
      btn.textContent = "Start";
      setStatus(errorText(e), true);
    }
  };
  btn.addEventListener("click", () => (id != null ? stop() : start()));
  win.body.addEventListener("torch-iface", async (e) => {
    if (![...ifSel.options].some((o) => o.value === e.detail)) ifSel.append(h("option", { value: e.detail }, e.detail));
    ifSel.value = e.detail;
    if (id != null) {
      await stop();
      start();
    }
  });
  win.onClose(stop);
}

// ---------------- IP Scan ----------------

/** Finds which addresses in a subnet answer ping (Winbox Tools > IP Scan). */
export async function openIpScan() {
  const win = openWindow({ key: "ipscan", title: "IP Scan", width: 760, height: 400 });
  if (!win.isNew) return;
  const net = h("input", { type: "text", style: { width: "160px" }, placeholder: "192.168.1.0/24" });
  const btn = h("button", { style: { fontWeight: "bold" } }, "Scan");
  const note = h("span.hint");
  const table = makeTable(
    [
      { key: "ip", label: "Address", width: "130px" },
      { key: "mac", label: "MAC Address", width: "150px" },
      { key: "name", label: "Name", width: "160px" },
      { key: "iface", label: "Interface", width: "90px" },
      { key: "note", label: "" },
    ],
    { rowKey: (r) => r.ip },
  );
  win.body.append(h("div.win-toolbar", h("span", "Network:"), net, btn, note, h("span.grow"), filterBox(table)), table.wrap, table.count);

  // Suggest the first LAN-looking network on the router.
  api.getConfig(["interfaces"]).then((cfg) => {
    for (const members of Object.values(cfg || {})) {
      for (const c of Object.values(members || {})) {
        for (const a of toArray(c?.address)) {
          const p = parseIpv4Cidr(a);
          if (p && p.bits >= 22 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(p.ip) && !net.value) net.value = p.network;
        }
      }
    }
  }).catch(() => {});

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    note.textContent = "Scanning… (up to a minute for a /24)";
    try {
      const [res, leases] = await Promise.all([api.ipScan(net.value), api.dhcpLeases(4).catch(() => [])]);
      const names = new Map((leases || []).map((l) => [l.ip, l.hostname]));
      const neigh = new Map((res.neighbors || []).filter((n) => n.lladdr).map((n) => [n.dst, n]));
      const num = (ip) => ip.split(".").reduce((a, b) => a * 256 + Number(b), 0);
      table.setRows(res.alive.sort((a, b) => num(a) - num(b)).map((ip) => {
        const n = neigh.get(ip);
        return { ip, mac: n?.lladdr || "", iface: n?.dev || "", name: names.get(ip) || "", note: n?.lladdr && isPrivateMac(n.lladdr) ? "private MAC" : n ? "" : "router itself / no ARP" };
      }));
      note.textContent = `${res.alive.length} of ${res.scanned} addresses answered ping (devices that block ping won't show).`;
    } catch (e) {
      note.textContent = "";
      setStatus(errorText(e), true);
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------- Profile (processes) ----------------
export function openProfile() {
  const win = openWindow({ key: "profile", title: "Profile (processes)", width: 720, height: 420 });
  if (!win.isNew) return;
  const table = makeTable(
    [
      { key: "command", label: "Process", width: "200px" },
      { key: "cpuText", label: "CPU", width: "70px", className: "num" },
      { key: "memText", label: "Memory", width: "70px", className: "num" },
      { key: "rssText", label: "RSS", width: "90px", className: "num" },
      { key: "user", label: "User", width: "80px" },
      { key: "pid", label: "PID", width: "70px", className: "num" },
      { key: "elapsed", label: "Running for" },
    ],
    { rowKey: (r) => r.pid },
  );
  win.body.append(h("div.win-toolbar", h("span.hint", "Busiest processes, refreshed every 3 s."), h("span.grow"), filterBox(table)), table.wrap, table.count);
  const load = async () => {
    try {
      const list = await api.processes();
      table.setRows(list.map((p) => ({ ...p, cpuText: `${p.cpu.toFixed(1)}%`, memText: `${p.mem.toFixed(1)}%`, rssText: `${(p.rssKb / 1024).toFixed(1)} MiB` })));
    } catch (e) {
      setStatus(errorText(e), true);
    }
  };
  load();
  const timer = every(load, 3000);
  win.onClose(() => clearInterval(timer));
}
