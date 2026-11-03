// Cartographic styles: palettes, LOD choice and zoom-dependent widths. Shared by the tile renderer (worker or
// main thread), the radar and the full map. Widths are CSS pixels unless noted; the renderer multiplies by dpr.

export const TILE = 512;          // tile content size (device px)
export const GUTTER = 2;          // extra pixels rendered around a tile so neighbours blend without seams
export const BASE_MPP = 0.0625;   // device metres-per-pixel of level 0
export const MAX_LEVEL = 20;      // half-octave levels: mpp(L) = BASE * 2^(L/2) -> 0.0625 .. 64 m/px
export const LINE_COMP = 1 / 0.85; // tiles are shown at 0.71..1x: widen hairlines so they average out

export const levelMpp = (L) => BASE_MPP * Math.pow(2, L / 2);
export const tileWorld = (L) => TILE * levelMpp(L);

// Tile level for a device metres-per-pixel: the coarsest level that is still at least as sharp as the screen,
// so tiles are only ever minified (never magnified beyond 1:1 device pixels).
export function levelFor(deviceMpp) {
  const L = Math.floor(2 * Math.log2(deviceMpp / BASE_MPP) + 1e-6);
  return L < 0 ? 0 : L > MAX_LEVEL ? MAX_LEVEL : L;
}

// geometry LOD (index into a0..a3 / r0..r3) for a device mpp
export function areaLod(mpp) { return mpp <= 1.6 ? 0 : mpp <= 4.5 ? 1 : mpp <= 12 ? 2 : 3; }
export function roadLod(mpp) { return mpp <= 1.6 ? 0 : mpp <= 4.5 ? 1 : mpp <= 12 ? 2 : 3; }
export const AREA_RMAX = [12, 30, 80, 200]; // corner rounding limit per area LOD (m), below the cell overlap
export function depthLod(mpp) { return mpp <= 3 ? 0 : mpp <= 10 ? 1 : 2; }
export const DEPTH_RMAX = [30, 80, 200];
// hillshade (8 m raster, smooth field): full strength when zoomed out, gone before it would be magnified > ~3x
export const shadeFade = (mpp) => Math.min(1, Math.max(0, (mpp - 2) / 1.5));

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const fadeIn = (from, to, x) => 1 - smooth(to, from, x); // 1 when x <= to, 0 when x >= from (x = mpp)

// ---------------------------------------------------------------------------------------------------------------
// Palettes. 'map' = pause-menu map (dark, GTA-inspired, Apple-Maps-clean), 'radar' = HUD minimap (a touch brighter
// and higher contrast so it reads over the 3D scene).
export const PALETTES = {
  map: {
    deep: [16, 34, 60], shallow: [38, 92, 132], // bathymetry ramp (rgb)
    water: '#10223c',
    coast: 'rgba(160, 210, 255, 0.10)',
    area: {
      land: '#2f3a33', farm: '#3c4532', wetland: '#284139', dirt: '#3d3a33', urban: '#383d45', paved: '#434852',
      park: '#2b4a33', sand: '#8c7e5d',
    },
    shade: 0.55, // hillshade strength
    building: ['#4a505c', '#525967', '#5c6474', '#687287'], // by height class
    buildingEdge: 'rgba(0, 0, 0, 0.35)',
    casing: '#101318',
    // per-class casing (outline): highways get a dark amber edge so parallel carriageways and ramps stay apart
    casingOf: { highway: '#3a2306', ramp: '#3a2306', runway: '#7b818b', taxiway: '#2a2e35' },
    bridgeCasing: '#05070a',
    bridgeTint: 0.13, // bridge decks: fill mixed this much towards white
    road: { highway: '#eea54c', ramp: '#eea54c', primary: '#d8d4c8', street: '#9ba1ab', path: '#7d6f5a', runway: '#4e535c', taxiway: '#5f646d' },
    roadHi: { highway: '#f5b95f', ramp: '#f5b95f', primary: '#efebe1', street: '#c5c9d0', path: '#94846b', runway: '#565c66', taxiway: '#686e78' }, // close-up colours
    runwayMark: 'rgba(235, 238, 242, 0.8)',
    streetFar: 0.55, // street alpha at the most zoomed-out level
  },
  radar: {
    deep: [28, 52, 82], shallow: [52, 108, 150],
    water: '#1c344f',
    coast: 'rgba(190, 225, 255, 0.12)',
    area: {
      land: '#4d5a4f', farm: '#5a6249', wetland: '#435e55', dirt: '#5b574d', urban: '#565c66', paved: '#626874',
      park: '#476d4f', sand: '#a8987a',
    },
    shade: 0.45,
    building: ['#6b717c', '#737a87', '#7d8594', '#8a93a5'],
    buildingEdge: 'rgba(0, 0, 0, 0.25)',
    casing: '#2a2f37',
    casingOf: { highway: '#1b1f25', ramp: '#1b1f25', runway: '#8f95a0', taxiway: '#3b4048' },
    bridgeCasing: '#0c0e12',
    bridgeTint: 0.0,
    road: { highway: '#f4f4f4', ramp: '#f4f4f4', primary: '#dedfe2', street: '#b9bcc2', path: '#8f8270', runway: '#6a707a', taxiway: '#767c86' },
    roadHi: { highway: '#ffffff', ramp: '#ffffff', primary: '#eceef0', street: '#cfd2d7', path: '#9d8f7a', runway: '#737985', taxiway: '#80868f' },
    runwayMark: 'rgba(245, 247, 250, 0.85)',
    streetFar: 0.7,
  },
};

// depth band colours (deep -> shallow) derived from each palette's ramp
for (const P of Object.values(PALETTES)) {
  P.depth = [];
  for (let i = 0; i < 5; i++) {
    const t = Math.pow((i + 1) / 5, 1.15);
    const c = P.deep.map((d, k) => Math.round(d + (P.shallow[k] - d) * t));
    P.depth.push(`rgb(${c[0]}, ${c[1]}, ${c[2]})`);
  }
}

// Road widths in CSS px for a CSS metres-per-pixel `cmpp`. The drawn width (from tools/map_build.py) is a
// generalised carriageway width in metres: it wins when zoomed in; further out a minimum pixel width takes over.
// `name` is a road class or 'ramp' (highway ramps / connectors). Returns [fillPx, casingPx] (casing = each side).
export const ROAD_MIN = { highway: 3.3, ramp: 1.6, primary: 1.9, street: 1.0, path: 0.8, runway: 2.4, taxiway: 0.9 };
const MINOR_GEN = { primary: 0.86, street: 0.8, path: 0.8, taxiway: 0.8 }; // minor roads thin out faster
export function roadPx(name, widthM, cmpp, radar = false) {
  // real width when zoomed in; generalised (narrower than real) further out so interchanges stay readable
  let gen = cmpp <= 1 ? 0.96 : cmpp >= 6 ? 0.6 : 0.96 - (cmpp - 1) / 5 * 0.36;
  if (cmpp > 1 && MINOR_GEN[name]) gen *= 1 - (1 - MINOR_GEN[name]) * Math.min(1, (cmpp - 1) / 2);
  const real = widthM / cmpp * (radar ? Math.min(1, gen + 0.08) : gen);
  let min = ROAD_MIN[name] ?? 1;
  if (radar) min *= name === 'highway' ? 1.12 : 1.3;
  // thin out the minimum widths on overview levels
  if (cmpp > 6) min *= name === 'highway' ? 0.9 : name === 'primary' ? 0.72 : name === 'runway' ? 1 : 0.6;
  if (cmpp > 14) min *= 0.85;
  const fill = Math.max(min * LINE_COMP, real);
  let casing = cmpp > 10 ? 0.5 : cmpp > 4 ? 0.75 : cmpp > 1.6 ? 0.95 : 1.15;
  if ((name === 'highway' || name === 'ramp') && cmpp <= 4) casing *= 1.25; // crisper carriageway edges
  return [fill, casing];
}

export function roadVisible(name, cmpp) {
  if (name === 'path') return cmpp <= 5;
  if (name === 'taxiway') return cmpp <= 6;
  if (name === 'ramp') return cmpp <= 11;
  if (name === 'street') return cmpp <= 34;
  if (name === 'primary') return cmpp <= 80;
  return true;
}

// draw order of road groups inside one level (low first). Casings of a level are all drawn before its fills,
// so roads of the same level join without seams; higher levels (overpasses, bridges) cover lower ones.
export const ROAD_ORDER = { runway: 0, path: 1, taxiway: 2, street: 3, primary: 4, ramp: 5, highway: 6 };

export const BUILDING_MAX_CMPP = 2.6;
export const heightClass = (hDm) => (hDm < 80 ? 0 : hDm < 200 ? 1 : hDm < 600 ? 2 : 3);

// mix two '#rrggbb' colours
export function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}
