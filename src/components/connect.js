// Login window: saved routers, credentials, and "trust this router?" prompts.
import { api, errorText } from "../lib/api.js";
import { h, clear, setStatus } from "../lib/dom.js";
import { modal, confirmBox, alertBox } from "../lib/dialog.js";
import { setConnected, refreshTx } from "../lib/session.js";
import { runCheckup } from "./checkup.js";

export async function showConnectDialog() {
  const routers = await api.listRouters().catch(() => []);

  const f = {
    host: h("input", { type: "text", placeholder: "192.168.1.1 or router.lan" }),
    name: h("input", { type: "text", placeholder: "(optional)" }),
    apiPort: h("input", { type: "number", value: 443, min: 1, max: 65535 }),
    sshPort: h("input", { type: "number", value: 22, min: 1, max: 65535 }),
    sshUser: h("input", { type: "text", value: "vyos" }),
    sshPassword: h("input", { type: "password" }),
    apiKey: h("input", { type: "password" }),
    remember: h("input", { type: "checkbox", checked: true }),
  };
  const savedHint = h("span.hint");
  const errBox = h("div.err-box", { hidden: true });

  const list = h("div.saved-list");
  const fill = async (p) => {
    f.host.value = p.host;
    f.name.value = p.name;
    f.apiPort.value = p.apiPort;
    f.sshPort.value = p.sshPort;
    f.sshUser.value = p.sshUser;
    f.sshPassword.value = "";
    f.apiKey.value = "";
    const has = await api.hasSavedSecrets(`${p.sshUser}@${p.host}`).catch(() => false);
    savedHint.textContent = has ? "Password and API key are saved in the OS keychain. Leave empty to use them." : "";
  };
  const renderList = () => {
    clear(list);
    if (!routers.length) list.append(h("div.hint", { style: { padding: "4px" } }, "No saved routers yet."));
    for (const p of routers) {
      const row = h(
        "div.tree-node",
        { on: { click: () => { list.querySelectorAll(".sel").forEach((x) => x.classList.remove("sel")); row.classList.add("sel"); fill(p); } } },
        h("span", { style: { display: "inline-block", width: "45%" } }, p.name || p.host),
        h("span.hint", `${p.sshUser}@${p.host}`),
        h("button", {
          style: { float: "right", padding: "0 5px" },
          title: "Forget this router and delete its saved secrets",
          on: {
            click: async (e) => {
              e.stopPropagation();
              if (!(await confirmBox("Forget router", `Remove ${p.host} and its saved password/API key?`, "Remove"))) return;
              await api.forgetRouter(`${p.sshUser}@${p.host}`).catch((err) => alertBox("Error", errorText(err)));
              routers.splice(routers.indexOf(p), 1);
              renderList();
            },
          },
        }, "✕"),
      );
      list.append(row);
    }
  };
  renderList();
  if (routers.length) fill(routers[0]);

  const content = h(
    "div",
    { style: { width: "460px" } },
    h("div.hint", "Saved routers"),
    list,
    errBox,
    h(
      "div.form",
      h("label", "Connect To"), f.host,
      h("label", "Name"), f.name,
      h("label", "Login"), f.sshUser,
      h("label", "Password"), f.sshPassword,
      h("label", "API Key"), f.apiKey,
      h("span"), savedHint,
      h("label", "HTTPS Port"), f.apiPort,
      h("label", "SSH Port"), f.sshPort,
      h("span"), h("label", { style: { textAlign: "left" } }, f.remember, " Remember password and key (OS keychain)"),
    ),
    h("div.hint", { style: { marginTop: "8px" } },
      "Router needs: `set service https api keys id vygi key <KEY>` and `set service https api rest`, plus SSH enabled (`set service ssh`)."),
  );

  const trust = { tls: null, ssh: null };
  let connected = null;
  await modal("Connect to VyOS", content, [
    { label: "Cancel", value: "cancel" },
    { label: "Connect", value: "connect", primary: true },
  ], async () => {
    errBox.hidden = true;
    const req = () => ({
      profile: {
        name: f.name.value.trim(),
        host: f.host.value.trim(),
        apiPort: Number(f.apiPort.value) || 443,
        sshPort: Number(f.sshPort.value) || 22,
        sshUser: f.sshUser.value.trim() || "vyos",
      },
      apiKey: f.apiKey.value,
      sshPassword: f.sshPassword.value,
      remember: f.remember.checked,
      trustTls: trust.tls,
      trustSsh: trust.ssh,
    });
    // Up to two trust prompts (HTTPS certificate, then SSH key) can come back.
    for (let attempt = 0; attempt < 3; attempt++) {
      setStatus(`Connecting to ${f.host.value}…`);
      try {
        connected = await api.connect(req());
        setConnected(connected);
        setStatus(`Connected to ${connected.hostname}.`);
        return true;
      } catch (e) {
        const accepted = await handleTrust(e, trust);
        if (accepted) continue;
        errBox.textContent = errorText(e);
        errBox.hidden = false;
        setStatus("Connection failed.", true);
        return false;
      }
    }
    return false;
  });
  if (!connected) return;
  if (connected.revertAction !== "reload") await warnRevertAction();
  await runCheckup();
}

/** Asks the user about an unknown or changed fingerprint. Returns true if accepted. */
async function handleTrust(e, trust) {
  const kind = e && e.kind;
  if (!["UntrustedCert", "CertMismatch", "UntrustedHostKey", "HostKeyMismatch"].includes(kind)) return false;
  const isTls = kind.startsWith("Untrusted") ? kind === "UntrustedCert" : kind === "CertMismatch";
  const changed = kind.endsWith("Mismatch");
  const what = isTls ? "HTTPS certificate" : "SSH host key";
  const body = h(
    "div",
    { style: { width: "480px" } },
    changed
      ? h("div.err-box", `WARNING: the ${what} is different from the one saved for this router. If you did not reinstall the router or replace its certificate, someone may be intercepting the connection. Do not continue.`)
      : h("div.warn-box", `First connection to this router. Check that this ${what} fingerprint matches the router before trusting it.`),
    changed ? h("div", h("b", "Previously trusted:"), h("div.fp", e.expected)) : null,
    h("div", { style: { marginTop: "6px" } }, h("b", "Presented now:"), h("div.fp", e.fingerprint)),
    h("div.hint", { style: { marginTop: "8px" } },
      isTls
        ? "On the router: run `show pki certificate` or `openssl x509 -in /etc/ssl/certs/... -noout -fingerprint -sha256` to compare."
        : "On the router console: run `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` (or the matching key type) to compare."),
  );
  const r = await modal(changed ? `${what} changed!` : `Trust this router's ${what}?`, body, [
    { label: "Cancel", value: "cancel", primary: changed },
    { label: changed ? "Trust new key anyway" : "Trust", value: "trust", primary: !changed },
  ]);
  if (r !== "trust") return false;
  if (isTls) trust.tls = e.fingerprint;
  else trust.ssh = e.fingerprint;
  return true;
}

async function warnRevertAction() {
  const ok = await confirmBox(
    "Safe Mode will REBOOT this router",
    "This router is set to REBOOT when an unconfirmed Safe Mode change times out (the VyOS default).\n\n" +
      "Recommended: switch to 'reload', which restores the previous config without rebooting.\n\n" +
      "This runs: set system config-management commit-confirm action reload",
    "Switch to reload",
  );
  if (!ok) return;
  try {
    await api.setRevertAction("reload");
    await refreshTx();
    setStatus("Safe Mode revert action set to reload. Remember to Save.");
  } catch (e) {
    alertBox("Could not change setting", errorText(e));
  }
}
