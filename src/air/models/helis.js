// Original low-poly helicopter designs. Frame: x right, y up, -z forward, origin = centre of mass.
import * as THREE from 'three';
import { Builder, makeMaterials, blurDisc, rotorBlades, navLight } from './kit.js';

function rotor(mats, spec, hub, n, chord, dir = 1, tint) {
  const pivot = new THREE.Group();
  pivot.position.set(hub[0], hub[1], hub[2]);
  const blades = rotorBlades(mats, spec.rotor.radius, n, chord, { hubR: 0.16 + spec.rotor.radius * 0.015 });
  const disc = blurDisc(spec.rotor.radius, 'y', tint);
  disc.position.y = 0.02;
  const spin = new THREE.Group();
  spin.add(blades);
  pivot.add(spin, disc);
  return { pivot, spin, blades, disc, dir };
}

function tailRotor(mats, t, n = 2) {
  const pivot = new THREE.Group();
  pivot.position.set(t.x, t.y, t.z);
  const spin = new THREE.Group();
  const blades = rotorBlades(mats, t.r, n, 0.12, { hubR: 0.07, droop: 0 });
  spin.add(blades);
  const disc = blurDisc(t.r, 'y');
  // rotor plane = YZ (axis x)
  pivot.rotation.z = Math.PI / 2;
  pivot.add(spin, disc);
  return { pivot, spin, blades, disc, dir: 1 };
}

function skids(b, x, y, z0, z1, r = 0.05, mat = 'metal') {
  for (const s of [-1, 1]) {
    b.cyl(mat, r, r, z1 - z0, 6, s * x, y, (z0 + z1) / 2, 'z');
    b.cyl(mat, r, r, 0.42, 6, s * x, y + 0.13, z0 - 0.17, 'z', -0.65, 0, 0); // upturned toe
  }
}

function crossTube(b, x, yTop, ySkid, z, r = 0.045, mat = 'metal') {
  for (const s of [-1, 1]) {
    const dx = x * 0.35, dy = yTop - ySkid;
    const L = Math.hypot(dx, dy);
    b.cyl(mat, r, r, L, 6, s * (x - dx / 2), (yTop + ySkid) / 2, z, 'y', 0, 0, s * Math.atan2(dx, dy));
  }
  b.cyl(mat, r, r, x * 1.3, 6, 0, yTop, z, 'x');
}

// ---------------- Vella N2: light two-seat news helicopter ----------------
function buildNews(spec, mats) {
  const b = new Builder();
  // lower body
  b.loft('paint', [
    { z: -1.62, y: -0.28, w: 0.2, h: 0.1, b: 0.12 },
    { z: -1.35, y: -0.25, w: 0.58, h: 0.18, b: 0.32 },
    { z: -0.55, y: -0.2, w: 0.72, h: 0.25, b: 0.42 },
    { z: 0.5, y: -0.05, w: 0.66, h: 0.45, b: 0.45 },
    { z: 1.0, y: 0.25, w: 0.38, h: 0.35, b: 0.28 },
    { z: 1.25, y: 0.42, w: 0.2, h: 0.2, b: 0.18 },
  ]);
  // bubble canopy
  b.loft('glass', [
    { z: -1.5, y: -0.12, w: 0.42, h: 0.12, b: 0.04 },
    { z: -1.15, y: 0.08, w: 0.66, h: 0.5, b: 0.12, k: 0.5 },
    { z: -0.45, y: 0.2, w: 0.72, h: 0.66, b: 0.15, k: 0.5 },
    { z: 0.3, y: 0.24, w: 0.67, h: 0.6, b: 0.1, k: 0.5 },
    { z: 0.55, y: 0.24, w: 0.5, h: 0.48, b: 0.1 },
  ]);
  // roof + engine deck + cowling
  b.loft('paint2', [
    { z: -0.2, y: 0.82, w: 0.25, h: 0.06 },
    { z: 0.45, y: 0.82, w: 0.42, h: 0.12, b: 0.08 },
    { z: 1.3, y: 0.72, w: 0.3, h: 0.14, b: 0.12 },
  ]);
  b.box('dark', 0.5, 0.35, 0.55, 0, 0.78, 0.9);
  // mast
  b.cyl('metal', 0.07, 0.09, 0.6, 8, 0, 1.15, -0.15);
  b.cyl('dark', 0.16, 0.2, 0.18, 8, 0, 0.9, -0.15);
  // tail boom & tail
  b.cyl('paint', 0.07, 0.17, 3.9, 8, 0, 0.55, 3.15, 'z', 0.04, 0, 0);
  b.plate('paint2', [[-0.02, 4.55], [0.02, 4.55], [0.02, 5.25], [-0.02, 5.25]], 0.04, 0.6);
  b.profile('paint', [[4.6, 0.45], [5.25, 0.45], [5.45, 1.35], [5.15, 1.35]], 0.06);
  b.profile('paint', [[4.75, 0.55], [5.2, 0.55], [5.3, -0.05], [5.05, -0.05]], 0.05);
  b.plate('paint', [[-0.75, 4.1], [0.75, 4.1], [0.75, 4.42], [-0.75, 4.42]], 0.04, 0.48);
  // stripe
  b.box('paint2', 0.04, 0.08, 1.6, 0.66, -0.12, -0.2);
  b.box('paint2', 0.04, 0.08, 1.6, -0.66, -0.12, -0.2);
  // nose camera ball
  b.sphere('dark', 0.17, 0, -0.52, -1.35);
  b.box('dark', 0.08, 0.12, 0.08, 0, -0.4, -1.35);
  // skids
  skids(b, 0.92, -1.15, -1.3, 0.85, 0.045);
  crossTube(b, 0.92, -0.5, -1.15, -0.85);
  crossTube(b, 0.92, -0.45, -1.15, 0.45);
  const root = b.build(mats);
  const main = rotor(mats, spec, spec.rotor.hubs[0], 2, 0.22, 1);
  const tail = tailRotor(mats, spec.rotor.tail, 2);
  root.add(main.pivot, tail.pivot);
  const lights = {
    navL: [navLight(mats.navRed, -0.72, -0.25, 0.35)],
    navR: [navLight(mats.navGreen, 0.72, -0.25, 0.35)],
    strobes: [navLight(mats.strobe, 0, 1.38, 5.2, 0.07)],
    beacons: [navLight(mats.beacon, 0, 0.95, 0.95, 0.08), navLight(mats.beacon, 0, -0.72, 0.2, 0.08)],
  };
  for (const l of Object.values(lights).flat()) root.add(l);
  return { root, rotors: [main], tail, lights, cockpit: [0.32, 0.45, -0.75] };
}

// ---------------- Sentry U4: utility / police helicopter ----------------
function buildPolice(spec, mats) {
  const b = new Builder();
  b.loft('paint', [
    { z: -2.7, y: -0.35, w: 0.22, h: 0.18, b: 0.12 },
    { z: -2.4, y: -0.22, w: 0.68, h: 0.42, b: 0.42 },
    { z: -1.6, y: 0.0, w: 0.92, h: 0.82, b: 0.62 },
    { z: 0.6, y: 0.12, w: 0.92, h: 0.84, b: 0.6 },
    { z: 1.5, y: 0.45, w: 0.55, h: 0.55, b: 0.35 },
    { z: 1.9, y: 0.6, w: 0.3, h: 0.3, b: 0.24 },
  ]);
  // windscreen (slanted) and side windows
  b.loft('glass', [
    { z: -2.55, y: -0.12, w: 0.5, h: 0.2, b: 0.02 },
    { z: -2.05, y: 0.25, w: 0.86, h: 0.5, b: 0.05 },
    { z: -1.45, y: 0.42, w: 0.9, h: 0.5, b: 0.05 },
  ], { capStart: true, capEnd: false });
  b.box('glass', 0.03, 0.5, 0.9, 0.925, 0.35, -0.85);
  b.box('glass', 0.03, 0.5, 0.9, -0.925, 0.35, -0.85);
  b.box('glass', 0.03, 0.45, 0.8, 0.925, 0.35, 0.25);
  b.box('glass', 0.03, 0.45, 0.8, -0.925, 0.35, 0.25);
  // white band + door seams
  b.box('paint2', 1.88, 0.16, 3.0, 0, -0.22, -0.55);
  b.box('dark', 1.9, 0.9, 0.03, 0, 0.12, -0.3);
  // engine housing + mast
  b.loft('paint', [
    { z: -0.9, y: 1.05, w: 0.35, h: 0.08, b: 0.05 },
    { z: -0.4, y: 1.05, w: 0.62, h: 0.25, b: 0.12 },
    { z: 1.3, y: 1.0, w: 0.58, h: 0.24, b: 0.12 },
    { z: 2.1, y: 0.85, w: 0.3, h: 0.18, b: 0.1 },
  ]);
  b.box('dark', 0.1, 0.22, 0.4, 0.62, 1.05, 1.0);
  b.box('dark', 0.1, 0.22, 0.4, -0.62, 1.05, 1.0);
  b.cyl('metal', 0.09, 0.12, 0.5, 8, 0, 1.55, -0.2);
  // tail boom, fin, stabiliser with end plates
  b.cyl('paint', 0.1, 0.24, 5.0, 8, 0, 0.72, 4.2, 'z', 0.03, 0, 0);
  b.profile('paint', [[6.0, 0.75], [6.9, 0.75], [7.15, 2.0], [6.75, 2.0]], 0.07);
  b.profile('paint', [[6.2, 0.75], [6.85, 0.75], [6.95, 0.0], [6.6, 0.0]], 0.06);
  b.plate('paint', [[-1.05, 5.55], [1.05, 5.55], [1.05, 5.95], [-1.05, 5.95]], 0.05, 0.7);
  b.box('paint2', 0.04, 0.4, 0.45, 1.06, 0.75, 5.75);
  b.box('paint2', 0.04, 0.4, 0.45, -1.06, 0.75, 5.75);
  // searchlight pod + FLIR ball
  b.cyl('dark', 0.05, 0.05, 0.3, 6, spec.searchlight.x, -0.72, spec.searchlight.z);
  b.sphere('dark', 0.2, -0.45, -0.82, -2.1);
  // skids
  skids(b, 1.1, -1.34, -1.75, 1.15, 0.055);
  crossTube(b, 1.1, -0.6, -1.34, -1.1, 0.055);
  crossTube(b, 1.1, -0.55, -1.34, 0.65, 0.055);
  // steps
  b.box('dark', 0.25, 0.04, 1.1, 1.16, -1.0, -0.4);
  b.box('dark', 0.25, 0.04, 1.1, -1.16, -1.0, -0.4);
  const root = b.build(mats);
  const main = rotor(mats, spec, spec.rotor.hubs[0], 4, 0.3, 1);
  const tail = tailRotor(mats, spec.rotor.tail, 3);
  root.add(main.pivot, tail.pivot);
  // searchlight head (aimed at runtime)
  const sl = new THREE.Group();
  sl.position.set(spec.searchlight.x, spec.searchlight.y, spec.searchlight.z);
  const head = new Builder();
  head.cyl('dark', 0.16, 0.2, 0.32, 10, 0, 0, 0.0, 'z');
  head.cyl('metal', 0.17, 0.17, 0.04, 10, 0, 0, -0.17, 'z');
  const headMesh = head.build(mats);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.15, 12), mats.lamp);
  lens.position.z = -0.2;
  lens.rotation.y = Math.PI;
  sl.add(headMesh, lens);
  root.add(sl);
  const lights = {
    navL: [navLight(mats.navRed, -1.05, 0.95, 5.75)],
    navR: [navLight(mats.navGreen, 1.05, 0.95, 5.75)],
    strobes: [navLight(mats.strobe, 0, 2.05, 6.95, 0.07)],
    beacons: [navLight(mats.beacon, 0, 1.32, 1.6, 0.09), navLight(mats.beacon, 0, -0.78, 0.6, 0.09)],
    sirenRed: [navLight(mats.sirenRed, -0.5, -0.8, 0.9, 0.11), navLight(mats.sirenRed, -0.3, 1.32, 0.9, 0.09)],
    sirenBlue: [navLight(mats.sirenBlue, 0.5, -0.8, 0.9, 0.11), navLight(mats.sirenBlue, 0.3, 1.32, 0.9, 0.09)],
  };
  for (const l of Object.values(lights).flat()) root.add(l);
  return { root, rotors: [main], tail, lights, searchlight: { pivot: sl, lens }, cockpit: [0.42, 0.55, -1.5] };
}

// ---------------- Mule T2: tandem-rotor cargo helicopter ----------------
function buildCargo(spec, mats) {
  const b = new Builder();
  b.loft('paint', [
    { z: -7.4, y: -0.35, w: 0.4, h: 0.35, b: 0.4 },
    { z: -7.0, y: -0.1, w: 1.15, h: 0.9, b: 0.9 },
    { z: -6.0, y: 0.1, w: 1.38, h: 1.3, b: 1.2, k: 0.3 },
    { z: 5.5, y: 0.15, w: 1.38, h: 1.3, b: 1.2, k: 0.3 },
    { z: 7.1, y: 0.75, w: 1.15, h: 0.85, b: 0.4, k: 0.35 },
  ]);
  // cockpit glazing
  b.loft('glass', [
    { z: -7.25, y: 0.05, w: 0.6, h: 0.25, b: 0.02 },
    { z: -6.6, y: 0.6, w: 1.2, h: 0.5, b: 0.05 },
    { z: -5.9, y: 0.75, w: 1.3, h: 0.42, b: 0.05 },
  ], { capEnd: false });
  for (let i = 0; i < 5; i++) {
    b.box('glass', 0.03, 0.4, 0.45, 1.385, 0.5, -3.6 + i * 1.6);
    b.box('glass', 0.03, 0.4, 0.45, -1.385, 0.5, -3.6 + i * 1.6);
  }
  // stripe
  b.box('paint2', 2.8, 0.3, 11.5, 0, -0.35, -0.3);
  // front pylon
  b.loft('paint', [
    { z: -6.5, y: 1.55, w: 0.4, h: 0.12, b: 0.1 },
    { z: -5.6, y: 1.75, w: 0.55, h: 0.35, b: 0.3 },
    { z: -4.6, y: 1.55, w: 0.55, h: 0.2, b: 0.2 },
  ]);
  b.cyl('metal', 0.14, 0.18, 0.5, 8, 0, 2.15, -5.3);
  // rear pylon (tall)
  b.loft('paint', [
    { z: 2.6, y: 1.4, w: 0.5, h: 0.1, b: 0.1 },
    { z: 4.2, y: 1.95, w: 0.7, h: 0.55, b: 0.5 },
    { z: 6.0, y: 2.3, w: 0.62, h: 0.75, b: 0.7 },
    { z: 6.9, y: 2.25, w: 0.4, h: 0.6, b: 0.6 },
  ]);
  b.cyl('metal', 0.14, 0.18, 0.5, 8, 0, 3.0, 5.2);
  // engine pods on the rear pylon
  for (const s of [-1, 1]) b.cyl('paint2', 0.38, 0.38, 2.4, 10, s * 1.05, 1.95, 4.4, 'z');
  for (const s of [-1, 1]) b.cyl('dark', 0.3, 0.3, 0.05, 10, s * 1.05, 1.95, 3.18, 'z');
  const root = b.build(mats);
  // sponsons (fuel tanks + main gear) on both sides
  const spon = new Builder();
  spon.loft('paint', [
    { z: -0.6, y: -0.95, w: 0.15, h: 0.25, b: 0.3 },
    { z: 0.2, y: -0.9, w: 0.42, h: 0.35, b: 0.35 },
    { z: 3.6, y: -0.9, w: 0.42, h: 0.35, b: 0.35 },
    { z: 4.3, y: -0.85, w: 0.2, h: 0.25, b: 0.25 },
  ]);
  for (const s of [-1, 1]) {
    const g = spon.build(mats);
    g.position.x = s * 1.5;
    root.add(g);
  }
  const wheels = new Builder();
  for (const [x, z] of [[-1.55, -3.6], [1.55, -3.6], [-1.75, 2.6], [-1.75, 3.2], [1.75, 2.6], [1.75, 3.2]]) {
    wheels.cyl('rubber', 0.42, 0.42, 0.3, 12, x, -1.53, z, 'x');
    wheels.cyl('metal', 0.22, 0.22, 0.32, 8, x, -1.53, z, 'x');
  }
  wheels.cyl('metal', 0.07, 0.07, 0.8, 6, -1.4, -1.1, -3.6);
  wheels.cyl('metal', 0.07, 0.07, 0.8, 6, 1.4, -1.1, -3.6);
  root.add(wheels.build(mats));
  const front = rotor(mats, spec, spec.rotor.hubs[0], 3, 0.6, 1);
  const rear = rotor(mats, spec, spec.rotor.hubs[1], 3, 0.6, -1);
  root.add(front.pivot, rear.pivot);
  const lights = {
    navL: [navLight(mats.navRed, -1.42, 0.2, -2.0)],
    navR: [navLight(mats.navGreen, 1.42, 0.2, -2.0)],
    strobes: [navLight(mats.strobe, 0, 2.95, 6.9, 0.09)],
    beacons: [navLight(mats.beacon, 0, 2.0, -5.6, 0.12), navLight(mats.beacon, 0, -1.15, 1.0, 0.12)],
  };
  for (const l of Object.values(lights).flat()) root.add(l);
  return { root, rotors: [front, rear], tail: null, lights, cockpit: [0.6, 0.65, -6.0] };
}

const BUILDERS = { heli_news: buildNews, heli_police: buildPolice, heli_cargo: buildCargo };

export function buildHeliModel(id, spec, { color, color2 } = {}) {
  const def = HELI_LOOKS[id];
  const mats = makeMaterials(color ?? def.color, color2 ?? def.color2);
  const m = BUILDERS[id](spec, mats);
  m.root.traverse((o) => { if (o.isMesh && o.name !== 'blurDisc' && !o.material.emissiveIntensity) o.castShadow = true; });
  m.materials = mats;
  return m;
}

export const HELI_LOOKS = {
  heli_news: { color: 0xf3f1ec, color2: 0x1f5fbf },
  heli_police: { color: 0x1d2a44, color2: 0xf1f1ee },
  heli_cargo: { color: 0xd9822b, color2: 0xf1efe8 },
};
