// Tools: Ping, Traceroute, Packet Capture ("Torch"), IP Scan and Profile. All run over SSH.
import { api, errorText } from "../lib/api.js";
import { h, setStatus } from "../lib/dom.js";
import { openWindow } from "../lib/mdi.js";
import { makeTable, filterBox } from "../lib/table.js";
import { isPrivateMac } from "./neighbors.js";
import { parseIpv4Cidr, toArray } from "../lib/vyos.js";

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
    title: "Packet Capture (Torch)",
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
  const timer = setInterval(load, 3000);
  win.onClose(() => clearInterval(timer));
}
