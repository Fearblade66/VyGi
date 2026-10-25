// "Report for Claude": one Markdown file describing the router (health,
// networks, rules, security findings, recent alerts and the configuration
// with secrets removed) to attach to a chat with Claude for a review.
import { api, errorText } from "../lib/api.js";
import { setStatus } from "../lib/dom.js";
import { alertBox, confirmBox } from "../lib/dialog.js";
import { session } from "../lib/session.js";
import { saveText } from "../lib/platform.js";
import { redact } from "../lib/redact.js";
import { readNetworks } from "../lib/netplan.js";
import { parseRules, describeSchedule } from "../lib/trafficrules.js";
import { parseForwards } from "../lib/portfwd.js";
import { parseRegions } from "../lib/regions.js";
import { loadFindings } from "./security.js";
import { formatBytes } from "../lib/dom.js";

const safe = (p) => p.catch(() => null);

export async function openClaudeReport() {
  if (!session.info) return alertBox("Report for Claude", "Connect to a router first.");
  const ok = await confirmBox("Report for Claude",
    "Makes a file describing this router for Claude to review: health, networks, rules, security findings, recent alerts and the full configuration.\n\nPasswords, keys and secrets are removed. It still contains your network layout, addresses and device names, so only share it where you're comfortable.",
    "Make the report");
  if (!ok) return;
  setStatus("Building the report…");
  try {
    const [cfg, load, info, stats, routes, leases, findings] = await Promise.all([
      api.getConfig([]),
      safe(api.systemLoad()),
      safe(api.systemInfo()),
      safe(api.interfaceStats()),
      safe(api.routes(4, "default")),
      safe(api.dhcpLeases(4)),
      safe(loadFindings()),
    ]);
    const def = (routes || []).find((r) => r.dst === "default");
    const wan = def?.dev || def?.nexthops?.[0]?.dev || "";
    const i = session.info;
    const lines = [];
    const add = (...l) => lines.push(...l);
    add(`# VyGi report: ${i.hostname}`, "", `Made ${new Date().toISOString()} by VyGi. Passwords, keys and secrets are removed.`, "",
      "Please review this VyOS router's setup: point out problems, risks and improvements, and explain them simply.", "");
    add("## Router", "", `- VyOS ${i.version}`, `- Internet interface: ${wan || "unknown"} (default route via ${def?.gateway || "?"})`);
    if (load) add(`- Uptime: ${Math.round((load.uptimeSecs || 0) / 3600)} h, load ${(load.load || []).join(" / ")}, memory free ${load.memTotalKb ? Math.round((load.memAvailableKb / load.memTotalKb) * 100) : "?"}%`);
    if (info?.cpuModel) add(`- CPU: ${info.cpuModel} (${info.cpus} threads)`);
    add("");
    if (stats?.links) {
      add("## Interfaces", "", "| Interface | State | Addresses | Received | Sent |", "|---|---|---|---|---|");
      for (const l of stats.links) {
        const ips = (stats.addrs || []).filter((a) => a.ifname === l.ifname).flatMap((a) => a.addr_info || []).map((x) => `${x.local}/${x.prefixlen}`).join(", ");
        add(`| ${l.ifname} | ${l.operstate} | ${ips} | ${formatBytes(l.stats64?.rx?.bytes || 0)} | ${formatBytes(l.stats64?.tx?.bytes || 0)} |`);
      }
      add("");
    }
    const nets = readNetworks(cfg || {}, wan);
    if (nets.length) {
      add("## Networks", "");
      for (const n of nets) add(`- ${n.name} (${n.iface}): ${n.network}, DHCP ${n.dhcp ? `${n.dhcp.start}-${n.dhcp.stop}` : "off"}, internet ${n.internet ? "allowed" : "blocked"}${n.isolated ? ", isolated" : ""}`);
      add("", `DHCP leases right now: ${Array.isArray(leases) ? leases.length : "?"}`, "");
    }
    const rules = parseRules(cfg || {});
    const regions = parseRegions(cfg || {});
    if (rules.length || regions.countries.length) {
      add("## Traffic rules", "");
      for (const r of rules) add(`- ${r.name}: ${r.block === "sites" ? `blocks ${r.domains.join(", ")}` : "blocks the internet"} for ${r.targets.kind}, ${describeSchedule(r.schedule)}${r.enabled ? "" : " (paused)"}`);
      if (regions.countries.length) add(`- Region blocking: ${regions.countries.join(", ")}`);
      add("");
    }
    const fwds = parseForwards(cfg || {});
    if (fwds.length) {
      add("## Port forwards", "");
      for (const f of fwds) add(`- ${f.name}: ${f.protocol} ${f.outside} → ${f.ip}:${f.inside}${f.from ? ` (only from ${f.from})` : ""}${f.enabled ? "" : " (paused)"}`);
      add("");
    }
    add("## Security check (VyGi)", "");
    if (findings?.length) for (const f of findings) add(`- **${f.title}**: ${f.text}`);
    else add("- No common problems found.");
    add("");
    let alerts = [];
    try {
      alerts = (JSON.parse(localStorage.getItem(`vygi.alerts.${i.profileId}`)) || {}).log || [];
    } catch {
      /* none */
    }
    if (alerts.length) {
      add("## Recent alerts", "");
      for (const a of alerts.slice(0, 30)) add(`- ${new Date(a.at).toISOString()}: ${a.text}`);
      add("");
    }
    add("## Configuration (secrets removed)", "", "```json", JSON.stringify(redact(cfg || {}), null, 2), "```", "");
    const name = `vygi-report-${i.hostname.replace(/[^A-Za-z0-9._-]/g, "_")}-${new Date().toISOString().slice(0, 10)}.md`;
    const where = await saveText(name, lines.join("\n"), [{ name: "Markdown", extensions: ["md"] }]);
    if (where) setStatus(`Report saved: ${where}. Attach it in a chat with Claude.`);
    else setStatus("");
  } catch (e) {
    alertBox("Report for Claude", errorText(e));
  }
}
