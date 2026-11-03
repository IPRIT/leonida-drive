// POI categories (derived from the fan-map tags in tools/map_build.py), colours and small vector icons
// (24x24 SVG path data, drawn white on a coloured disc; even-odd fill). No external assets.

export const CATEGORIES = {
  landmark: { color: '#f5b83d', on: true, en: 'Landmarks', ru: 'Достопримечательности',
    icon: 'M12 3.2l2.6 5.5 6 .7-4.4 4.1 1.2 5.9L12 16.5l-5.4 2.9 1.2-5.9-4.4-4.1 6-.7z' },
  gas: { color: '#2f9bff', on: true, en: 'Gas stations', ru: 'Заправки',
    icon: 'M5.5 3.5h8.5v17H5.5zM7.5 5.5v4.5h4.5V5.5zM15 8.2l1-1 3 3v7.3a1.9 1.9 0 0 1-3.8 0v-3.1H15v-1.6h1.8v4.7a.4.4 0 0 0 .8 0v-6.2z' },
  food: { color: '#ff8a3d', on: true, en: 'Food & drink', ru: 'Еда и напитки',
    icon: 'M6.3 3h1.3v5.2h1V3H10v5.2h1V3h1.3v6.4a2.6 2.6 0 0 1-2 2.5V21H8.3v-9.1a2.6 2.6 0 0 1-2-2.5zM15.2 3c2.2 1 3.3 3.6 3.3 6.8v3.4h-1.8V21h-1.9V3z' },
  hotel: { color: '#a45bff', on: true, en: 'Hotels', ru: 'Отели',
    icon: 'M3 19.5V5.5h2v7.5h15a1.5 1.5 0 0 1 1.5 1.5v5h-2V17H5v2.5zM8 7.2a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6zM11.5 8h6.5a2.5 2.5 0 0 1 2.5 2.5V12h-9z' },
  shop: { color: '#ff3fa4', on: true, en: 'Shops', ru: 'Магазины',
    icon: 'M5 8.5h14l-1.1 12H6.1zM8.6 8.5V7a3.4 3.4 0 0 1 6.8 0v1.5h-1.7V7a1.7 1.7 0 0 0-3.4 0v1.5z' },
  leisure: { color: '#1fbfae', on: true, en: 'Leisure & events', ru: 'Досуг и события',
    icon: 'M9 17.6a2.6 2.6 0 1 1-1.6-2.4V5.4l11-2.2v11.5a2.6 2.6 0 1 1-1.6-2.4V7.4L9 9z' },
  transport: { color: '#4f7cff', on: true, en: 'Transport', ru: 'Транспорт',
    icon: 'M6.5 3h11A2.5 2.5 0 0 1 20 5.5v11a2 2 0 0 1-1.2 1.8V21h-2.4v-2.3H7.6V21H5.2v-2.7A2 2 0 0 1 4 16.5v-11A2.5 2.5 0 0 1 6.5 3zM6.3 6v5.2h11.4V6zM7.8 13.6a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zM16.2 13.6a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z' },
  services: { color: '#5b8bd6', on: true, en: 'Public services', ru: 'Госслужбы',
    icon: 'M12 2.8l7.5 3.1v5.3c0 4.6-3.1 8.5-7.5 10-4.4-1.5-7.5-5.4-7.5-10V5.9z' },
  nature: { color: '#46a35a', on: true, en: 'Nature', ru: 'Природа',
    icon: 'M12 2.8l6.2 8.3h-3.1l4.2 5.4h-6.3V21h-2v-4.5H4.7l4.2-5.4H5.8z' },
  industry: { color: '#9a8470', on: false, en: 'Industry & utilities', ru: 'Промзоны',
    icon: 'M3 20.5V10.5l5 3v-3l5 3v-3l5 3V4h3v16.5z' },
  office: { color: '#7f8da3', on: false, en: 'Offices', ru: 'Офисы',
    icon: 'M3.5 8h17v11.5h-17zM8.8 8V6.2A1.2 1.2 0 0 1 10 5h4a1.2 1.2 0 0 1 1.2 1.2V8h-1.7V6.7h-3V8z' },
  residential: { color: '#b88a63', on: false, en: 'Residential', ru: 'Жилые дома',
    icon: 'M12 3.8l8.5 7.4h-2.6v9.3h-4.2v-5.6h-3.4v5.6H6.1v-9.3H3.5z' },
  other: { color: '#8f969e', on: false, en: 'Other places', ru: 'Другие места',
    icon: 'M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z' },
};
export const CATEGORY_IDS = Object.keys(CATEGORIES);

// irl: the fan-map marker has a real-world prototype (its own page: ?marker=<id>&irl)
export const FLAG = { enterable: 1, demolished: 2, unconfirmed: 4, closed: 8, safehouse: 16, landmark: 32, irl: 64 };

const GENERIC = /^(lake|river|canal|bridge|train bridge|train tunnel|parking lot|bus parking lot|bus stop|metro station|marina|canyon|gas station|cell tower|boat ramp|sign|pier|dock|tower|warehouse|house|store|shop|motel|hotel|restaurant|bar|church|school|park|beach)$/i;
const WATER = /\b(lake|river|canal|bay|sound|creek|inlet|lagoon|pond|harbou?r|channel|cove)\b/i;
const PEAK = /\b(mount|mt\.?|hill|mountain|peak|ridge|domed hills)\b/i;
const ISLAND = /\b(key|island|isle|islands|keys)\b/i;

export const isGeneric = (name) => !name || GENERIC.test(name.replace(/["?]/g, '').trim());

// natural feature kind of a named POI ('water' | 'peak' | 'island' | null)
export function naturalKind(p) {
  if (p.cat !== 'nature' || isGeneric(p.name)) return null;
  if (WATER.test(p.name)) return 'water';
  if (PEAK.test(p.name)) return 'peak';
  if (ISLAND.test(p.name)) return 'island';
  return 'nature';
}

// label importance 0..7
export function poiRank(p) {
  let r = p.name && !isGeneric(p.name) ? 2 : 0;
  if (p.flags & FLAG.landmark) r += 4;
  if (p.flags & FLAG.enterable) r += 1;
  if (p.flags & FLAG.safehouse) r += 1;
  if (p.flags & (FLAG.demolished | FLAG.closed)) r -= 1;
  return Math.max(0, r);
}

const pathCache = new Map();
export function iconPath(cat) {
  let p = pathCache.get(cat);
  if (!p) pathCache.set(cat, (p = new Path2D((CATEGORIES[cat] || CATEGORIES.other).icon)));
  return p;
}

export function iconSvg(cat, size = 16) {
  const c = CATEGORIES[cat] || CATEGORIES.other;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="${c.color}"/>`
    + `<path transform="translate(4.2 4.2) scale(.65)" fill="#fff" fill-rule="evenodd" d="${c.icon}"/></svg>`;
}

// draws a category marker (disc + white icon) centred at x, y with radius r (CSS px in the current transform)
export function drawMarker(ctx, cat, x, y, r, alpha = 1, ring = false) {
  const c = CATEGORIES[cat] || CATEGORIES.other;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(x, y, r + 1.6, 0, Math.PI * 2);
  ctx.fillStyle = ring ? '#ffffff' : 'rgba(8, 10, 14, 0.75)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = c.color;
  ctx.fill();
  const s = (r * 1.25) / 24;
  ctx.save();
  ctx.translate(x - 12 * s, y - 12 * s);
  ctx.scale(s, s);
  ctx.fillStyle = '#fff';
  ctx.fill(iconPath(cat), 'evenodd');
  ctx.restore();
  ctx.globalAlpha = 1;
}
