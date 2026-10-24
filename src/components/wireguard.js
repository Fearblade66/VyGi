// WireGuard setup: Quick Setup wizard, Add Peer, and client configs with QR codes.
// Flow adapted from VyManager's QuickSetupWizard; keys are generated locally so a
// client's private key never reaches the router.
import QRCode from "qrcode";
import { save } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../lib/api.js";
import { h, setStatus } from "../lib/dom.js";
import { modal, formDialog, alertBox, confirmBox } from "../lib/dialog.js";
import { applyChanges, session } from "../lib/session.js";
import { toArray, has, parseIpv4Cidr, nextFreeIpv4 } from "../lib/vyos.js";

const FULL_TUNNEL = "0.0.0.0/0, ::/0";
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Gathers what the wizards need to suggest sensible defaults. */
async function snapshot() {
  const [ifaces, fwInput, natSrc, dns, stats] = await Promise.all([
    api.getConfig(["interfaces"]).catch(() => ({})),
    api.getConfig(["firewall", "ipv4", "input", "filter"]).catch(() => ({})),
    api.getConfig(["nat", "source"]).catch(() => ({})),
    api.getConfig(["service", "dns", "forwarding"]).catch(() => ({})),
    api.interfaceStats().catch(() => ({ links: [] })),
  ]);
  const wg = ifaces.wireguard || {};
  // LAN subnets = private IPv4 networks on non-WireGuard interfaces (for split tunnels).
  const lans = [];
  let dhcpWan = null;
  for (const [type, members] of Object.entries(ifaces)) {
    if (type === "wireguard" || type === "loopback") continue;
    for (const [name, cfg] of Object.entries(members || {})) {
      for (const a of toArray(cfg?.address)) {
        if (a === "dhcp" && !dhcpWan) dhcpWan = name;
        const c = parseIpv4Cidr(a);
        if (c && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(c.ip)) lans.push(c.network);
      }
    }
  }
  const masq = Object.values(natSrc.rule || {}).find((r) => r?.translation?.address === "masquerade" && r?.["outbound-interface"]?.name);
  return {
    wg,
    lans: [...new Set(lans)],
    wan: masq?.["outbound-interface"]?.name || dhcpWan || "eth0",
    // Ports known to the config or present in the kernel (new ports may not be in the config yet).
    allIfaces: [...new Set([
      ...Object.values(ifaces).flatMap((m) => Object.keys(m || {})),
      ...(stats.links || []).map((l) => l.ifname).filter((n) => /^(eth|br|bond|pppoe)\d/.test(n)),
    ])],
    inputDrops: fwInput["default-action"] === "drop",
    inputRules: Object.keys(fwInput.rule || {}).map(Number),
    inputCatchAll: catchAllRule(fwInput.rule),
    natRules: Object.keys(natSrc.rule || {}).map(Number),
    dnsConfigured: Object.keys(dns || {}).length > 0,
  };
}

/** Lowest-numbered drop/reject rule that matches everything (rules after it never run). */
function catchAllRule(rules) {
  const harmless = new Set(["action", "description", "log", "log-options"]);
  const hits = Object.entries(rules || {})
    .filter(([, r]) => ["drop", "reject"].includes(r?.action) && !has(r, "disable") && Object.keys(r).every((k) => harmless.has(k)))
    .map(([n]) => Number(n));
  return hits.length ? Math.min(...hits) : null;
}

/** A free rule number that runs before any catch-all drop rule. */
function inputRuleNumber(used, catchAll) {
  if (catchAll == null) return nextNumber(used);
  for (let n = catchAll - 1; n >= 1; n--) if (!used.includes(n)) return n;
  return null;
}

const nextNumber = (nums) => (nums.length ? Math.floor(Math.max(...nums) / 10) * 10 + 10 : 10);

function nextName(existing) {
  for (let i = 0; ; i++) if (!existing.includes(`wg${i}`)) return `wg${i}`;
}

function nextPort(wg) {
  const used = Object.values(wg).map((c) => Number(c?.port)).filter(Boolean);
  for (let p = 51820; ; p++) if (!used.includes(p)) return String(p);
}

function nextSubnet(wg) {
  const used = Object.values(wg).flatMap((c) => toArray(c?.address)).map((a) => parseIpv4Cidr(a)?.network);
  for (let i = 0; i < 255; i++) {
    const net = `10.10.${i}.0/24`;
    if (!used.includes(net)) return `10.10.${i}.1/24`;
  }
  return "10.99.0.1/24";
}

function buildClientConfig({ privateKey, address, dns, serverPublicKey, psk, endpoint, allowedIps }) {
  return [
    "[Interface]",
    `PrivateKey = ${privateKey}`,
    `Address = ${address}`,
    dns ? `DNS = ${dns}` : null,
    "",
    "[Peer]",
    `PublicKey = ${serverPublicKey}`,
    psk ? `PresharedKey = ${psk}` : null,
    `Endpoint = ${endpoint}`,
    `AllowedIPs = ${allowedIps}`,
    "PersistentKeepalive = 25",
    "",
  ].filter((l) => l !== null).join("\n");
}

/** Validates the endpoint; returns false if the user backs out of a private-address warning. */
async function checkEndpoint(ep) {
  if (!/^[A-Za-z0-9.:\[\]-]+$/.test(ep)) throw new Error("Public address must be your router's public IP or DNS name (no port)");
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(ep)) {
    return confirmBox(
      "Private address",
      `${ep} is a private (home network) address. Devices outside your home can't reach it, so the VPN would only work on your own Wi-Fi.\n\nUse your public IP or a dynamic-DNS name instead. Continue anyway?`,
      "Continue anyway",
    );
  }
  return true;
}

/** Shows a client config once, with QR code, copy and save. */
export async function showClientConfig(peerName, text) {
  const canvas = h("canvas", { style: { background: "#fff", padding: "6px", border: "1px solid var(--border)" } });
  await QRCode.toCanvas(canvas, text, { errorCorrectionLevel: "M", width: 240, margin: 1 });
  const area = h("textarea", { rows: 12, readOnly: true, value: text, style: { width: "100%", fontSize: "11px" } });
  const body = h(
    "div",
    { style: { width: "600px" } },
    h("div.warn-box", "This config contains the device's private key. It is NOT stored anywhere — save it or scan the QR code now."),
    h("div", { style: { display: "flex", gap: "10px", alignItems: "flex-start" } },
      h("div", { style: { textAlign: "center" } }, canvas, h("div.hint", "Scan with the WireGuard app")),
      h("div", { style: { flex: 1 } }, area)),
  );
  await modal(`Client config: ${peerName}`, body, [
    { label: "Copy", value: "copy" },
    { label: "Save .conf…", value: "save" },
    { label: "Close", value: "close", primary: true },
  ], async (v) => {
    if (v === "copy") {
      try {
        await navigator.clipboard.writeText(text);
        setStatus("Client config copied.");
      } catch {
        area.select();
        document.execCommand("copy");
      }
      return false;
    }
    if (v === "save") {
      const file = await save({ title: "Save WireGuard client config", defaultPath: `${peerName}.conf`, filters: [{ name: "WireGuard config", extensions: ["conf"] }] });
      if (file) {
        await api.saveTextFile(file, text).catch((e) => alertBox("Save failed", errorText(e)));
        setStatus(`Saved ${file}`);
      }
      return false;
    }
    return true;
  });
}

export async function quickSetup(onDone) {
  let s;
  try {
    s = await snapshot();
  } catch (e) {
    return alertBox("Quick Setup", errorText(e));
  }
  const name = nextName(Object.keys(s.wg));
  const server = nextSubnet(s.wg);
  const serverC = parseIpv4Cidr(server);
  let result = null;

  await formDialog("WireGuard Quick Setup", [
    { name: "iface", label: "Interface", value: name },
    { name: "address", label: "VPN address", value: server, hint: "The router's address inside the VPN; clients get addresses from this subnet." },
    { name: "port", label: "Listen port (UDP)", value: nextPort(s.wg) },
    { name: "endpoint", label: "Public address", value: session.info?.profile.host || "", hint: "Your router's public IP or DNS name, as clients on the internet will reach it." },
    { name: "client", label: "First device name", value: "phone" },
    { name: "clientIp", label: "Device address", value: `${nextFreeIpv4(serverC.network, [serverC.ip])}/32` },
    { name: "mode", label: "Route through VPN", type: "select", value: "full", options: [
      { value: "full", label: "All traffic (full tunnel)" },
      { value: "split", label: "Only VPN + home LAN (split tunnel)" },
    ] },
    { name: "lans", label: "LAN subnets", value: s.lans.join(", "), hint: "Used for split tunnel." },
    { name: "dns", label: "Client DNS", value: serverC.ip, hint: "Leave empty to keep the device's own DNS." },
    { name: "openFw", label: s.inputDrops ? "Open the UDP port in the firewall (input chain drops by default)" : "Open the UDP port in the firewall", type: "checkbox", value: s.inputDrops },
    { name: "nat", label: "Masquerade VPN clients to the internet (needed for full tunnel)", type: "checkbox", value: true },
    { name: "wan", label: "WAN interface", type: "select", options: [...new Set([s.wan, ...s.allIfaces])], value: s.wan },
    { name: "dnsFwd", label: "Let VPN clients use the router as DNS server", type: "checkbox", value: true },
    { name: "psk", label: "Use a preshared key (extra protection)", type: "checkbox", value: true },
  ], async (v) => {
    const iface = v.iface.trim();
    if (!/^wg\d+$/.test(iface)) throw new Error("Interface name must be wg0, wg1, …");
    if (s.wg[iface]) throw new Error(`${iface} already exists`);
    const sc = parseIpv4Cidr(v.address);
    if (!sc || sc.bits > 30) throw new Error("VPN address must look like 10.10.0.1/24");
    const port = Number(v.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be 1-65535");
    const ep = v.endpoint.trim();
    if (!(await checkEndpoint(ep))) return false;
    const client = v.client.trim();
    if (!NAME_RE.test(client)) throw new Error("Device name: letters, digits, - _ . only");
    const cc = parseIpv4Cidr(v.clientIp);
    if (!cc) throw new Error("Device address must look like 10.10.0.2/32");
    if (parseIpv4Cidr(`${cc.ip}/${sc.bits}`).network !== sc.network) throw new Error("Device address must be inside the VPN subnet");
    if (cc.ip === sc.ip) throw new Error("Device address must differ from the router's VPN address");

    if (v.nat && !v.wan) throw new Error("Pick the WAN interface for internet access (or untick NAT)");
    const [srv, cli] = await Promise.all([api.wireguardKeypair(), api.wireguardKeypair()]);
    const psk = v.psk ? await api.wireguardPsk() : null;
    const base = ["interfaces", "wireguard", iface];
    const peer = [...base, "peer", client];
    const cmds = [
      { op: "set", path: [...base, "address"], value: v.address.trim() },
      { op: "set", path: [...base, "port"], value: String(port) },
      { op: "set", path: [...base, "private-key"], value: srv.privateKey },
      { op: "set", path: [...base, "description"], value: "WireGuard VPN" },
      { op: "set", path: [...peer, "public-key"], value: cli.publicKey },
      { op: "set", path: [...peer, "allowed-ips"], value: `${cc.ip}/32` },
    ];
    if (psk) cmds.push({ op: "set", path: [...peer, "preshared-key"], value: psk });
    if (v.openFw) {
      const num = inputRuleNumber(s.inputRules, s.inputCatchAll);
      if (num == null) throw new Error("No free firewall rule number before your catch-all drop rule; untick the firewall option and add the rule manually.");
      const r = ["firewall", "ipv4", "input", "filter", "rule", String(num)];
      cmds.push(
        { op: "set", path: [...r, "action"], value: "accept" },
        { op: "set", path: [...r, "protocol"], value: "udp" },
        { op: "set", path: [...r, "destination", "port"], value: String(port) },
        { op: "set", path: [...r, "description"], value: `WireGuard ${iface}` },
      );
    }
    if (v.nat) {
      const r = ["nat", "source", "rule", String(nextNumber(s.natRules))];
      cmds.push(
        { op: "set", path: [...r, "outbound-interface", "name"], value: v.wan },
        { op: "set", path: [...r, "source", "address"], value: sc.network },
        { op: "set", path: [...r, "translation", "address"], value: "masquerade" },
        { op: "set", path: [...r, "description"], value: `WireGuard ${iface} to internet` },
      );
    }
    if (v.dnsFwd && v.dns.trim()) {
      const d = ["service", "dns", "forwarding"];
      cmds.push({ op: "set", path: [...d, "allow-from"], value: sc.network }, { op: "set", path: [...d, "listen-address"], value: sc.ip });
      if (!s.dnsConfigured) cmds.push({ op: "set", path: [...d, "system"] });
    }

    await applyChanges(cmds, `WireGuard ${iface}`);
    const allowed = v.mode === "full" ? FULL_TUNNEL : [sc.network, ...v.lans.split(/[\s,]+/).filter(Boolean)].join(", ");
    result = {
      client,
      text: buildClientConfig({ privateKey: cli.privateKey, address: `${cc.ip}/32`, dns: v.dns.trim(), serverPublicKey: srv.publicKey, psk, endpoint: `${ep.includes(":") && !ep.startsWith("[") ? `[${ep}]` : ep}:${port}`, allowedIps: allowed }),
    };
    return true;
  }, {
    okLabel: "Create",
    intro: "Creates a WireGuard server on this router and a config for your first device (phone/laptop). If the router is behind another router, forward the UDP port to it there too.",
  });

  if (result) {
    if (onDone) onDone();
    await showClientConfig(result.client, result.text);
  }
}

export async function addPeer(onDone) {
  let s;
  let dump = [];
  try {
    s = await snapshot();
    dump = (await api.wireguardDump()).split("\n").map((l) => l.split("\t")).filter((f) => f.length === 5);
  } catch (e) {
    return alertBox("Add Peer", errorText(e));
  }
  const names = Object.keys(s.wg);
  if (!names.length) return alertBox("Add Peer", "There is no WireGuard interface yet. Use Quick Setup first.");
  const serverPub = Object.fromEntries(dump.map((f) => [f[0], f[2]]));

  const suggestIp = (iface) => {
    const cfg = s.wg[iface] || {};
    const addr = toArray(cfg.address).map(parseIpv4Cidr).find(Boolean);
    if (!addr) return "";
    const used = [addr.ip, ...Object.values(cfg.peer || {}).flatMap((p) => toArray(p?.["allowed-ips"]))];
    const ip = nextFreeIpv4(addr.network, used);
    return ip ? `${ip}/32` : "";
  };
  const first = names[0];
  const firstAddr = toArray(s.wg[first]?.address).map(parseIpv4Cidr).find(Boolean);
  let result = null;

  const fields = [
    { name: "iface", label: "Interface", type: "select", options: names, value: first },
    { name: "name", label: "Device name", value: "" , placeholder: "e.g. laptop" },
    { name: "ip", label: "Device address", value: "", placeholder: "automatic", hint: "Leave empty to use the next free address on the selected interface." },
    { name: "endpoint", label: "Public address", value: session.info?.profile.host || "", hint: "Your router's public IP or DNS name." },
    { name: "mode", label: "Route through VPN", type: "select", value: "full", options: [
      { value: "full", label: "All traffic (full tunnel)" },
      { value: "split", label: "Only VPN + home LAN (split tunnel)" },
    ] },
    { name: "lans", label: "LAN subnets", value: s.lans.join(", ") },
    { name: "dns", label: "Client DNS", value: firstAddr?.ip || "", hint: "Usually the router's VPN address. Empty = device keeps its own DNS." },
    { name: "psk", label: "Use a preshared key", type: "checkbox", value: true },
  ];

  await formDialog("Add WireGuard Device", fields, async (v) => {
    const iface = v.iface;
    const cfg = s.wg[iface] || {};
    const name = v.name.trim();
    if (!NAME_RE.test(name)) throw new Error("Device name: letters, digits, - _ . only");
    if (cfg.peer?.[name]) throw new Error(`${name} already exists on ${iface}`);
    const pub = serverPub[iface];
    if (!pub) throw new Error(`Could not read ${iface}'s public key (is the interface up?)`);
    const addr = toArray(cfg.address).map(parseIpv4Cidr).find(Boolean);
    const ipText = v.ip.trim() || suggestIp(iface);
    const cc = parseIpv4Cidr(ipText.includes("/") ? ipText : `${ipText}/32`);
    if (!cc) throw new Error("Device address must look like 10.10.0.5/32");
    if (addr && parseIpv4Cidr(`${cc.ip}/${addr.bits}`).network !== addr.network) throw new Error(`Address must be inside ${addr.network}`);
    const taken = Object.values(cfg.peer || {}).flatMap((p) => toArray(p?.["allowed-ips"])).map((a) => a.split("/")[0]);
    if (taken.includes(cc.ip) || cc.ip === addr?.ip) throw new Error(`${cc.ip} is already used`);
    const ep = v.endpoint.trim();
    if (!(await checkEndpoint(ep))) return false;

    const cli = await api.wireguardKeypair();
    const psk = v.psk ? await api.wireguardPsk() : null;
    const peer = ["interfaces", "wireguard", iface, "peer", name];
    const cmds = [
      { op: "set", path: [...peer, "public-key"], value: cli.publicKey },
      { op: "set", path: [...peer, "allowed-ips"], value: `${cc.ip}/32` },
    ];
    if (psk) cmds.push({ op: "set", path: [...peer, "preshared-key"], value: psk });
    await applyChanges(cmds, `WireGuard peer ${name}`);

    const allowed = v.mode === "full" ? FULL_TUNNEL : [addr?.network, ...v.lans.split(/[\s,]+/)].filter(Boolean).join(", ");
    result = {
      name,
      text: buildClientConfig({ privateKey: cli.privateKey, address: `${cc.ip}/32`, dns: v.dns.trim(), serverPublicKey: pub, psk, endpoint: `${ep.includes(":") && !ep.startsWith("[") ? `[${ep}]` : ep}:${cfg.port || 51820}`, allowedIps: allowed }),
    };
    return true;
  }, {
    okLabel: "Create",
    onChange(field, v, set) {
      if (field !== "iface") return;
      set("ip", "");
      const a = toArray(s.wg[v.iface]?.address).map(parseIpv4Cidr).find(Boolean);
      set("dns", a?.ip || "");
    },
  });

  if (result) {
    if (onDone) onDone();
    await showClientConfig(result.name, result.text);
  }
}

export async function removePeer(row, onDone) {
  if (!row) return setStatus("Select a peer first.", true);
  if (!row.name) return alertBox("Remove Peer", "This peer has no name in the config (it may be managed elsewhere).");
  if (!(await confirmBox("Remove peer", `Remove ${row.name} from ${row.iface}? That device will no longer be able to connect.`, "Remove"))) return;
  try {
    await applyChanges([{ op: "delete", path: ["interfaces", "wireguard", row.iface, "peer", row.name] }], `remove peer ${row.name}`);
    if (onDone) onDone();
  } catch (e) {
    alertBox("Apply failed", errorText(e));
  }
}
