// VyOS's error messages in plain words. VyOS answers a refused change with
// its own output ("[ service dhcp-server ] DHCP range "0" stop address not
// within shared-network ... Commit failed"); this says what it means and what
// to do. The original text is kept under it. Pure.

/** [pattern, (match, text) => plain explanation] in order: the first match wins. */
const RULES = [
  [/Configuration path: \[(.+?)\] is not valid/, (m) =>
    `This VyOS version has no setting "${m[1]}". It may be named differently in your version, or need a newer VyOS. Nothing was changed.`],
  [/Error: (.+?) is not a valid (.+)/, (m) =>
    `VyOS didn't accept "${m[1]}": it isn't a valid ${m[2].replace(/\.$/, "")}. Check the format (an address looks like 192.168.1.1/24). Nothing was changed.`],
  [/Value validation failed|Invalid value/, () =>
    "VyOS didn't accept one of the values: check its format (addresses like 192.168.1.1/24, names with only letters, digits and dashes). Nothing was changed."],
  [/DHCP range "?\w*"? (start|stop) address not within/, (m) =>
    `The DHCP range's ${m[1] === "start" ? "first" : "last"} address isn't inside the network. Both ends of the range have to be addresses of that network. Nothing was changed.`],
  [/DHCP range .*must be greater or equal/, () =>
    "The DHCP range ends before it starts: the last address has to come after the first. Nothing was changed."],
  [/(?:range|pool).*overlap|overlaps? .*range/i, () =>
    "Two DHCP ranges overlap: each address can only be handed out by one range. Nothing was changed."],
  [/static-mapping|static mapping/i, () =>
    "A fixed address (DHCP reservation) clashes: two devices can't share an address, and it has to be inside its network. Nothing was changed."],
  [/translation requires address/, () =>
    "A NAT rule needs an address to translate to (or \"masquerade\" for internet sharing). Nothing was changed."],
  [/already (?:assigned|in use|used|exists)|is already/i, () =>
    "Something in this change is already in use (an address, a port or a name). Pick another one. Nothing was changed."],
  [/(?:interface|Interface) .*(?:does not exist|not found)|No such device/, () =>
    "The change names an interface that doesn't exist on this router. Check the port names in Advanced → Interfaces. Nothing was changed."],
  [/(?:mandatory|must be (?:set|configured|defined)|is required|requires? .* to be (?:set|configured))/i, (m, text) =>
    `A required setting is missing: ${firstLine(text, m.index)}. Nothing was changed.`],
  [/locked|another (?:user|session)|commit in progress|configuration session/i, () =>
    "Someone else is changing the router's settings right now (another VyGi window, or a login on the router). Wait a moment and try again."],
  [/[Cc]onnection refused/, () =>
    "The router refused the connection: its web API (or SSH) isn't running, or listens on another port. Check that the router is on and that \"service https api\" is set up."],
  [/No route to host|Network is unreachable|Host is unreachable/i, () =>
    "VyGi can't reach the router: it isn't answering at that address. Check the cable or network, or whether a recent change (a forward or a firewall rule) cuts VyGi off."],
  [/timed out|timeout/i, () =>
    "The router took too long to answer. It may be busy (a big change or an update), restarting, or unreachable."],
  [/certificate|TLS|SSL/, () =>
    "The router's HTTPS certificate isn't the one VyGi saw before. If you reinstalled the router, that's expected: forget it and add it again. Otherwise someone may be in between."],
];

const RAW = /Commit failed|Set failed|Configuration path:|Value validation failed|Invalid value|^\[ .+ \]$|os error|error sending request|error trying to connect|tcp connect error|certificate verify failed/m;

/** The line of text around index i, without VyOS's markers. */
function firstLine(text, i) {
  const start = text.lastIndexOf("\n", i) + 1;
  const end = text.indexOf("\n", i);
  return text.slice(start, end < 0 ? undefined : end).trim().replace(/\.$/, "");
}

/** Plain explanation for a VyOS / connection error, or null when there's nothing to add. */
export function explainError(text) {
  const t = String(text || "");
  // only VyOS's own output and low-level connection errors; VyGi's messages are plain already
  if (!RAW.test(t)) return null;
  for (const [re, say] of RULES) {
    const m = t.match(re);
    if (m) return say(m, t);
  }
  // Refused without a reason: name the part of the settings it was about.
  const sect = t.match(/\[\[\s*([^\]]+?)\s*\]\] failed/) || t.match(/^\[ ([^\]]+) \]/m);
  if (sect && /Commit failed/.test(t)) {
    const what = sect[1].trim();
    return `VyOS refused the change to "${what}" without saying why. Usually a required part is missing (for a VPN: its private key or a peer's public key; for DHCP: both ends of the range; for a firewall rule: its action) or a group or name it refers to doesn't exist. Nothing was changed. Advanced → ${hint(what)} shows these settings.`;
  }
  if (/Set failed/.test(t)) return "VyOS didn't accept this setting. Nothing was changed.";
  return null;
}

function hint(path) {
  if (/^firewall/.test(path)) return "Firewall";
  if (/^nat/.test(path)) return "Firewall → NAT";
  if (/dhcp/.test(path)) return "IP → DHCP Server";
  if (/wireguard/.test(path)) return "VPN";
  if (/^interfaces/.test(path)) return "Interfaces";
  return "Full Configuration";
}

/** The explanation followed by the original text, or the original alone. */
export function withExplanation(text) {
  const plain = explainError(text);
  return plain ? `${plain}\n\nVyOS said:\n${String(text).trim()}` : String(text);
}
