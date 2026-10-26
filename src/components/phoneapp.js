// "Phone app" (web version): where to get the Android app from this server,
// and the certificate fingerprint the app shows before it trusts the server.
import QRCode from "qrcode";
import { h } from "../lib/dom.js";
import { modal } from "../lib/dialog.js";

export async function openPhoneApp() {
  let info = null;
  try {
    info = await (await fetch("/api/app/info", { credentials: "same-origin" })).json();
  } catch {
    /* shown below */
  }
  const url = `${location.origin}/vygi.apk`;
  const canvas = h("canvas.qr");
  const body = h("div", { style: { width: "460px" } });
  if (!info?.apk) {
    body.append(h("p", "This VyGi server doesn't have the Android app. The Docker image (ghcr.io/fearblade66/vygi) includes it: update with docker compose pull vygi && docker compose up -d vygi."));
  } else {
    body.append(
      h("p", "The VyGi app for Android phones: the same pages, laid out for a phone, plus notifications for alerts. It talks to this server, so it works at home and over your VPN."),
      h("ol.app-steps",
        h("li", "On the phone, open ", h("b", url), " (or scan the code) and download the app. The browser warns about the certificate; that's VyGi's own one."),
        h("li", "Open the file and allow installing apps from your browser when Android asks."),
        h("li", "Open VyGi, enter ", h("b", location.host), ", and check the fingerprint it shows matches the one below."),
        h("li", "Log in with the VyGi password. Allow notifications to get alerts on the phone.")),
      h("div.app-qr", canvas, h("div",
        h("div.hint", `Version ${info.apk.versionName || "?"} · ${(info.apk.size / 1048576).toFixed(1)} MB`),
        h("div.hint", { style: { marginTop: "10px" } }, "Certificate fingerprint (SHA-256):"),
        h("code.copy-line", info.fingerprint || "none: this server uses plain HTTP behind your own proxy"))),
    );
    QRCode.toCanvas(canvas, url, { errorCorrectionLevel: "M", width: 180, margin: 1 }).catch(() => canvas.remove());
  }
  await modal("Phone app", body, [{ label: "Close", value: "ok", primary: true }]);
}
