// Set up your router, before VyGi can reach it: shown on the welcome page while
// no router is saved. A new VyOS has no address and no SSH, so the first few
// commands go on its console; VyGi writes them for the address you choose.
// After connecting, "Set up this router" (setup.js) takes over.
import { api } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { consoleCommands } from "../lib/firstrun.js";
import { copyBox } from "./apiaccess.js";

/** The guide, filled in when no router is saved yet (empty otherwise). connect({ host, user }). */
export function firstRunGuide(connect) {
  const el = h("div.firstrun");
  api.listRouters().then((routers) => {
    if (!routers.length) render(el, connect);
  }).catch(() => {});
  return el;
}

function render(el, connect) {
  const f = {
    cidr: h("input", { type: "text", value: "192.168.1.2/24", placeholder: "192.168.1.2/24" }),
    gw: h("input", { type: "text", value: "192.168.1.1", placeholder: "192.168.1.1" }),
    port: h("input", { type: "text", value: "eth0", placeholder: "eth0" }),
  };
  const out = h("div");
  const go = h("button.primary", "Connect");
  let ip = "";
  const update = () => {
    const r = consoleCommands({ cidr: f.cidr.value.trim(), gw: f.gw.value.trim(), port: f.port.value.trim() });
    const box = r.error ? h("div.err-box", r.error) : copyBox(r.text);
    box.querySelector?.("textarea")?.setAttribute("rows", "9");
    clear(out).append(box);
    ip = r.ip || "";
    go.disabled = !ip;
    go.textContent = ip ? `Connect to ${ip}` : "Connect";
  };
  for (const i of Object.values(f)) i.addEventListener("input", update);
  go.addEventListener("click", () => connect({ host: ip, user: "vyos" }));
  update();
  const step = (n, title, ...body) => h("li.firstrun-step", h("div.firstrun-n", String(n)), h("div.grow", h("b", title), ...body));
  clear(el).append(h("section.card.firstrun-card",
    h("h3", "Set up your router"),
    h("p.hint", "New to VyOS, or starting over? These are the only steps on the router itself; VyGi does the rest."),
    h("ol.firstrun-steps",
      step(1, "Install VyOS",
        h("ul",
          h("li", "Start the router from the VyOS installer (ISO or USB stick) and log in as ", h("code", "vyos"), " / ", h("code", "vyos"), "."),
          h("li", "Run ", h("code", "install image"), ", accept the defaults, and choose a new password for vyos (keep it: you'll need it below)."),
          h("li", "Proxmox: remove the installer (Hardware → CD/DVD Drive → Do not use any media) and boot from the disk (Options → Boot Order). Real hardware: unplug the USB stick. Then restart."),
          h("li", "Without this step nothing survives a restart: the router comes back empty."))),
      step(2, "Give it an address and SSH",
        h("p.hint", "Pick an address on your network that nothing else uses (outside your main router's DHCP range, or reserved there)."),
        h("div.form.firstrun-form",
          h("label", "Router address"), f.cidr,
          h("label", "Gateway"), f.gw,
          h("label", "Port"), f.port),
        h("p.hint", "Log in on the router's console again and type these (Copy, then paste or type them line by line):"),
        out),
      step(3, "Connect VyGi",
        h("p.hint", "Log in with vyos and the password from step 1, and leave the API key empty: VyGi turns the API on for you."),
        go),
      step(4, "Finish in VyGi",
        h("p.hint", "Set up this router opens by itself: VyGi's own login with an SSH key, the security check, saving, backups and alerts.")))));
}
