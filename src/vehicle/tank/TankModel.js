// Procedural main battle tank ("Ironwood Mastodon"): hull, skirts, running gear, scrolling tread loops, turret
// with a pitching / recoiling gun. Model space: origin on the ground under the hull centre, -Z forward, +X right.
import * as THREE from 'three';
import { box, cyl, tube, bar, slab, plate, warp, rotate, translate, concat, toGeometry } from '../design/geom.js';

/** Shared dimensions (physics + visuals). */
export const TANK = {
  trackX: 1.45, trackW: 0.62, th: 0.07,
  rwR: 0.36, rwY: 0.43, rwZ: [-2.58, -1.72, -0.86, 0, 0.86, 1.72, 2.58],
  idler: [-3.36, 0.62, 0.28], sprocket: [3.32, 0.66, 0.3],
  rollers: [-1.75, 0, 1.75], rollerR: 0.09,
  deckY: 1.66, front: -3.95, rear: 3.72, width: 3.66, height: 2.78, length: 7.67,
  turret: [0, 1.66, 0.28], // ring centre (turret pivot)
  trunnion: [0, 0.44, -1.86], // gun pivot in turret space
  muzzle: 5.62, // muzzle distance from the trunnion along the bore
  sight: [0.95, 1.12, -1.15], // gunner's sight (turret space)
  seat: [-0.05, 0.72, -2.15],
  hatch: [-0.05, 1.66, -2.0],
  // rigid body origin above the ground at rest (model space y = body y + originY); keeps the body centre inside
  // the hull like the cars' wheel-centre origin, which other systems (ground safety net, blast distances) expect
  originY: 0.9,
};

const TAU = Math.PI * 2;
const PITCH = 0.36; // tread texture repeat (two links)

// ---------- textures (created once, shared; GPU upload is per source) ----------
let TREAD = null, FLASH_TEX = null;
function canvasOk() { return typeof document !== 'undefined' && !!document.createElement; }

function treadTexture() {
  if (TREAD || !canvasOk()) return TREAD;
  const c = document.createElement('canvas');
  c.width = 32; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#3b3a37'; g.fillRect(0, 0, 32, 64);
  for (let k = 0; k < 2; k++) {
    const y = k * 32;
    g.fillStyle = '#26251f'; g.fillRect(0, y + 1, 32, 3); // gap between links
    g.fillStyle = '#4c4a44'; g.fillRect(1, y + 6, 30, 9); // grouser
    g.fillStyle = '#6a6760'; g.fillRect(1, y + 6, 30, 2); // worn edge
    g.fillStyle = '#2c2b27'; g.fillRect(1, y + 13, 30, 2);
    g.fillStyle = '#55524b'; g.fillRect(13, y + 18, 6, 10); // guide horn / pad
    g.fillStyle = '#1e1d1a'; g.fillRect(0, y + 4, 3, 26); g.fillRect(29, y + 4, 3, 26); // end connectors
  }
  TREAD = new THREE.CanvasTexture(c);
  TREAD.wrapS = THREE.ClampToEdgeWrapping;
  TREAD.wrapT = THREE.RepeatWrapping;
  TREAD.colorSpace = THREE.SRGBColorSpace;
  TREAD.magFilter = THREE.LinearFilter;
  TREAD.anisotropy = 4;
  return TREAD;
}

function flashTexture() {
  if (FLASH_TEX || !canvasOk()) return FLASH_TEX;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.25, 'rgba(255,220,150,0.95)');
  r.addColorStop(0.6, 'rgba(255,130,40,0.45)');
  r.addColorStop(1, 'rgba(255,80,10,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  FLASH_TEX = new THREE.CanvasTexture(c);
  FLASH_TEX.colorSpace = THREE.SRGBColorSpace;
  return FLASH_TEX;
}

/** Materials of one tank (created at spawn, never at runtime). */
export function createTankMaterials(color = 0xc2a878) {
  const std = (p) => new THREE.MeshStandardMaterial({ flatShading: true, ...p });
  const tex = treadTexture();
  const track = () => {
    const m = std({ color: tex ? 0xffffff : 0x34332f, roughness: 0.82, metalness: 0.35 });
    if (tex) { m.map = tex.clone(); m.map.needsUpdate = true; }
    return m;
  };
  const ft = flashTexture();
  return {
    paint: std({ color, roughness: 0.82, metalness: 0.12 }),
    trim: std({ color: 0x3d403c, roughness: 0.68, metalness: 0.4 }),
    dark: std({ color: 0x17191a, roughness: 0.85, metalness: 0.2 }),
    tire: std({ color: 0x1b1b1a, roughness: 0.95, metalness: 0.0 }),
    glass: std({ color: 0x1b2d36, roughness: 0.12, metalness: 0.7 }),
    canvas: std({ color: 0x55593d, roughness: 0.95, metalness: 0.0 }),
    head: std({ color: 0xf5f2e8, emissive: 0xfff2d6, emissiveIntensity: 0.1, roughness: 0.15, metalness: 0.2 }),
    tail: std({ color: 0x4a0306, emissive: 0xff0a14, emissiveIntensity: 0.2, roughness: 0.25, metalness: 0.1 }),
    trackL: track(),
    trackR: track(),
    flash: new THREE.MeshBasicMaterial({
      color: 0xffd9a0, map: ft || null, transparent: true, opacity: 1, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }),
  };
}

// ---------- helpers ----------
class Bucket {
  constructor() { this.m = {}; }
  add(mat, a) { if (a && a.length) (this.m[mat] ||= []).push(a); return a; }
  pair(mat, fn) { this.add(mat, fn(1)); this.add(mat, fn(-1)); }
  build(parent, mats, o = {}) {
    const out = [];
    for (const k of Object.keys(this.m)) {
      const mesh = new THREE.Mesh(toGeometry(concat(this.m[k])), mats[k]);
      mesh.name = k;
      mesh.castShadow = o.shadow !== false;
      mesh.receiveShadow = o.receive !== false;
      parent.add(mesh);
      out.push(mesh);
    }
    return out;
  }
}

// convex hull (monotone chain) of [z, y] points, counter-clockwise
function hull2(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 1e-9) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 1e-9) up.pop(); up.push(q); }
  up.pop(); lo.pop();
  return lo.concat(up);
}

/** Inner/outer tread loop in the side plane: { inner:[[z,y]], outer:[[z,y]], s:[] (outer arc length), len }. */
export function trackLoop(lod = 'high') {
  const T = TANK;
  const n = lod === 'low' ? 10 : 22;
  const pts = [];
  const circle = (z, y, r) => { for (let i = 0; i < n; i++) { const a = (i / n) * TAU; pts.push([z + Math.cos(a) * r, y + Math.sin(a) * r]); } };
  circle(T.idler[0], T.idler[1], T.idler[2]);
  circle(T.sprocket[0], T.sprocket[1], T.sprocket[2]);
  for (const z of T.rwZ) circle(z, T.rwY, T.rwR);
  const h = hull2(pts);
  // subdivide long straight runs (the lower run follows the road wheels per frame)
  const inner = [];
  const maxSeg = lod === 'low' ? 0.8 : 0.22;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.ceil(L / maxSeg));
    for (let j = 0; j < k; j++) inner.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
  }
  // outward normals (CCW: edge normal = (ty, -tz))
  const N = inner.length, outer = [];
  for (let i = 0; i < N; i++) {
    const p = inner[(i - 1 + N) % N], c = inner[i], q = inner[(i + 1) % N];
    let nz = 0, ny = 0;
    for (const [a, b] of [[p, c], [c, q]]) {
      const tz = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tz, ty) || 1;
      nz += ty / l; ny += -tz / l;
    }
    const l = Math.hypot(nz, ny) || 1;
    outer.push([c[0] + (nz / l) * T.th, c[1] + (ny / l) * T.th]);
  }
  const s = [0];
  for (let i = 1; i <= N; i++) { const a = outer[i - 1], b = outer[i % N]; s.push(s[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  return { inner, outer, s, len: s[N] };
}

// tread ribbon around the loop at track centre x (positions + uvs, outward-facing)
function trackRibbon(loop, xc) {
  const T = TANK;
  const { inner, outer, s, len } = loop;
  const N = inner.length;
  const reps = Math.max(1, Math.round(len / PITCH));
  const vk = reps / len;
  const x0 = xc - T.trackW / 2, x1 = xc + T.trackW / 2;
  const P = [], U = [];
  const quad = (a, b, c, d, ua, ub, uc, ud) => { P.push(...a, ...b, ...c, ...a, ...c, ...d); U.push(...ua, ...ub, ...uc, ...ua, ...uc, ...ud); };
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    const o0 = outer[i], o1 = outer[j], i0 = inner[i], i1 = inner[j];
    const v0 = s[i] * vk, v1 = s[i + 1] * vk;
    // outer tread face, inner face (reversed), side walls
    quad([x0, o0[1], o0[0]], [x1, o0[1], o0[0]], [x1, o1[1], o1[0]], [x0, o1[1], o1[0]], [0, v0], [1, v0], [1, v1], [0, v1]);
    quad([x0, i1[1], i1[0]], [x1, i1[1], i1[0]], [x1, i0[1], i0[0]], [x0, i0[1], i0[0]], [0, v1], [1, v1], [1, v0], [0, v0]);
    quad([x1, i0[1], i0[0]], [x1, i1[1], i1[0]], [x1, o1[1], o1[0]], [x1, o0[1], o0[0]], [0.98, v0], [0.98, v1], [1, v1], [1, v0]);
    quad([x0, o0[1], o0[0]], [x0, o1[1], o1[0]], [x0, i1[1], i1[0]], [x0, i0[1], i0[0]], [0, v0], [0, v1], [0.02, v1], [0.02, v0]);
  }
  const pos = new Float32Array(P);
  // make the first outer quad face outward (+normal away from the loop centre)
  const ax = pos[3] - pos[0], ay = pos[4] - pos[1], az = pos[5] - pos[2];
  const bx = pos[6] - pos[0], by = pos[7] - pos[1], bz = pos[8] - pos[2];
  const ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const cz = (T.idler[0] + T.sprocket[0]) / 2, cy = 0.55;
  const oz = outer[0][0] - cz, oy = outer[0][1] - cy;
  if (ny * oy + nz * oz < 0) {
    for (let i = 0; i < pos.length; i += 9) {
      for (let k = 0; k < 3; k++) { const t = pos[i + 3 + k]; pos[i + 3 + k] = pos[i + 6 + k]; pos[i + 6 + k] = t; }
    }
    for (let i = 0; i < U.length; i += 6) { let t = U[i + 2]; U[i + 2] = U[i + 4]; U[i + 4] = t; t = U[i + 3]; U[i + 3] = U[i + 5]; U[i + 5] = t; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.computeVertexNormals();
  return g;
}

// dual road wheel around the X axis (paint dishes + hubs, rubber tyres)
function roadWheelGeo(lod) {
  const seg = lod === 'low' ? 10 : 18;
  const paint = [], rubber = [];
  for (const sx of [-1, 1]) {
    const x = sx * 0.165;
    rubber.push(cyl(TANK.rwR, TANK.rwR, 0.13, seg, x, 0, 0, 'x'));
    paint.push(cyl(0.305, 0.305, 0.145, seg, x, 0, 0, 'x'));
    paint.push(cyl(0.12, 0.15, 0.06, 8, x + sx * 0.09, 0, 0, 'x'));
  }
  paint.push(cyl(0.08, 0.08, 0.36, 8, 0, 0, 0, 'x'));
  return { paint: concat(paint), rubber: concat(rubber) };
}

function sprocketGeo(lod) {
  const seg = lod === 'low' ? 10 : 16;
  const a = [];
  const r = TANK.sprocket[2];
  for (const sx of [-1, 1]) {
    const x = sx * 0.17;
    a.push(cyl(r - 0.03, r - 0.03, 0.08, seg, x, 0, 0, 'x'));
    const teeth = lod === 'low' ? 0 : 11;
    for (let i = 0; i < teeth; i++) {
      const t = (i / teeth) * TAU;
      a.push(box(0.08, 0.1, 0.09, x, Math.sin(t) * (r + 0.02), Math.cos(t) * (r + 0.02), -t, 0, 0));
    }
  }
  a.push(cyl(0.16, 0.16, 0.5, seg, 0, 0, 0, 'x'));
  a.push(cyl(0.1, 0.12, 0.08, 8, 0.29, 0, 0, 'x'));
  return concat(a);
}

function idlerGeo(lod) {
  const seg = lod === 'low' ? 10 : 16;
  const a = [];
  for (const sx of [-1, 1]) a.push(cyl(TANK.idler[2], TANK.idler[2], 0.13, seg, sx * 0.165, 0, 0, 'x'));
  a.push(cyl(0.11, 0.11, 0.46, 8, 0, 0, 0, 'x'));
  return concat(a);
}

// ---------- hull ----------
function buildHull(B, lamps, lod) {
  const T = TANK;
  const hi = lod !== 'low';
  // lower hull between the tracks (sloped lower front plate), upper hull over the tracks
  B.add('paint', slab([[-3.38, 0.45], [3.3, 0.45], [3.62, 0.82], [3.62, 1.12], [-3.9, 1.12]], -1.06, 1.06, 0.03));
  B.add('paint', slab([[-3.95, 1.07], [3.7, 1.07], [3.72, 1.58], [3.56, 1.66], [-2.5, 1.66], [-3.95, 1.17]], -1.8, 1.8, 0.04));
  // glacis armour plate overlay (slightly proud) + seam
  B.add('paint', warp(box(3.2, 0.05, 1.5, 0, 0, 0), (v) => { const t = (v.z + 0.75) / 1.5; v.set(v.x, 1.17 + t * 0.49 + v.y + 0.03, -3.92 + t * 1.42); }));
  B.add('trim', box(3.4, 0.03, 0.04, 0, 1.665, -2.48));
  // side skirts: panels with gaps, heavier front panel
  const panels = [[-3.62, -2.5], [-2.46, -1.3], [-1.26, -0.1], [-0.06, 1.1], [1.14, 2.3], [2.34, 3.05]];
  B.pair('paint', (sx) => {
    const a = [];
    for (let i = 0; i < panels.length; i++) {
      const [z0, z1] = panels[i];
      const y0 = i === 0 ? 0.5 : 0.6, t = i === 0 ? 0.085 : 0.05;
      const pts = i === 0 ? [[z0 + 0.25, y0], [z1, y0], [z1, 1.1], [z0, 1.1], [z0, y0 + 0.28]] : [[z0, y0], [z1, y0], [z1, 1.1], [z0, 1.1]];
      a.push(slab(pts, sx * 1.79 - t / 2, sx * 1.79 + t / 2, 0.012));
      if (hi) for (const bz of [z0 + 0.15, z1 - 0.15]) a.push(box(0.03, 0.04, 0.04, sx * (1.79 + t / 2), 0.95, bz));
    }
    return concat(a);
  });
  // mud flaps + fender lips
  B.pair('dark', (sx) => box(0.6, 0.36, 0.03, sx * T.trackX, 0.88, -3.86));
  B.pair('trim', (sx) => box(0.05, 0.05, 6.9, sx * 1.83, 1.1, -0.28));
  // turret ring, driver hatch ring and periscopes
  B.add('dark', cyl(1.24, 1.26, 0.07, hi ? 28 : 14, T.turret[0], T.deckY + 0.03, T.turret[2]));
  B.add('trim', cyl(0.36, 0.38, 0.06, hi ? 14 : 8, T.hatch[0], T.deckY + 0.02, T.hatch[2] - 0.32));
  for (const dx of [-0.32, 0, 0.32]) B.add('glass', box(0.2, 0.09, 0.08, T.hatch[0] + dx, T.deckY + 0.06, T.hatch[2] - 0.78, -0.25, 0, 0));
  // engine deck grilles
  for (const sx of [-1, 1]) {
    B.add('dark', box(1.3, 0.04, 1.25, sx * 0.85, T.deckY + 0.01, 2.75));
    if (hi) for (let k = 0; k < 6; k++) B.add('trim', box(1.26, 0.03, 0.05, sx * 0.85, T.deckY + 0.035, 2.2 + k * 0.22));
  }
  B.add('paint', box(0.5, 0.06, 1.3, 0, T.deckY + 0.02, 2.75));
  // rear: exhaust grille, tow hooks, stowage, tail lamps
  B.add('dark', box(2.3, 0.3, 0.05, 0, 1.3, 3.7));
  if (hi) for (let k = 0; k < 4; k++) B.add('trim', box(2.26, 0.025, 0.06, 0, 1.18 + k * 0.08, 3.72));
  B.pair('trim', (sx) => box(0.12, 0.18, 0.2, sx * 0.85, 0.75, 3.68));
  B.pair('paint', (sx) => box(0.5, 0.32, 0.9, sx * 1.42, T.deckY + 0.16, 3.0));
  B.pair('trim', (sx) => box(0.52, 0.04, 0.92, sx * 1.42, T.deckY + 0.33, 3.0));
  // front: tow hooks, spare track links, headlight guards, mirrors of a modern MBT omitted
  B.pair('trim', (sx) => box(0.14, 0.16, 0.22, sx * 0.8, 0.95, -3.86));
  if (hi) for (let k = 0; k < 5; k++) B.add('dark', box(0.55, 0.1, 0.16, -1.2 + k * 0.6, 0.86, -3.66, 0.85, 0, 0));
  for (const sx of [-1, 1]) {
    const x = sx * 1.42, y = 1.57, z = -2.78;
    B.add('trim', box(0.34, 0.24, 0.24, x, y, z + 0.06));
    if (hi) {
      B.add('trim', bar([x - 0.2, y - 0.12, z - 0.14], [x - 0.2, y + 0.16, z - 0.14], 0.03, 0.03));
      B.add('trim', bar([x + 0.2, y - 0.12, z - 0.14], [x + 0.2, y + 0.16, z - 0.14], 0.03, 0.03));
      B.add('trim', bar([x - 0.2, y + 0.16, z - 0.14], [x + 0.2, y + 0.16, z - 0.14], 0.03, 0.03));
    }
    lamps.push({ kind: 'head', name: sx < 0 ? 'headL' : 'headR', geo: box(0.22, 0.14, 0.04, x, y, z - 0.07) });
    lamps.push({ kind: 'tail', name: sx < 0 ? 'tailL' : 'tailR', geo: box(0.2, 0.1, 0.04, sx * 1.52, 1.46, 3.74) });
  }
  // track tensioner housings and final drives (visible behind the skirts' ends)
  B.pair('trim', (sx) => cyl(0.2, 0.2, 0.32, hi ? 10 : 6, sx * 1.0, T.sprocket[1], T.sprocket[0], 'x'));
  B.pair('trim', (sx) => cyl(0.14, 0.14, 0.3, hi ? 10 : 6, sx * 1.02, T.idler[1], T.idler[0], 'x'));
  // return rollers
  const loop = trackLoop(lod);
  const topAt = (z) => {
    let best = -Infinity;
    const p = loop.inner;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      if ((a[0] - z) * (b[0] - z) <= 0 && a[0] !== b[0]) { const t = (z - a[0]) / (b[0] - a[0]); best = Math.max(best, a[1] + (b[1] - a[1]) * t); }
    }
    return best;
  };
  B.pair('tire', (sx) => concat(T.rollers.map((z) => cyl(T.rollerR, T.rollerR, 0.36, hi ? 10 : 6, sx * T.trackX, topAt(z) - T.rollerR, z, 'x'))));
  return loop;
}

// ---------- turret (turret space: origin at the ring centre on the deck) ----------
function buildTurret(B, lod) {
  const hi = lod !== 'low';
  const H = 0.8;
  const plan = [[-0.62, -2.02], [0.62, -2.02], [1.52, -1.45], [1.8, -0.35], [1.74, 1.3], [1.5, 2.36], [-1.5, 2.36], [-1.74, 1.3], [-1.8, -0.35], [-1.52, -1.45]];
  // sloped sides: inset the roof, push the front wedge back as it rises
  B.add('paint', warp(plate(plan, 0.02, H, 0.03), (v) => {
    const t = Math.max(0, Math.min(1, v.y / H));
    v.x *= 1 - 0.07 * t;
    if (v.z < -1.0) v.z += 0.22 * t * Math.min(1, (-1.0 - v.z) / 1.0);
    if (v.z > 2.0) v.z -= 0.08 * t;
  }));
  B.add('dark', cyl(1.22, 1.22, 0.08, hi ? 24 : 12, 0, 0.0, 0.1));
  // roof plates, sight, cupola, hatches
  B.add('trim', box(2.2, 0.025, 0.03, 0, H + 0.01, -0.6));
  const S = TANK.sight;
  B.add('paint', box(0.4, 0.36, 0.58, S[0], H + 0.18, S[2]));
  B.add('glass', box(0.3, 0.2, 0.03, S[0], H + 0.2, S[2] - 0.3));
  B.add('trim', box(0.44, 0.04, 0.62, S[0], H + 0.37, S[2]));
  // commander cupola with vision blocks (right rear)
  const cx = 0.72, cz = 0.55;
  B.add('paint', cyl(0.4, 0.42, 0.22, hi ? 16 : 8, cx, H + 0.11, cz));
  const nb = hi ? 7 : 0;
  for (let i = 0; i < nb; i++) {
    const a = (i / nb) * TAU;
    B.add('glass', box(0.14, 0.08, 0.04, cx + Math.sin(a) * 0.4, H + 0.15, cz + Math.cos(a) * 0.4, 0, a, 0));
  }
  B.add('trim', cyl(0.32, 0.33, 0.06, hi ? 14 : 8, cx, H + 0.25, cz));
  B.add('trim', box(0.1, 0.05, 0.12, cx, H + 0.29, cz + 0.32));
  // commander's independent sight on a short mast
  B.add('trim', cyl(0.07, 0.07, 0.24, 8, -0.3, H + 0.12, 0.05));
  B.add('paint', box(0.32, 0.3, 0.34, -0.3, H + 0.39, 0.05));
  B.add('glass', box(0.22, 0.14, 0.03, -0.3, H + 0.41, -0.13));
  // loader hatch + pintle machine gun (left)
  B.add('trim', cyl(0.33, 0.34, 0.06, hi ? 14 : 8, -0.78, H + 0.03, 0.75));
  B.add('dark', cyl(0.04, 0.05, 0.36, 6, -1.12, H + 0.18, 0.55));
  B.add('dark', box(0.12, 0.12, 0.7, -1.12, H + 0.42, 0.42));
  B.add('dark', tube([-1.12, H + 0.44, 0.08], [-1.12, H + 0.44, -0.55], 0.025, 0.025, 6));
  B.add('canvas', box(0.18, 0.16, 0.26, -1.0, H + 0.36, 0.5));
  // smoke grenade dischargers on the front cheeks
  for (const sx of [-1, 1]) {
    B.add('trim', box(0.24, 0.12, 0.42, sx * 1.6, 0.48, -1.0));
    const n = hi ? 4 : 2;
    for (let k = 0; k < n; k++) {
      const z = -1.14 + k * 0.1;
      const p0 = [sx * 1.6, 0.56, z], p1 = [sx * (1.6 + 0.12), 0.56 + 0.22, z - 0.1];
      B.add('dark', tube(p0, p1, 0.04, 0.04, 6));
    }
  }
  // side stowage boxes and the rear bustle rack
  for (const sx of [-1, 1]) {
    B.add('paint', box(0.16, 0.42, 1.25, sx * 1.79, 0.42, 0.85));
    B.add('trim', box(0.18, 0.03, 1.27, sx * 1.79, 0.64, 0.85));
  }
  if (hi) {
    const rails = [[-1.45, 2.36], [-1.45, 2.85], [1.45, 2.85], [1.45, 2.36]];
    for (const y of [0.22, 0.62]) for (let i = 0; i < 3; i++) B.add('trim', bar([rails[i][0], y, rails[i][1]], [rails[i + 1][0], y, rails[i + 1][1]], 0.04, 0.04));
    for (const [x, z] of [[-1.45, 2.85], [-0.5, 2.85], [0.5, 2.85], [1.45, 2.85]]) B.add('trim', bar([x, 0.18, z], [x, 0.66, z], 0.04, 0.04));
  }
  B.add('canvas', box(1.1, 0.42, 0.42, -0.6, 0.42, 2.6));
  B.add('canvas', box(0.9, 0.36, 0.42, 0.75, 0.4, 2.6));
  B.add('canvas', cyl(0.18, 0.18, 0.9, 8, 0.3, 0.72, 2.62, 'x'));
  // antennas and a wind sensor
  for (const sx of [-1, 1]) {
    B.add('trim', cyl(0.05, 0.06, 0.08, 6, sx * 1.25, H + 0.04, 1.85));
    B.add('dark', tube([sx * 1.25, H + 0.08, 1.85], [sx * 1.25, H + 2.05, 1.95], 0.014, 0.008, 4));
  }
  B.add('trim', cyl(0.02, 0.02, 0.4, 4, 0.2, H + 0.2, 1.7));
  B.add('dark', box(0.08, 0.06, 0.08, 0.2, H + 0.42, 1.7));
}

// gun (barrel space: origin at the trunnion, bore along -Z). Mantlet pitches with the gun; the tube recoils.
function buildGun(Bm, Br, lod) {
  const hi = lod !== 'low';
  const seg = hi ? 12 : 8;
  Bm.add('paint', warp(box(1.16, 0.62, 0.46, 0, 0, -0.22), (v) => { if (v.z < -0.3) { v.x *= 0.88; v.y *= 0.9; } }));
  Bm.add('trim', cyl(0.21, 0.23, 0.32, seg, 0, 0, -0.6, 'z'));
  Bm.add('glass', box(0.16, 0.12, 0.03, 0.4, 0.14, -0.46));
  const L = TANK.muzzle;
  Br.add('paint', tube([0, 0, -0.5], [0, 0, -2.0], 0.13, 0.12, seg));
  Br.add('paint', tube([0, 0, -2.0], [0, 0, -L + 0.45], 0.1, 0.085, seg));
  if (hi) for (const z of [-1.2, -2.4, -3.95]) Br.add('trim', cyl(0.122, 0.122, 0.05, seg, 0, 0, z, 'z'));
  Br.add('paint', tube([0, 0, -2.9], [0, 0, -3.5], 0.15, 0.15, seg)); // bore evacuator
  Br.add('trim', tube([0, 0, -2.86], [0, 0, -2.92], 0.13, 0.15, seg));
  Br.add('trim', tube([0, 0, -3.5], [0, 0, -3.56], 0.15, 0.12, seg));
  // muzzle brake with side ports
  Br.add('trim', box(0.3, 0.24, 0.44, 0, 0, -L + 0.22));
  if (hi) for (const z of [-L + 0.1, -L + 0.3]) Br.add('dark', box(0.32, 0.14, 0.08, 0, 0, z));
}

/**
 * Build a tank model.
 * @param {{color?: number, lod?: 'high'|'low', materials?: object}} o
 * @returns model with groups (root, hull, turret, barrel, recoil, muzzle, flash, hatch), running gear and materials
 */
export function buildTankModel(o = {}) {
  const lod = o.lod || 'high';
  const hi = lod !== 'low';
  const T = TANK;
  const mats = o.materials || createTankMaterials(o.color);
  const root = new THREE.Group();
  root.name = 'tank';
  const hull = new THREE.Group();
  hull.name = 'hull';
  root.add(hull);

  const HB = new Bucket();
  const lamps = [];
  const loop = buildHull(HB, lamps, lod);
  const hullMeshes = HB.build(hull, mats);

  // lamps: separate breakable meshes
  const lampMeshes = {};
  for (const l of lamps) {
    const m = new THREE.Mesh(toGeometry(l.geo), mats[l.kind]);
    m.name = l.name;
    m.userData.kind = l.kind;
    m.castShadow = false;
    hull.add(m);
    lampMeshes[l.name] = m;
  }

  // driver hatch (opens for the enter animation: damage part doorFL)
  const hatch = new THREE.Group();
  hatch.name = 'hatch';
  hatch.position.set(T.hatch[0], T.deckY + 0.05, T.hatch[2]);
  const hB = new Bucket();
  hB.add('paint', cyl(0.3, 0.31, 0.06, hi ? 14 : 8, 0, 0.0, -0.32));
  hB.add('trim', box(0.12, 0.05, 0.12, 0, 0.03, -0.02));
  hB.build(hatch, mats);
  hatch.userData.part = 'doorFL';
  hatch.userData.hinge = { axis: 'x', sign: 1, max: 1.7 };
  hull.add(hatch);

  // tread loops (UV-scrolled), one material per side
  const tracks = [];
  for (const sx of [-1, 1]) {
    const geo = trackRibbon(loop, sx * T.trackX);
    const mesh = new THREE.Mesh(geo, sx < 0 ? mats.trackL : mats.trackR);
    mesh.name = sx < 0 ? 'trackL' : 'trackR';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    hull.add(mesh);
    const pos = geo.attributes.position;
    const base = new Float32Array(pos.array);
    tracks.push({ mesh, base, side: sx, mat: mesh.material });
  }

  // running gear
  const rw = roadWheelGeo(lod);
  const wheelList = [];
  for (const sx of [-1, 1]) for (const z of T.rwZ) wheelList.push({ x: sx * T.trackX, z, side: sx });
  let roadWheels;
  if (hi) {
    const n = wheelList.length;
    const disc = new THREE.InstancedMesh(toGeometry(rw.paint), mats.paint, n);
    const tyre = new THREE.InstancedMesh(toGeometry(rw.rubber), mats.tire, n);
    for (const m of [disc, tyre]) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; hull.add(m); }
    disc.name = 'roadWheelDisc';
    tyre.name = 'roadWheelTyre';
    roadWheels = { disc, tyre, list: wheelList };
    const M = new THREE.Matrix4();
    wheelList.forEach((w, i) => { M.makeTranslation(w.x, T.rwY, w.z); disc.setMatrixAt(i, M); tyre.setMatrixAt(i, M); });
  } else {
    const WB = new Bucket();
    for (const w of wheelList) {
      WB.add('paint', translate(rw.paint.slice(), w.x, T.rwY, w.z));
      WB.add('tire', translate(rw.rubber.slice(), w.x, T.rwY, w.z));
    }
    WB.build(hull, mats);
    roadWheels = { disc: null, tyre: null, list: wheelList };
  }
  const spGeo = toGeometry(sprocketGeo(lod));
  const idGeo = toGeometry(idlerGeo(lod));
  const sprockets = [], idlers = [];
  for (const sx of [-1, 1]) {
    const sp = new THREE.Mesh(spGeo, mats.trim);
    sp.position.set(sx * T.trackX, T.sprocket[1], T.sprocket[0]);
    const id = new THREE.Mesh(idGeo, mats.trim);
    id.position.set(sx * T.trackX, T.idler[1], T.idler[0]);
    for (const m of [sp, id]) { m.castShadow = true; m.receiveShadow = true; hull.add(m); }
    sp.name = 'sprocket';
    id.name = 'idler';
    sprockets.push(sp);
    idlers.push(id);
  }

  // turret, gun, recoil, muzzle flash
  const turret = new THREE.Group();
  turret.name = 'turret';
  turret.position.set(T.turret[0], T.turret[1], T.turret[2]);
  hull.add(turret);
  const TB = new Bucket();
  buildTurret(TB, lod);
  const turretMeshes = TB.build(turret, mats);
  const barrel = new THREE.Group();
  barrel.name = 'barrel';
  barrel.position.set(T.trunnion[0], T.trunnion[1], T.trunnion[2]);
  turret.add(barrel);
  const recoil = new THREE.Group();
  recoil.name = 'recoil';
  barrel.add(recoil);
  const MB = new Bucket(), RB = new Bucket();
  buildGun(MB, RB, lod);
  const gunMeshes = [...MB.build(barrel, mats), ...RB.build(recoil, mats)];
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(0, 0, -T.muzzle);
  recoil.add(muzzle);
  let flash = null;
  if (hi) {
    const parts = [];
    for (let k = 0; k < 3; k++) {
      const p = new THREE.PlaneGeometry(1.0, 2.2).toNonIndexed();
      p.rotateX(-Math.PI / 2);
      p.rotateZ((k * Math.PI) / 3);
      p.translate(0, 0, -1.0);
      parts.push(p.attributes.position.array, p.attributes.uv.array);
      p.dispose();
    }
    const star = new THREE.PlaneGeometry(1.6, 1.6).toNonIndexed();
    star.translate(0, 0, -0.15);
    const pos = concat([parts[0], parts[2], parts[4], star.attributes.position.array]);
    const uv = concat([parts[1], parts[3], parts[5], star.attributes.uv.array]);
    star.dispose();
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    fg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    flash = new THREE.Mesh(fg, mats.flash);
    flash.name = 'muzzleFlash';
    flash.castShadow = false;
    flash.receiveShadow = false;
    flash.frustumCulled = false;
    flash.renderOrder = 5;
    flash.scale.setScalar(0.0001); // always rendered (compiled at spawn), invisible when idle
    muzzle.add(flash);
  }

  return {
    root, hull, turret, barrel, recoil, muzzle, flash, hatch, tracks, loop, roadWheels, sprockets, idlers,
    materials: mats,
    lampMeshes,
    parts: { doorFL: hatch },
    damageMeshes: [...hullMeshes, ...turretMeshes, ...gunMeshes],
    turretMeshes, gunMeshes,
    dims: { length: T.length, width: T.width, height: T.height, wheelbase: T.rwZ[6] - T.rwZ[0] },
  };
}

/** Thumbnail / preview object (Thumbnails.js `entry.buildPreview`). */
export function buildTankPreview({ lod = 'high', color } = {}) {
  const m = buildTankModel({ lod, color });
  m.turret.rotation.y = -0.12;
  m.barrel.rotation.x = 0.04;
  m.materials.head.emissiveIntensity = 0.6;
  const g = new THREE.Group();
  g.add(m.root);
  g.userData.dispose = () => {
    g.traverse((o) => o.isMesh && o.geometry?.dispose());
    for (const x of Object.values(m.materials)) { x.map && x.map !== TREAD && x.map !== FLASH_TEX && x.map.dispose(); x.dispose(); }
  };
  return g;
}

/**
 * Static bake for instanced rendering (remote players, J): same format as src/vehicle/bake.js plus separate
 * hull / turret / barrel geometries and pivots so the turret can be articulated.
 */
export function bakeTank(id = 'tank', color = 0xc2a878) {
  const m = buildTankModel({ lod: 'low', color: 0xffffff }); // paint is tinted per instance (aPaint)
  const all = [], hullOnly = [], turretOnly = [], gunOnly = [];
  m.root.updateMatrixWorld(true);
  const tInv = new THREE.Matrix4().copy(m.turret.matrixWorld).invert();
  const bInv = new THREE.Matrix4().copy(m.barrel.matrixWorld).invert();
  const _c = new THREE.Color();
  m.root.traverse((o) => {
    if (!o.isMesh || o === m.flash) return;
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    g.applyMatrix4(o.matrixWorld);
    const mat = o.material;
    const n = g.attributes.position.count;
    _c.copy(mat.color);
    if (mat.map) _c.setHex(0x34332f);
    const col = new Float32Array(n * 3), paint = new Float32Array(n), emit = new Float32Array(n * 2);
    const isPaint = mat === m.materials.paint;
    for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; paint[i] = isPaint ? 1 : 0; }
    if (mat === m.materials.head) for (let i = 0; i < n; i++) emit[i * 2] = 1;
    if (mat === m.materials.tail) for (let i = 0; i < n; i++) emit[i * 2 + 1] = 1;
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aPaint', new THREE.BufferAttribute(paint, 1));
    g.setAttribute('aEmit', new THREE.BufferAttribute(emit, 2));
    all.push(g);
    let p = o, inTurret = false, inGun = false;
    while (p) { if (p === m.barrel) inGun = true; if (p === m.turret) inTurret = true; p = p.parent; }
    if (inGun) gunOnly.push(g.clone().applyMatrix4(bInv));
    else if (inTurret) turretOnly.push(g.clone().applyMatrix4(tInv));
    else hullOnly.push(g);
  });
  const merge = (list) => {
    let n = 0;
    for (const g of list) n += g.attributes.position.count;
    const out = new THREE.BufferGeometry();
    for (const [k, size] of [['position', 3], ['normal', 3], ['color', 3], ['aPaint', 1], ['aEmit', 2]]) {
      const arr = new Float32Array(n * size);
      let o2 = 0;
      for (const g of list) { arr.set(g.attributes[k].array, o2); o2 += g.attributes[k].array.length; }
      out.setAttribute(k, new THREE.BufferAttribute(arr, size));
    }
    out.computeBoundingBox();
    out.computeBoundingSphere();
    return out;
  };
  const geo = merge(all);
  const res = {
    id, name: 'Mastodon', kind: 'tank', spec: { wheelRadius: TANK.originY, size: { length: TANK.length, width: TANK.width, height: TANK.height } },
    geo, hullGeo: merge(hullOnly), turretGeo: merge(turretOnly), barrelGeo: merge(gunOnly),
    turretPivot: [...TANK.turret], barrelPivot: [...TANK.trunnion],
    wheelGeo: null, wheel: null, wheels: [], length: TANK.length, width: TANK.width, height: TANK.height,
    wheelbase: TANK.rwZ[6] - TANK.rwZ[0], track: TANK.trackX * 2, radius: 0, palette: [color], tris: geo.attributes.position.count / 3,
  };
  for (const g of all) g.dispose();
  m.root.traverse((o) => o.isMesh && o.geometry.dispose());
  for (const x of Object.values(m.materials)) { if (x.map && x.map !== TREAD && x.map !== FLASH_TEX) x.map.dispose(); x.dispose(); }
  return res;
}
