// Small line icons (24x24, stroke = currentColor), drawn for VyGi.
const P = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  clients: '<rect x="2" y="4" width="14" height="10" rx="1.5"/><path d="M6 18h6M9 14v4"/><rect x="17" y="8" width="5" height="12" rx="1.2"/><path d="M19.5 17.5h0"/>',
  networks: '<rect x="9" y="2.5" width="6" height="5" rx="1"/><rect x="2.5" y="16.5" width="6" height="5" rx="1"/><rect x="15.5" y="16.5" width="6" height="5" rx="1"/><path d="M12 7.5v4M5.5 16.5v-2.5h13v2.5"/>',
  rules: '<path d="M12 2.5 4 5.5v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10v-6z"/><path d="M12 8v4l2.5 1.5"/>',
  advanced: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  terminal: '<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="m7 9 3 3-3 3M12.5 15H17"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/><circle cx="12" cy="12" r="6.5"/>',
  window: '<rect x="3" y="5" width="14" height="12" rx="1.5"/><path d="M7 5V3.5A1.5 1.5 0 0 1 8.5 2H20a1.5 1.5 0 0 1 1.5 1.5V14a1.5 1.5 0 0 1-1.5 1.5h-3"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/>',
  save: '<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  shield: '<path d="M12 2.5 4 5.5v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10v-6z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  router: '<rect x="2.5" y="13" width="19" height="7" rx="2"/><path d="M6 16.5h.01M9.5 16.5h.01M8 13l-2-6M16 13l2-6M14.8 5.2a4 4 0 0 0-5.6 0"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  ok: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  wifi: '<path d="M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0M12 19h.01"/>',
  forward: '<path d="M3 12h13M12 7l5 5-5 5"/><path d="M20 4v16"/>',
  vpn: '<path d="M12 2.5 4 5.5v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10v-6z"/><rect x="9" y="11" width="6" height="5" rx="1"/><path d="M10.5 11V9.5a1.5 1.5 0 0 1 3 0V11"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
};

/** <svg> element for an icon name; size in px. */
export function icon(name, size = 18) {
  const span = document.createElement("span");
  span.className = `ic ic-${name}`;
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || P.info}</svg>`;
  return span;
}

/** The VyGi mark: a rounded tile with a routed "V". */
export function logo(size = 28) {
  const span = document.createElement("span");
  span.className = "logo";
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
    <defs><linearGradient id="vg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f8cff"/><stop offset="1" stop-color="#0050d8"/></linearGradient></defs>
    <rect width="32" height="32" rx="8" fill="url(#vg)"/>
    <path d="M8.5 9.5 16 23l7.5-13.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="8.5" cy="9.5" r="2.2" fill="#fff"/><circle cx="23.5" cy="9.5" r="2.2" fill="#fff"/><circle cx="16" cy="23" r="2.2" fill="#fff"/>
  </svg>`;
  return span;
}
