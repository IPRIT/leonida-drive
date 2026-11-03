// Original low-poly boat designs. Frame: x right, y up, -z forward, origin on the static waterline.
import * as THREE from 'three';
import { Builder, makeMaterials, blurDisc, propBlades, navLight } from '../air/models/kit.js';

function rail(b, pts, r = 0.025, mat = 'chrome') {
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0, z0] = pts[i], [x1, y1, z1] = pts[i + 1];
    const L = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const g = new THREE.CylinderGeometry(r, r, L, 5);
    const dir = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0).normalize();
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    b.add(mat, g, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  }
}

// ---------------- Riptide 33: offshore speedboat ----------------
function buildSpeed(mats) {
  const b = new Builder();
  b.loft('white', [
    { z: -4.75, y: 0.78, w: 0.04, h: 0.1, b: 0.12 },
    { z: -3.9, y: 0.52, w: 0.78, h: 0.24, b: 0.62, k: 0.78 },
    { z: -2.4, y: 0.3, w: 1.18, h: 0.42, b: 0.7, k: 0.72 },
    { z: 0.5, y: 0.26, w: 1.25, h: 0.45, b: 0.66, k: 0.7 },
    { z: 4.7, y: 0.26, w: 1.2, h: 0.44, b: 0.62, k: 0.66 },
  ]);
  // topside racing stripes
  b.loft('paint', [
    { z: -4.2, y: 0.55, w: 0.62, h: 0.06, b: 0.06 },
    { z: -2.4, y: 0.42, w: 1.21, h: 0.08, b: 0.08 },
    { z: 4.72, y: 0.36, w: 1.23, h: 0.08, b: 0.08 },
  ], { capStart: false });
  b.loft('paint2', [
    { z: -3.0, y: 0.28, w: 1.1, h: 0.035, b: 0.035 },
    { z: 4.73, y: 0.18, w: 1.215, h: 0.035, b: 0.035 },
  ]);
  // deck, cockpit, windscreen, seats
  b.loft('white', [
    { z: -3.9, y: 0.78, w: 0.6, h: 0.06, b: 0.02 },
    { z: -1.8, y: 0.86, w: 1.1, h: 0.12, b: 0.02 },
    { z: -0.9, y: 0.86, w: 1.15, h: 0.1, b: 0.02 },
  ]);
  b.box('dark', 2.15, 0.06, 3.6, 0, 0.72, 1.0);
  b.box('glass', 2.0, 0.42, 0.06, 0, 1.05, -0.95, -0.55, 0, 0);
  b.box('glass', 0.05, 0.3, 0.7, 1.02, 1.0, -0.6, 0, 0.25, 0);
  b.box('glass', 0.05, 0.3, 0.7, -1.02, 1.0, -0.6, 0, -0.25, 0);
  b.box('dark', 1.6, 0.35, 0.3, 0, 0.9, -0.55);
  for (const x of [-0.5, 0.5]) {
    b.box('seat', 0.6, 0.18, 0.6, x, 0.85, 0.35);
    b.box('seat', 0.6, 0.6, 0.14, x, 1.1, 0.68, -0.15, 0, 0);
  }
  b.box('seat', 2.0, 0.2, 0.6, 0, 0.85, 1.9);
  // engine hatch + swim platform
  b.box('paint2', 2.0, 0.12, 1.6, 0, 0.78, 3.6);
  b.box('wood', 2.2, 0.06, 0.45, 0, 0.18, 4.95);
  rail(b, [[0.9, 0.86, -1.4], [0.8, 1.0, -2.8], [0.25, 1.0, -3.8]]);
  rail(b, [[-0.9, 0.86, -1.4], [-0.8, 1.0, -2.8], [-0.25, 1.0, -3.8]]);
  b.cyl('metal', 0.03, 0.03, 0.9, 5, 0, 1.2, 3.0);
  const root = b.build(mats);
  const lights = {
    navL: [navLight(mats.navRed, -0.9, 0.82, -3.0, 0.06)],
    navR: [navLight(mats.navGreen, 0.9, 0.82, -3.0, 0.06)],
    stern: [navLight(mats.lamp, 0, 1.68, 3.0, 0.06)],
  };
  for (const l of Object.values(lights).flat()) root.add(l);
  return { root, lights, seat: [-0.5, 0.95, 0.35] };
}

// ---------------- Zipfin JX: jet ski ----------------
function buildJetski(mats) {
  const b = new Builder();
  b.loft('white', [
    { z: -1.6, y: 0.3, w: 0.05, h: 0.08, b: 0.08 },
    { z: -1.15, y: 0.2, w: 0.44, h: 0.2, b: 0.34, k: 0.72 },
    { z: 0.2, y: 0.18, w: 0.55, h: 0.24, b: 0.38, k: 0.62 },
    { z: 1.6, y: 0.18, w: 0.5, h: 0.2, b: 0.36, k: 0.52 },
  ]);
  b.loft('paint', [
    { z: -1.5, y: 0.38, w: 0.12, h: 0.06, b: 0.04 },
    { z: -1.0, y: 0.44, w: 0.42, h: 0.16, b: 0.04 },
    { z: -0.25, y: 0.5, w: 0.44, h: 0.2, b: 0.06 },
    { z: 0.05, y: 0.46, w: 0.3, h: 0.12, b: 0.05 },
  ]);
  b.loft('paint2', [
    { z: -0.6, y: 0.45, w: 0.56, h: 0.04, b: 0.04 },
    { z: 1.55, y: 0.36, w: 0.51, h: 0.04, b: 0.04 },
  ]);
  b.loft('seat', [
    { z: -0.15, y: 0.62, w: 0.12, h: 0.06, b: 0.05 },
    { z: 0.15, y: 0.68, w: 0.24, h: 0.1, b: 0.08 },
    { z: 1.15, y: 0.64, w: 0.24, h: 0.1, b: 0.08 },
    { z: 1.35, y: 0.58, w: 0.18, h: 0.06, b: 0.05 },
  ]);
  b.box('dark', 1.0, 0.05, 1.4, 0, 0.39, 0.75);
  b.cyl('dark', 0.11, 0.11, 0.22, 8, 0, 0.0, 1.62, 'z');
  // handlebar
  b.cyl('dark', 0.04, 0.05, 0.32, 6, 0, 0.78, -0.42, 'y', 0.4, 0, 0);
  b.cyl('chrome', 0.025, 0.025, 0.8, 6, 0, 0.92, -0.36, 'x');
  for (const s of [-1, 1]) b.cyl('dark', 0.035, 0.035, 0.16, 6, s * 0.36, 0.92, -0.36, 'x');
  b.box('glass', 0.42, 0.14, 0.04, 0, 0.64, -0.62, -0.7, 0, 0);
  const root = b.build(mats);
  const lights = { navL: [navLight(mats.navRed, -0.36, 0.48, -1.05, 0.04)], navR: [navLight(mats.navGreen, 0.36, 0.48, -1.05, 0.04)], stern: [] };
  for (const l of Object.values(lights).flat()) root.add(l);
  return { root, lights, seat: [0, 0.75, 0.35] };
}

// ---------------- Sunward 38: cabin cruiser ----------------
function buildCruiser(mats) {
  const b = new Builder();
  b.loft('white', [
    { z: -5.85, y: 1.42, w: 0.05, h: 0.12, b: 0.25 },
    { z: -4.8, y: 1.0, w: 1.32, h: 0.32, b: 1.05, k: 0.66 },
    { z: -2.5, y: 0.66, w: 1.86, h: 0.58, b: 1.25, k: 0.6 },
    { z: 2.0, y: 0.6, w: 1.92, h: 0.62, b: 1.22, k: 0.56 },
    { z: 5.8, y: 0.6, w: 1.86, h: 0.6, b: 1.15, k: 0.5 },
  ]);
  b.loft('paint', [
    { z: -5.2, y: 1.08, w: 0.7, h: 0.08, b: 0.08 },
    { z: -2.5, y: 0.82, w: 1.88, h: 0.09, b: 0.09 },
    { z: 5.82, y: 0.8, w: 1.88, h: 0.09, b: 0.09 },
  ], { capStart: false });
  b.loft('paint', [
    { z: -2.5, y: 0.05, w: 1.6, h: 0.05, b: 0.05 },
    { z: 5.82, y: 0.05, w: 1.66, h: 0.05, b: 0.05 },
  ]);
  // deck
  b.box('white', 3.6, 0.1, 9.5, 0, 1.24, 0.9);
  b.box('wood', 3.4, 0.05, 3.8, 0, 1.31, 3.8);
  b.box('wood', 3.6, 0.07, 0.55, 0, 0.42, 6.05);
  // cabin superstructure
  b.loft('white', [
    { z: -3.3, y: 1.5, w: 1.25, h: 0.22, b: 0.2 },
    { z: -2.4, y: 1.85, w: 1.55, h: 0.55, b: 0.55, k: 0.3 },
    { z: 1.8, y: 1.85, w: 1.6, h: 0.55, b: 0.55, k: 0.25 },
  ]);
  b.loft('glass', [
    { z: -3.0, y: 1.82, w: 1.4, h: 0.12, b: 0.1 },
    { z: -2.38, y: 2.0, w: 1.57, h: 0.22, b: 0.2, k: 0.3 },
    { z: 1.5, y: 2.0, w: 1.62, h: 0.22, b: 0.2, k: 0.25 },
  ], { capEnd: false });
  b.box('dark', 1.0, 1.0, 0.04, 0, 1.85, 1.82);
  // flybridge
  b.box('white', 3.0, 0.12, 3.6, 0, 2.46, -0.2);
  b.box('white', 1.2, 0.5, 0.6, 0, 2.75, -1.4);
  b.box('glass', 1.1, 0.3, 0.05, 0, 3.12, -1.65, -0.5, 0, 0);
  b.box('seat', 1.4, 0.2, 0.55, 0, 2.62, -0.6);
  rail(b, [[1.45, 2.52, 1.6], [1.45, 3.1, 1.6], [1.45, 3.1, -1.9], [1.0, 3.1, -2.0], [-1.0, 3.1, -2.0], [-1.45, 3.1, -1.9], [-1.45, 3.1, 1.6], [-1.45, 2.52, 1.6]]);
  rail(b, [[1.6, 1.3, 5.5], [1.65, 1.95, 5.5], [1.65, 1.95, 2.2]]);
  rail(b, [[-1.6, 1.3, 5.5], [-1.65, 1.95, 5.5], [-1.65, 1.95, 2.2]]);
  rail(b, [[1.3, 1.3, -3.5], [1.2, 1.75, -4.6], [0.1, 1.75, -5.6]]);
  rail(b, [[-1.3, 1.3, -3.5], [-1.2, 1.75, -4.6], [-0.1, 1.75, -5.6]]);
  // mast + radar
  b.cyl('white', 0.05, 0.07, 1.4, 6, 0, 3.2, 0.9);
  b.box('white', 0.9, 0.12, 0.2, 0, 3.75, 0.9);
  b.box('seat', 2.6, 0.3, 0.6, 0, 1.55, 5.3);
  const root = b.build(mats);
  const lights = {
    navL: [navLight(mats.navRed, -1.62, 2.05, -2.3, 0.07)],
    navR: [navLight(mats.navGreen, 1.62, 2.05, -2.3, 0.07)],
    stern: [navLight(mats.lamp, 0, 3.95, 0.9, 0.07)],
  };
  for (const l of Object.values(lights).flat()) root.add(l);
  return { root, lights, seat: [0.4, 2.75, -0.6] };
}

// ---------------- Glade Runner: swamp airboat ----------------
function buildAirboat(mats) {
  const b = new Builder();
  b.loft('metal', [
    { z: -2.35, y: 0.42, w: 0.92, h: 0.06, b: 0.08, k: 0.2 },
    { z: -1.85, y: 0.14, w: 1.06, h: 0.26, b: 0.24, k: 0.22 },
    { z: 2.3, y: 0.14, w: 1.1, h: 0.26, b: 0.26, k: 0.22 },
  ]);
  b.box('paint', 2.24, 0.12, 4.2, 0, 0.3, 0.1);
  b.box('dark', 2.0, 0.04, 4.0, 0, 0.41, 0.1);
  // passenger bench + raised driver seat
  b.box('seat', 1.6, 0.25, 0.55, 0, 0.6, -0.9);
  b.box('seat', 1.6, 0.5, 0.12, 0, 0.8, -0.62);
  for (const [x, z] of [[-0.35, 0.45], [0.35, 0.45], [-0.35, 0.95], [0.35, 0.95]]) b.cyl('metal', 0.03, 0.03, 0.95, 5, x, 0.9, z);
  b.box('seat', 0.8, 0.14, 0.6, 0, 1.42, 0.7);
  b.box('seat', 0.8, 0.5, 0.1, 0, 1.68, 1.0);
  b.cyl('dark', 0.03, 0.03, 0.9, 5, 0.5, 1.15, 0.2, 'y', 0.4, 0, 0);
  // engine + fan cage
  b.box('paint2', 0.8, 0.6, 0.9, 0, 0.75, 1.4);
  b.box('dark', 0.7, 0.18, 0.7, 0, 1.12, 1.4);
  b.cyl('metal', 0.07, 0.07, 0.5, 6, 0, 1.25, 1.75, 'z');
  const ring = new THREE.TorusGeometry(1.25, 0.04, 5, 24);
  b.add('chrome', ring, 0, 1.35, 2.05);
  b.add('chrome', new THREE.TorusGeometry(1.25, 0.03, 5, 24), 0, 1.35, 1.95);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.cyl('chrome', 0.015, 0.015, 1.25, 4, Math.cos(a) * 0.62, 1.35 + Math.sin(a) * 0.62, 2.05, 'y', 0, 0, a - Math.PI / 2);
  }
  for (const s of [-1, 1]) b.cyl('metal', 0.04, 0.04, 1.4, 5, s * 0.9, 0.95, 2.0, 'y', 0, 0, s * 0.45);
  const root = b.build(mats);
  // fan
  const fan = { pivot: new THREE.Group(), spin: new THREE.Group() };
  fan.pivot.position.set(0, 1.35, 1.95);
  fan.spin.add(propBlades(mats, 1.15, 2, 0.2));
  fan.disc = blurDisc(1.15, 'z');
  fan.pivot.add(fan.spin, fan.disc);
  root.add(fan.pivot);
  // air rudders
  const rudders = [];
  for (const x of [-0.55, 0, 0.55]) {
    const p = new THREE.Group();
    p.position.set(x, 1.35, 2.2);
    const rb = new Builder();
    rb.box('paint', 0.04, 1.6, 0.55, 0, 0, 0.27);
    p.add(rb.build(mats));
    root.add(p);
    rudders.push(p);
  }
  const lights = {
    navL: [navLight(mats.navRed, -1.05, 0.45, -1.9, 0.05)],
    navR: [navLight(mats.navGreen, 1.05, 0.45, -1.9, 0.05)],
    stern: [navLight(mats.lamp, 0, 2.7, 2.05, 0.06)],
  };
  for (const l of Object.values(lights).flat()) root.add(l);
  return { root, lights, fan, rudders, seat: [0, 1.55, 0.7] };
}

const BUILDERS = { boat_speed: buildSpeed, boat_jetski: buildJetski, boat_cruiser: buildCruiser, boat_airboat: buildAirboat };

export const BOAT_LOOKS = {
  boat_speed: { color: 0xe0303f, color2: 0x1b2b4f },
  boat_jetski: { color: 0x14b8c4, color2: 0xff4fa3 },
  boat_cruiser: { color: 0x1d3157, color2: 0xc9a46a },
  boat_airboat: { color: 0x2f6a3a, color2: 0x333333 },
};

export function buildBoatModel(id, { color, color2 } = {}) {
  const look = BOAT_LOOKS[id];
  const mats = makeMaterials(color ?? look.color, color2 ?? look.color2);
  const m = BUILDERS[id](mats);
  m.root.traverse((o) => { if (o.isMesh && o.name !== 'blurDisc' && !(o.material.emissiveIntensity > 0)) o.castShadow = true; });
  m.materials = mats;
  return m;
}
