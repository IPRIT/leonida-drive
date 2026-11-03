// Original inline SVG icons for the touch controls (24×24, stroke = currentColor). No external assets.
const P = {
  gas: '<rect x="7.5" y="2.5" width="9" height="19" rx="3"/><path d="M10.5 7h3M10.5 11h3M10.5 15h3"/>',
  brake: '<rect x="3.5" y="7" width="17" height="11" rx="3"/><path d="M8 10.5v4M12 10.5v4M16 10.5v4"/>',
  handbrake: '<circle cx="12" cy="12" r="6.5"/><path d="M10.4 15.5v-7h2.4a2.1 2.1 0 0 1 0 4.2h-2.4"/><path d="M4.2 6.5a9.5 9.5 0 0 0 0 11M19.8 6.5a9.5 9.5 0 0 1 0 11"/>',
  nitro: '<path d="M13.5 2.5 5.5 13.5h6l-1.5 8 8.5-11.5h-6z" class="f"/>',
  exit: '<path d="M4 20.5V5l8.5-2.5v18z"/><path d="M12.5 4.5H16v4M16 15.5v4h-3.5"/><path d="M14 12h7.5M18.5 9l3 3-3 3"/>',
  enter: '<path d="M4 20.5V5l8.5-2.5v18z"/><path d="M12.5 4.5H16v4M16 15.5v4h-3.5"/><path d="M21.5 12H14M17 9l-3 3 3 3"/>',
  horn: '<path d="M3 9.5v5h3.5l6.5 4.5v-14L6.5 9.5z"/><path d="M16.2 9.2a4 4 0 0 1 0 5.6M18.8 6.6a7.6 7.6 0 0 1 0 10.8"/>',
  lights: '<path d="M11.5 5.5C7 5.5 4 8.4 4 12s3 6.5 7.5 6.5z"/><path d="M14.5 7h6.5M14.5 10.3h6.5M14.5 13.7h6.5M14.5 17h6.5"/>',
  camera: '<path d="M3.5 8h3.5l2-2.5h6L17 8h3.5v11h-17z"/><circle cx="12" cy="13.2" r="3.4"/>',
  lookback: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><path d="M12.5 9.5 10 12l2.5 2.5M10 12h5.5"/>',
  radio: '<rect x="3" y="9" width="18" height="11" rx="2"/><path d="M7 9l10-5"/><circle cx="8.5" cy="14.5" r="2.4"/><path d="M14 13h4M14 16h4"/>',
  jump: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4.5 20h15"/>',
  dive: '<path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5"/><path d="M3 19.5c2 0 2.2-1.5 4.5-1.5s2.5 1.5 4.5 1.5 2.2-1.5 4.5-1.5 2.5 1.5 4.5 1.5"/>',
  flip: '<path d="M4.5 11a7.5 7.5 0 0 1 13-4.6L19.5 9"/><path d="M19.5 4v5h-5"/><path d="M19.5 13a7.5 7.5 0 0 1-13 4.6L4.5 15"/><path d="M4.5 20v-5h5"/>',
  menu: '<path d="M4.5 7h15M4.5 12h15M4.5 17h15"/>',
  map: '<path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20z"/><path d="M9 4v13.5M15 6.5V20"/>',
  gear: '<path d="M12 3v7.5M8 5.5h8"/><circle cx="12" cy="15.5" r="4.5"/><circle cx="12" cy="15.5" r="1.2"/>',
  flaps: '<path d="M2.5 10h13l5.5 2H2.5z"/><path d="M14.5 13.5l5 4"/>',
  assist: '<circle cx="12" cy="12" r="9"/><path d="M8.5 16.5 12 7.5l3.5 9M9.8 13.4h4.4"/>',
  smoke: '<path d="M7 15.5a3 3 0 1 1 .8-5.9A4.2 4.2 0 0 1 16 8.8a3.2 3.2 0 1 1 1 6.7z"/><path d="M4 19.5h3M10 19.5h9"/>',
  left: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  right: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  up: '<path d="M5.5 15 12 8.5l6.5 6.5"/>',
  down: '<path d="M5.5 9 12 15.5 18.5 9"/>',
  boost: '<path d="M5 6l6 6-6 6M12 6l6 6-6 6"/>',
  freecam: '<path d="M3.5 8h3.5l2-2.5h6L17 8h3.5v11h-17z"/><path d="M9.5 11l5 5M14.5 11l-5 5"/>',
  freefly: '<path d="M3.5 8h3.5l2-2.5h6L17 8h3.5v11h-17z"/><path d="M12 10.2v6M9 13.2h6"/>', // free camera on
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  tilt: '<rect x="7" y="3" width="10" height="18" rx="2" transform="rotate(-18 12 12)"/><path d="M3 20.5a11 11 0 0 1 3-7M21 3.5a11 11 0 0 1-3 7"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  // tank: main gun (crosshair) and gunner's sight (magnifier)
  fire: '<circle cx="12" cy="12" r="7"/><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"/><circle cx="12" cy="12" r="1.8" class="f"/>',
  sight: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.4 15.4 21 21M10.5 7.6v5.8M7.6 10.5h5.8"/>',
  // photo mode: aperture blades; panel toggle (sliders)
  photo: '<circle cx="12" cy="12" r="9"/><path d="M12 8.4 20.9 13.5M15.1 10.2v10.2M15.1 13.8 6.2 18.9M12 15.6 3.1 10.5M8.9 13.8V3.6M8.9 10.2 17.8 5.1"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  // CONTROLS tab legend (analog touch controls): steering slider, camera drag, sprint (stick pushed past its edge),
  // plane throttle lever
  slider: '<path d="M2.5 12h19M2.5 9v6M21.5 9v6"/><circle cx="12" cy="12" r="4" class="f"/>',
  swipe: '<circle cx="12" cy="12" r="2.4" class="f"/><path d="M3.5 12h4.5M16 12h4.5M6 9.5 3.5 12 6 14.5M18 9.5l2.5 2.5-2.5 2.5M12 3.5V8M12 16v4.5M9.5 6 12 3.5 14.5 6M9.5 18l2.5 2.5 2.5-2.5"/>',
  sprint: '<circle cx="12" cy="13" r="8"/><circle cx="12" cy="5.5" r="3.2" class="f"/>',
  throttle: '<rect x="8" y="2.5" width="8" height="19" rx="2.5"/><path d="M8 10.5h8"/><path d="M5 18V6M19 18V6" opacity=".5"/>',
};

export function icon(name, cls = '') {
  return `<svg class="tc-ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
}

// Animated phone for the "rotate your device" screen.
export const PHONE_SVG = `<svg class="tc-phone" viewBox="0 0 120 120" aria-hidden="true">
  <g class="tc-phone-body"><rect x="38" y="14" width="44" height="92" rx="9"/><path d="M53 22h14"/><circle cx="60" cy="96" r="3"/></g>
  <path class="tc-phone-arc" d="M22 74a40 40 0 0 1 16-46M98 46a40 40 0 0 1-16 46"/>
  <path class="tc-phone-arc" d="M33 26l5 2-1 5M87 94l-5-2 1-5"/>
</svg>`;
