// Original line icons (24×24, stroke = currentColor).
const P = {
  car: '<path d="M5 16.5H3.6a1 1 0 0 1-1-1v-2.7l2.6-1.1 2.9-3.9h7.2l3.4 3.9 2.5.8v3a1 1 0 0 1-1 1H19"/><path d="M9 16.5h6"/><path d="M8 11.7h10"/><circle cx="7" cy="16.5" r="2"/><circle cx="17" cy="16.5" r="2"/>',
  sport: '<path d="M5 16H3a.8.8 0 0 1-.8-.8v-1.8l3.5-1.4L10 9.5h4.5l4.6 2.7 2.4.6v2.4a.8.8 0 0 1-.8.8H19"/><path d="M9 16h6"/><circle cx="7" cy="16" r="2"/><circle cx="17" cy="16" r="2"/>',
  suv: '<path d="M5 17H3.5a1 1 0 0 1-1-1v-4l2-1 1.5-4.5h10.5L19 11l2.5.8V16a1 1 0 0 1-1 1H19"/><path d="M9 17h6"/><path d="M5 11h14"/><path d="M11.5 6.5V11"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>',
  pickup: '<path d="M5 16.5H3.5a1 1 0 0 1-1-1v-3.5L5 11l2-4h5.5v5H21.5v3.5a1 1 0 0 1-1 1H19"/><path d="M9 16.5h6"/><circle cx="7" cy="16.5" r="2"/><circle cx="17" cy="16.5" r="2"/>',
  van: '<path d="M5 17H3.5a1 1 0 0 1-1-1V7a1.5 1.5 0 0 1 1.5-1.5h11.5L21.5 11v5a1 1 0 0 1-1 1H19"/><path d="M9 17h6"/><path d="M15.5 5.5V11h6"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>',
  service: '<path d="M5 17H3.6a1 1 0 0 1-1-1v-2.7l2.6-1.1 2.9-3.9h7.2l3.4 3.9 2.5.8v3a1 1 0 0 1-1 1H19"/><path d="M9 17h6"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M10 5.5h4"/><path d="M12 3v1"/><path d="M8.2 3.8l.7.7M15.8 3.8l-.7.7"/>',
  truck: '<path d="M2.5 5.5h11v11h-11z"/><path d="M13.5 9h4l3.5 4v3.5h-7.5"/><circle cx="6.5" cy="17.5" r="2"/><circle cx="17" cy="17.5" r="2"/>',
  bus: '<rect x="3" y="3.5" width="18" height="13.5" rx="2"/><path d="M3 10h18"/><path d="M12 3.5V10"/><circle cx="7.5" cy="18.5" r="1.6"/><circle cx="16.5" cy="18.5" r="1.6"/>',
  small: '<path d="M3.5 13.5h17"/><path d="M6 13.5 8 8h7l2.5 5.5"/><path d="M8 8V5.5h7.5"/><circle cx="6.5" cy="17" r="2.5"/><circle cx="17.5" cy="17" r="2.5"/>',
  motorcycle: '<circle cx="5" cy="16" r="3"/><circle cx="19" cy="16" r="3"/><path d="M5 16l4.5-5.5h5L19 16"/><path d="M9.5 10.5 8 7.5H6"/><path d="M14.5 10.5l2-3.5h2.5"/>',
  bicycle: '<circle cx="5.5" cy="16" r="3.5"/><circle cx="18.5" cy="16" r="3.5"/><path d="M5.5 16 9 9h7l2.5 7"/><path d="M9 9l3.5 7L16 9"/><path d="M7.5 6.5h3"/><path d="M15 6.5h2.5L16 9"/>',
  heli: '<path d="M3 4.5h18"/><path d="M12 4.5v3.5"/><path d="M4.5 12a5.5 4 0 0 1 11 0 5.5 4 0 0 1-11 0z"/><path d="M15.5 11.5h6l.8-2"/><path d="M5 19h11"/><path d="M8 16v3M13 16v3"/>',
  plane: '<path d="M12 2.6c.8 0 1.3.8 1.3 1.8v5.2l7.7 4.6v2l-7.7-2.4v4.4l2.2 1.7v1.6L12 20.6l-3.5.9v-1.6l2.2-1.7v-4.4L3 16.2v-2l7.7-4.6V4.4c0-1 .5-1.8 1.3-1.8z"/>',
  boat: '<path d="M3 13.5h18l-2.6 5H5.6z"/><path d="M7 13.5V9.5h6.5l3.5 4"/><path d="M10 9.5V5"/><path d="M2 21.5c2 0 2-1 4-1s2 1 4 1 2-1 4-1 2 1 4 1 2-1 4-1"/>',
  pin: '<path d="M12 21.5s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0c0 5-6.5 11.2-6.5 11.2z"/><circle cx="12" cy="10.2" r="2.4"/>',
  money: '<rect x="2.5" y="6" width="19" height="12" rx="1.5"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9v.01M18 15v.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  partly: '<path d="M8 3v1.5M3 8h1.5M4.5 4.5l1 1M11.5 4.5l-1 1"/><path d="M5.6 10.6A3.5 3.5 0 0 1 11.7 7"/><path d="M8.5 19.5h9a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6.9A3.1 3.1 0 0 0 8.5 19.5z"/>',
  cloud: '<path d="M7 18.5h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.5 1.1A3.5 3.5 0 0 0 7 18.5z"/>',
  lightRain: '<path d="M7 14.5h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.5 1.1A3.5 3.5 0 0 0 7 14.5z"/><path d="M9 17.5l-1 3M15 17.5l-1 3"/>',
  heavyRain: '<path d="M7 13.5h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.5 1.1A3.5 3.5 0 0 0 7 13.5z"/><path d="M7.5 16l-1.5 4.5M11 16l-1.5 4.5M14.5 16 13 20.5M18 16l-1.5 4.5"/>',
  storm: '<path d="M7 13.5h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.5 1.1A3.5 3.5 0 0 0 7 13.5z"/><path d="M12.5 13.5 10 17.5h3.5L11 21.5"/>',
  fog: '<path d="M4 8.5h16M2.5 12.5h19M5 16.5h14M8 20.5h8"/>',
  auto: '<path d="M4 12a8 8 0 0 1 13.7-5.6"/><path d="M20 12a8 8 0 0 1-13.7 5.6"/><path d="M18 3v4h-4"/><path d="M6 21v-4h4"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  user: '<circle cx="12" cy="7.5" r="4"/><path d="M4 21v-1.5A5.5 5.5 0 0 1 9.5 14h5a5.5 5.5 0 0 1 5.5 5.5V21"/>',
  info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 11v6M12 7.5v.01"/>',
  star: '<path d="M12 2.8l2.8 5.8 6.4.9-4.6 4.5 1.1 6.4L12 17.4l-5.7 3 1.1-6.4-4.6-4.5 6.4-.9z"/>',
  globe: '<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19"/><path d="M12 2.5a14.5 14.5 0 0 1 0 19 14.5 14.5 0 0 1 0-19z"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21.2l8.8-8.8a5.5 5.5 0 0 0 0-7.8z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 15H6L5 6"/>',
  clock: '<circle cx="12" cy="12" r="9.5"/><path d="M12 6.5V12l3.5 2"/>',
  gamepad: '<path d="M6.5 7.5h11a4.5 4.5 0 0 1 4.4 5.4l-.9 4.4a2.5 2.5 0 0 1-4.3 1.2L14.5 16h-5l-2.2 2.5A2.5 2.5 0 0 1 3 17.3l-.9-4.4a4.5 4.5 0 0 1 4.4-5.4z"/><path d="M7.5 10.5v3M6 12h3"/><path d="M15.5 11.5v.01M18 12.5v.01"/>',
  keyboard: '<rect x="2" y="5.5" width="20" height="13" rx="2"/><path d="M6 9.5h.01M10 9.5h.01M14 9.5h.01M18 9.5h.01M6 13h.01M18 13h.01M8 15.5h8"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7.5 16v-4M12 16V8M16.5 16v-6"/>',
  map: '<path d="M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20.5 20.5 15.2 15.2"/>',
  bolt: '<path d="M13 2.5 4 13.5h7l-1 8 9-11h-7z"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  skull: '<path d="M12 2.5a8 8 0 0 0-8 8c0 3 1.6 5.3 4 6.6V20.5h8v-3.4c2.4-1.3 4-3.6 4-6.6a8 8 0 0 0-8-8z"/><circle cx="9" cy="11" r="1.6"/><circle cx="15" cy="11" r="1.6"/><path d="M11 20.5v-2M13 20.5v-2"/>',
  gravity: '<circle cx="12" cy="6.5" r="3"/><path d="M12 12.5v8M8.5 17l3.5 3.5 3.5-3.5"/>',
  tank: '<path d="M3.5 14.5h17l-1.5 4.5H5z"/><path d="M6 14.5V11h9l2 3.5"/><path d="M10 11V8.5h4.5V11"/><path d="M14.5 9.5h7"/><circle cx="7.5" cy="17" r=".8"/><circle cx="12" cy="17" r=".8"/><circle cx="16.5" cy="17" r=".8"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><path d="M12 14.5v2.5"/>',
  flame: '<path d="M12 21.5c-3.9 0-6.5-2.6-6.5-6.2 0-3.4 2.6-5.6 3.6-8.8.4 1.7 1.3 2.9 2.4 3.6.3-2.8 1.4-5.4 3.3-7.6.1 3.3 1.3 5.2 2.4 7 .9 1.4 1.3 2.8 1.3 4.1 0 4.5-2.7 7.9-6.5 7.9z"/><path d="M12 21.5c-1.7 0-2.8-1.2-2.8-2.8 0-1.8 1.6-2.6 2.2-4.2.9 1.2 3.4 2.1 3.4 4.4 0 1.6-1.1 2.6-2.8 2.6z"/>',
  extinguisher: '<path d="M8.5 9.5h7v11a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1z"/><path d="M10 9.5V6.5h4v3"/><path d="M14 7.5h3l2.5-2"/><path d="M10 6.5 7 4.5"/><path d="M8.5 13.5h7"/>',
  neon: '<path d="M4 13.5h16l-1.5-4.5h-13z"/><circle cx="7.5" cy="15.5" r="1.8"/><circle cx="16.5" cy="15.5" r="1.8"/><path d="M3 20h18" stroke-dasharray="2 2.2"/>',
  tint: '<path d="M4 18.5 7 6.5h10l3 12z"/><path d="M8 18.5 10.5 6.5M13 18.5l2.5-12"/>',
  horn: '<path d="M3.5 10v4h3l7 4.5v-13l-7 4.5z"/><path d="M16.5 9a4.5 4.5 0 0 1 0 6M18.8 6.5a8 8 0 0 1 0 11"/>',
  spray: '<rect x="7" y="9.5" width="7" height="12" rx="1"/><path d="M8.5 9.5V6.5h4v3"/><path d="M10 4.5h1.5"/><path d="M16.5 5v.01M19 4v.01M18.5 7.5v.01M21 6v.01M20.5 9.5v.01"/>',
  scissors: '<circle cx="6.5" cy="6.5" r="2.5"/><circle cx="6.5" cy="17.5" r="2.5"/><path d="M8.6 8 20 18.5M8.6 16 20 5.5"/>',
  beard: '<path d="M5 7.5v3.5c0 4.5 3.2 8.5 7 8.5s7-4 7-8.5V7.5"/><path d="M8 13.5c1.2.9 2.5 1.3 4 1.3s2.8-.4 4-1.3"/><path d="M9.5 11h5"/>',
  shirt: '<path d="M8.5 3.5 4 6l-1.5 5 3 1 1-2.5V20.5h11V9.5l1 2.5 3-1L20 6l-4.5-2.5c-.5 1.5-1.8 2.5-3.5 2.5s-3-1-3.5-2.5z"/>',
  jacket: '<path d="M8.5 3.5 4 6l-1.5 5 3 1 1-2.5V20.5h11V9.5l1 2.5 3-1L20 6l-4.5-2.5"/><path d="M8.5 3.5 12 9l3.5-5.5M12 9v11.5"/><path d="M9 14h1M14 14h1"/>',
  pants: '<path d="M6.5 3.5h11l1 17h-4.5L12 10l-2 10.5H5.5z"/><path d="M6.5 6.5h11"/>',
  shoe: '<path d="M3 16.5V8h5l1.5 3.5 7.5 1.8c2.2.5 4 1.6 4 3.2v.5H3z"/><path d="M3 19h18"/><path d="M11 12l1-1.8M13.5 12.6l1-1.8"/>',
  cap: '<path d="M4.5 14.5a7.5 7.5 0 0 1 15 0z"/><path d="M12 7v-.5"/><path d="M14.5 14.5h7"/>',
  glasses: '<circle cx="6.5" cy="13.5" r="3.5"/><circle cx="17.5" cy="13.5" r="3.5"/><path d="M10 13c1.3-.8 2.7-.8 4 0"/><path d="M3 13 2 8.5M21 13l1-4.5"/>',
  watch: '<rect x="7" y="7" width="10" height="10" rx="2.5"/><path d="M9 7V3h6v4M9 17v4h6v-4"/><path d="M12 10v2.2l1.5 1"/>',
  tattoo: '<path d="M12 21s-7-4.3-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.7-7 10-7 10z"/><path d="M9.5 11.5h5M12 9v5"/>',
  hanger: '<path d="M12 7.5a2 2 0 1 1 2-2"/><path d="M12 7.5v1.5L3 15.5a1 1 0 0 0 .6 1.8h16.8a1 1 0 0 0 .6-1.8L12 9"/>',
  idcard: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><circle cx="8.5" cy="11" r="2.3"/><path d="M5 16.5c.6-1.6 2-2.5 3.5-2.5s2.9.9 3.5 2.5"/><path d="M14.5 10h4.5M14.5 13.5h3.5"/>',
  insure: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
};

const FILLED = { starFill: P.star };

export const CATEGORY_ICON = {
  compact: 'car', sedan: 'car', coupe: 'car', sports: 'sport', super: 'sport', muscle: 'car', classic: 'car', suv: 'suv',
  pickup: 'pickup', van: 'van', luxury: 'car', service: 'service', trucks: 'truck', buses: 'bus', small: 'small',
  motorcycles: 'motorcycle', bicycles: 'bicycle', helicopters: 'heli', planes: 'plane', boats: 'boat', military: 'tank', other: 'car',
};

export const MAP_SOURCE = { name: 'State of Leonida', url: 'https://map.stateofleonida.net/', host: 'map.stateofleonida.net' };

export function mapSourceLink(text = MAP_SOURCE.host) {
  return `<a class="srclink" href="${MAP_SOURCE.url}" target="_blank" rel="noopener">${text}</a>`;
}

export function icon(name, cls = '') {
  if (FILLED[name]) return `<svg class="ico fill ${cls}" viewBox="0 0 24 24" aria-hidden="true">${FILLED[name]}</svg>`;
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || P.info}</svg>`;
}
