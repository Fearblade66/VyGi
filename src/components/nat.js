// NAT: source NAT (masquerade) and destination NAT (port forwards).
import { h } from "../lib/dom.js";
import { openWindow, tabs } from "../lib/mdi.js";
import { ruleEditor } from "../lib/rules.js";

const PROTOCOLS = ["", "tcp", "udp", "tcp_udp", "icmp", "all"];

const portNeedsProto = (v) => {
  const ports = [v.srcPort, v.dstPort, v.trPort].some((p) => p && p.trim());
  if (ports && !["tcp", "udp", "tcp_udp"].includes(v.protocol)) throw new Error("Ports need protocol tcp, udp or tcp_udp");
};

const SOURCE_FIELDS = [
  { name: "outIf", label: "Out. Interface", path: ["outbound-interface", "name"], placeholder: "WAN interface, e.g. eth0" },
  { name: "protocol", label: "Protocol", path: ["protocol"], type: "select", options: PROTOCOLS },
  { name: "srcAddr", label: "Src. Address", path: ["source", "address"], placeholder: "LAN, e.g. 192.168.1.0/24" },
  { name: "srcPort", label: "Src. Port", path: ["source", "port"] },
  { name: "dstAddr", label: "Dst. Address", path: ["destination", "address"] },
  { name: "dstPort", label: "Dst. Port", path: ["destination", "port"] },
  { name: "trAddr", label: "To Address", path: ["translation", "address"], placeholder: "masquerade, or a public IP" },
  { name: "trPort", label: "To Port", path: ["translation", "port"] },
  { name: "log", label: "Log", path: ["log"], type: "flag" },
  { name: "description", label: "Comment", path: ["description"] },
];

const DEST_FIELDS = [
  { name: "inIf", label: "In. Interface", path: ["inbound-interface", "name"], placeholder: "WAN interface, e.g. eth0" },
  { name: "protocol", label: "Protocol", path: ["protocol"], type: "select", options: PROTOCOLS },
  { name: "dstAddr", label: "Dst. Address", path: ["destination", "address"], placeholder: "optional: your public IP" },
  { name: "dstPort", label: "Dst. Port", path: ["destination", "port"], placeholder: "outside port, e.g. 8080" },
  { name: "srcAddr", label: "Src. Address", path: ["source", "address"], placeholder: "optional: only allow from" },
  { name: "srcPort", label: "Src. Port", path: ["source", "port"] },
  { name: "trAddr", label: "To Address", path: ["translation", "address"], placeholder: "inside host, e.g. 192.168.1.10" },
  { name: "trPort", label: "To Port", path: ["translation", "port"], placeholder: "inside port, e.g. 80 (empty = same)" },
  { name: "log", label: "Log", path: ["log"], type: "flag" },
  { name: "description", label: "Comment", path: ["description"] },
];

export function openNat() {
  const win = openWindow({ key: "nat", title: "NAT", width: 1040, height: 440 });
  if (!win.isNew) return;
  const editors = {};
  const t = tabs(["Source NAT", "Destination NAT (Port Forward)"], (name) => editors[name]?.load());
  win.body.append(t.el);

  editors["Source NAT"] = ruleEditor({
    page: t.pages["Source NAT"],
    what: "rule",
    title: "Source NAT Rule",
    getBase: () => ["nat", "source"],
    columns: [
      { key: "out", label: "Out. Iface", width: "80px", path: ["outbound-interface", "name"] },
      { key: "proto", label: "Proto", width: "60px", path: ["protocol"] },
      { key: "src", label: "Src. Address", width: "140px", path: ["source", "address"] },
      { key: "dst", label: "Dst. Address", width: "130px", path: ["destination", "address"] },
      { key: "dport", label: "Dst. Port", width: "70px", path: ["destination", "port"] },
      { key: "tr", label: "To Address", width: "120px", path: ["translation", "address"] },
      { key: "desc", label: "Comment", path: ["description"] },
    ],
    getFields: () => SOURCE_FIELDS,
    newDefaults: { trAddr: "masquerade" },
    intro: "Typical internet sharing: Out. Interface = your WAN port, Src. Address = your LAN subnet, To Address = masquerade.",
    validate(v) {
      portNeedsProto(v);
      if (!v.trAddr.trim()) throw new Error("To Address is required (masquerade or an address)");
    },
  });

  editors["Destination NAT (Port Forward)"] = ruleEditor({
    page: t.pages["Destination NAT (Port Forward)"],
    what: "port forward",
    title: "Port Forward",
    getBase: () => ["nat", "destination"],
    columns: [
      { key: "in", label: "In. Iface", width: "80px", path: ["inbound-interface", "name"] },
      { key: "proto", label: "Proto", width: "60px", path: ["protocol"] },
      { key: "dst", label: "Dst. Address", width: "120px", path: ["destination", "address"] },
      { key: "dport", label: "Dst. Port", width: "80px", path: ["destination", "port"] },
      { key: "src", label: "Src. Address", width: "120px", path: ["source", "address"] },
      { key: "tr", label: "To Address", width: "120px", path: ["translation", "address"] },
      { key: "tport", label: "To Port", width: "70px", path: ["translation", "port"] },
      { key: "desc", label: "Comment", path: ["description"] },
    ],
    getFields: () => DEST_FIELDS,
    newDefaults: { protocol: "tcp" },
    intro: h("span",
      "Port forward example: In. Interface = WAN (eth0), Protocol = tcp, Dst. Port = 8080, To Address = 192.168.1.10, To Port = 80. ",
      h("b", "If your firewall forward chain drops by default, also add a Firewall → forward rule accepting the inside address/port.")),
    validate(v) {
      portNeedsProto(v);
      if (!v.trAddr.trim() && !v.trPort.trim()) throw new Error("Set To Address and/or To Port");
    },
  });

  t.select("Source NAT");
}
