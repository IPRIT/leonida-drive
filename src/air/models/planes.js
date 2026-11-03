// Original low-poly fixed-wing designs with animated control surfaces, propellers and landing gear.
// Frame: x right, y up, -z forward, origin = centre of mass (matches PLANE_SPECS).
import * as THREE from 'three';
import { Builder, makeMaterials, blurDisc, propBlades, navLight, wheelMesh } from './kit.js';

/** Control surface hinged at z (leading edge), spanning x0..x1, extending aft by chord. */
function hinged(mats, mat, x0, x1, y, z, chord, t = 0.05, dihedral = 0) {
  const pivot = new THREE.Group();
  const xc = (x0 + x1) / 2;
  pivot.position.set(xc, y + Math.abs(xc) * Math.tan(dihedral), z);
  pivot.rotation.z = xc > 0 ? dihedral : -dihedral;
  const b = new Builder();
  b.box(mat, Math.abs(x1 - x0), t, chord, 0, 0, chord / 2);
  const inner = new THREE.Group();
  inner.add(b.build(mats));
  pivot.add(inner);
  return { pivot, inner };
}

/** Vertical hinged surface (rudder): hinge at z from y0 to y1. */
function rudderSurface(mats, mat, y0, y1, z, chord, t = 0.06, x = 0) {
  const pivot = new THREE.Group();
  pivot.position.set(x, (y0 + y1) / 2, z);
  const b = new Builder();
  b.box(mat, t, y1 - y0, chord, 0, 0, chord / 2);
  const inner = new THREE.Group();
  inner.add(b.build(mats));
  pivot.add(inner);
  return { pivot, inner };
}

function propeller(mats, r, n, z, y = 0, spinnerMat = 'paint2') {
  const pivot = new THREE.Group();
  pivot.position.set(0, y, z);
  const spin = new THREE.Group();
  spin.add(propBlades(mats, r, n, r * 0.16));
  const sp = new Builder();
  sp.cyl(spinnerMat, 0.02, r * 0.2, r * 0.36, 8, 0, 0, -r * 0.12, 'z');
  spin.add(sp.build(mats));
  const disc = blurDisc(r, 'z');
  pivot.add(spin, disc);
  return { pivot, spin, disc };
}

/** Landing gear leg for physics wheel w. kind: 'leg' (spring steel), 'strut' (oleo), 'fork'. */
function gearLeg(mats, w, { pant = null, legTop = null, retract = null } = {}) {
  const mount = new THREE.Group();
  mount.position.set(w.x, w.y, w.z);
  const fold = new THREE.Group();
  mount.add(fold);
  const axle = new THREE.Group();
  fold.add(axle);
  const spin = new THREE.Group();
  spin.add(wheelMesh(mats, w.radius, w.radius * 0.7));
  axle.add(spin);
  // strut from mount down to the axle, scaled at runtime
  const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1, 6), mats.metal);
  strut.geometry.translate(0, -0.5, 0);
  strut.castShadow = true;
  fold.add(strut);
  if (pant) {
    const p = new Builder();
    p.sphere(pant, w.radius * 1.15, 0, w.radius * 0.15, -w.radius * 0.1, 0.55, 0.75, 1.9);
    axle.add(p.build(mats));
  }
  if (legTop) {
    const l = new Builder();
    const dx = legTop[0] - w.x, dy = legTop[1] - w.y;
    const L = Math.hypot(dx, dy);
    l.box('metal', 0.08, L, 0.12, dx / 2, dy / 2, 0, 0, 0, -Math.atan2(dx, dy));
    mount.add(l.build(mats));
  }
  return { mount, fold, axle, spin, strut, retract };
}

function addLights(root, lights) {
  for (const l of Object.values(lights).flat()) root.add(l);
}

// ---------------- Pipit 150: high-wing trainer ----------------
function buildPipit(spec, mats) {
  const b = new Builder();
  b.loft('paint', [
    { z: -2.38, y: 0.0, w: 0.2, h: 0.2 },
    { z: -2.25, y: 0.0, w: 0.42, h: 0.42, b: 0.44 },
    { z: -1.45, y: 0.1, w: 0.56, h: 0.52, b: 0.56 },
    { z: -0.95, y: 0.26, w: 0.6, h: 0.7, b: 0.68 },
    { z: 0.7, y: 0.26, w: 0.6, h: 0.7, b: 0.62 },
    { z: 1.7, y: 0.28, w: 0.45, h: 0.5, b: 0.42 },
    { z: 3.6, y: 0.3, w: 0.2, h: 0.24, b: 0.16 },
    { z: 5.3, y: 0.33, w: 0.06, h: 0.1, b: 0.08 },
  ]);
  b.box('glass', 1.0, 0.56, 0.06, 0, 0.68, -1.12, -0.95, 0, 0);
  b.box('glass', 0.04, 0.42, 1.2, 0.6, 0.62, -0.3);
  b.box('glass', 0.04, 0.42, 1.2, -0.6, 0.62, -0.3);
  b.box('glass', 0.04, 0.32, 0.5, 0.52, 0.66, 0.85, 0, 0.12, 0);
  b.box('glass', 0.04, 0.32, 0.5, -0.52, 0.66, 0.85, 0, -0.12, 0);
  // trim stripes
  b.box('paint2', 1.23, 0.1, 2.6, 0, -0.08, -0.5);
  b.loft('paint2', [{ z: 1.7, y: 0.05, w: 0.46, h: 0.06 }, { z: 3.6, y: 0.22, w: 0.21, h: 0.04 }, { z: 5.2, y: 0.32, w: 0.08, h: 0.03 }]);
  // wing (dihedral 2°), struts
  const dh = 0.035;
  b.plates('paint', [[0.3, -1.0], [5.1, -0.95], [5.15, 0.2], [0.3, 0.2]], 0.12, 0.99, dh);
  b.plates('paint2', [[4.6, -0.97], [5.15, -0.95], [5.18, 0.2], [4.6, 0.2]], 0.13, 0.99, dh);
  for (const s of [-1, 1]) {
    const x0 = s * 0.56, y0 = -0.38, x1 = s * 2.65, y1 = 0.99 + 2.65 * Math.tan(dh) - 0.06;
    const L = Math.hypot(x1 - x0, y1 - y0);
    b.box('metal', 0.06, L, 0.12, (x0 + x1) / 2, (y0 + y1) / 2, -0.3, 0, 0, -Math.atan2(x1 - x0, y1 - y0));
  }
  // tail
  b.plates('paint', [[0.15, 4.45], [1.7, 4.62], [1.7, 4.95], [0.15, 4.98]], 0.06, 0.32);
  b.profile('paint', [[4.25, 0.45], [5.0, 0.45], [5.2, 1.55], [4.9, 1.55]], 0.07);
  b.profile('paint2', [[4.86, 1.3], [5.18, 1.3], [5.22, 1.55], [4.92, 1.55]], 0.08);
  // engine details
  b.box('dark', 0.5, 0.12, 0.3, 0, -0.42, -1.9);
  b.cyl('metal', 0.03, 0.03, 0.4, 5, 0.35, -0.42, -1.4, 'z');
  const root = b.build(mats);
  const surf = {
    ailL: hinged(mats, 'paint', -4.9, -2.75, 0.99, 0.2, 0.34, 0.08, dh),
    ailR: hinged(mats, 'paint', 2.75, 4.9, 0.99, 0.2, 0.34, 0.08, dh),
    flapL: hinged(mats, 'paint', -2.65, -0.6, 0.97, 0.2, 0.34, 0.08, dh),
    flapR: hinged(mats, 'paint', 0.6, 2.65, 0.97, 0.2, 0.34, 0.08, dh),
    elev: [hinged(mats, 'paint', -1.7, 1.7, 0.32, 4.97, 0.3, 0.05)],
    rudder: rudderSurface(mats, 'paint', 0.42, 1.52, 5.12, 0.3, 0.06),
  };
  for (const k of Object.keys(surf)) for (const s of [].concat(surf[k])) root.add(s.pivot);
  const W = spec.wheels;
  const gear = [
    gearLeg(mats, W[0], { pant: 'paint2' }),
    gearLeg(mats, W[1], { pant: 'paint2', legTop: [-0.5, -0.5] }),
    gearLeg(mats, W[2], { pant: 'paint2', legTop: [0.5, -0.5] }),
  ];
  for (const g of gear) root.add(g.mount);
  const prop = propeller(mats, 0.95, 2, -2.48, 0.0);
  root.add(prop.pivot);
  const lights = {
    navL: [navLight(mats.navRed, -5.17, 1.15, -0.4)],
    navR: [navLight(mats.navGreen, 5.17, 1.15, -0.4)],
    strobes: [navLight(mats.strobe, -5.17, 1.15, 0.0, 0.06), navLight(mats.strobe, 5.17, 1.15, 0.0, 0.06), navLight(mats.strobe, 0, 0.36, 5.35, 0.06)],
    beacons: [navLight(mats.beacon, 0, 1.6, 5.05, 0.07)],
  };
  addLights(root, lights);
  return { root, surf, gear, props: [prop], lights, landing: [-1.8, 0.92, -1.0], cockpit: [-0.3, 0.72, -0.45] };
}

// ---------------- Vortica S1: aerobatic taildragger ----------------
function buildVortica(spec, mats) {
  const b = new Builder();
  b.loft('paint', [
    { z: -2.2, y: 0.02, w: 0.48, h: 0.48, k: 0.3 },
    { z: -1.6, y: 0.04, w: 0.56, h: 0.54, b: 0.52, k: 0.3 },
    { z: -0.6, y: 0.06, w: 0.52, h: 0.48, b: 0.5 },
    { z: 0.9, y: 0.08, w: 0.44, h: 0.42, b: 0.42 },
    { z: 2.8, y: 0.12, w: 0.2, h: 0.24, b: 0.2 },
    { z: 4.55, y: 0.15, w: 0.06, h: 0.1, b: 0.08 },
  ]);
  // bubble canopy
  b.loft('glass', [
    { z: -0.75, y: 0.5, w: 0.22, h: 0.06, b: 0.02 },
    { z: -0.35, y: 0.5, w: 0.4, h: 0.32, b: 0.02, k: 0.55 },
    { z: 0.55, y: 0.5, w: 0.4, h: 0.3, b: 0.02, k: 0.55 },
    { z: 1.25, y: 0.5, w: 0.18, h: 0.08, b: 0.02 },
  ]);
  b.loft('paint', [{ z: 1.2, y: 0.5, w: 0.2, h: 0.08, b: 0.02 }, { z: 2.6, y: 0.33, w: 0.1, h: 0.05, b: 0.02 }]);
  // sunburst stripes
  for (let i = 0; i < 3; i++) b.box('paint2', 1.08, 0.07, 0.16, 0, -0.42 + i * 0.02, -1.5 + i * 0.5);
  b.box('paint2', 0.9, 0.1, 3.4, 0, -0.32, 0.9);
  // low wing (dihedral 1°)
  const dh = 0.018;
  b.plates('paint', [[0.4, -1.07], [3.8, -0.85], [3.8, 0.1], [0.4, 0.1]], 0.11, -0.18, dh);
  b.plates('paint2', [[1.6, -1.0], [2.0, -0.98], [2.0, 0.1], [1.6, 0.1]], 0.12, -0.18, dh);
  b.plates('paint', [[0.12, 3.85], [1.35, 3.95], [1.35, 4.32], [0.12, 4.35]], 0.06, 0.12);
  b.profile('paint', [[3.7, 0.3], [4.45, 0.3], [4.62, 1.15], [4.3, 1.15]], 0.07);
  b.profile('paint2', [[4.25, 0.95], [4.6, 0.95], [4.64, 1.15], [4.32, 1.15]], 0.08);
  // exhausts
  for (const s of [-1, 1]) b.cyl('metal', 0.04, 0.05, 0.3, 6, s * 0.5, -0.25, -1.3, 'z');
  const root = b.build(mats);
  const surf = {
    ailL: hinged(mats, 'paint', -3.75, -0.6, -0.18, 0.1, 0.28, 0.08, dh),
    ailR: hinged(mats, 'paint', 0.6, 3.75, -0.18, 0.1, 0.28, 0.08, dh),
    elev: [hinged(mats, 'paint', -1.35, 1.35, 0.12, 4.33, 0.3, 0.05)],
    rudder: rudderSurface(mats, 'paint', 0.3, 1.12, 4.5, 0.25, 0.06),
  };
  for (const k of Object.keys(surf)) for (const s of [].concat(surf[k])) root.add(s.pivot);
  const W = spec.wheels;
  const gear = [
    gearLeg(mats, W[0], { pant: 'paint2', legTop: [-0.35, -0.45] }),
    gearLeg(mats, W[1], { pant: 'paint2', legTop: [0.35, -0.45] }),
    gearLeg(mats, W[2]),
  ];
  for (const g of gear) root.add(g.mount);
  const prop = propeller(mats, 0.9, 3, -2.3, 0.02, 'paint2');
  root.add(prop.pivot);
  const lights = {
    navL: [navLight(mats.navRed, -3.82, -0.1, -0.5, 0.07)],
    navR: [navLight(mats.navGreen, 3.82, -0.1, -0.5, 0.07)],
    strobes: [navLight(mats.strobe, 0, 0.18, 4.58, 0.05)],
    beacons: [navLight(mats.beacon, 0, 1.17, 4.4, 0.06)],
  };
  addLights(root, lights);
  return { root, surf, gear, props: [prop], lights, landing: [-1.2, -0.25, -1.0], cockpit: [0, 0.78, 0.2], smoke: [0, -0.2, 4.5] };
}

// ---------------- Tarpon F4: float plane ----------------
function buildTarpon(spec, mats) {
  const b = new Builder();
  const floats = [];
  b.loft('paint', [
    { z: -2.62, y: 0.15, w: 0.22, h: 0.22 },
    { z: -2.45, y: 0.15, w: 0.46, h: 0.46, b: 0.48 },
    { z: -1.6, y: 0.24, w: 0.6, h: 0.58, b: 0.6 },
    { z: -1.05, y: 0.42, w: 0.64, h: 0.76, b: 0.7 },
    { z: 0.8, y: 0.42, w: 0.64, h: 0.76, b: 0.64 },
    { z: 1.9, y: 0.42, w: 0.48, h: 0.55, b: 0.45 },
    { z: 3.9, y: 0.42, w: 0.22, h: 0.26, b: 0.18 },
    { z: 5.6, y: 0.44, w: 0.06, h: 0.1, b: 0.08 },
  ]);
  b.box('glass', 1.08, 0.6, 0.06, 0, 0.88, -1.27, -0.95, 0, 0);
  b.box('glass', 0.04, 0.46, 1.4, 0.64, 0.82, -0.3);
  b.box('glass', 0.04, 0.46, 1.4, -0.64, 0.82, -0.3);
  b.box('paint2', 1.31, 0.14, 4.2, 0, 0.0, 0.1);
  const dh = 0.03;
  b.plates('paint', [[0.3, -1.12], [6.3, -1.05], [6.35, 0.18], [0.3, 0.2]], 0.13, 1.18, dh);
  b.plates('paint2', [[5.7, -1.08], [6.35, -1.05], [6.38, 0.18], [5.7, 0.18]], 0.14, 1.18, dh);
  for (const s of [-1, 1]) {
    const x0 = s * 0.6, y0 = -0.2, x1 = s * 3.2, y1 = 1.18 + 3.2 * Math.tan(dh) - 0.06;
    const L = Math.hypot(x1 - x0, y1 - y0);
    b.box('metal', 0.07, L, 0.13, (x0 + x1) / 2, (y0 + y1) / 2, -0.35, 0, 0, -Math.atan2(x1 - x0, y1 - y0));
  }
  b.plates('paint', [[0.15, 4.75], [1.85, 4.9], [1.85, 5.22], [0.15, 5.26]], 0.06, 0.42);
  b.profile('paint', [[4.5, 0.6], [5.3, 0.6], [5.52, 1.85], [5.2, 1.85]], 0.08);
  b.profile('paint2', [[5.12, 1.55], [5.5, 1.55], [5.55, 1.85], [5.22, 1.85]], 0.09);
  b.profile('paint', [[4.9, 0.3], [5.45, 0.3], [5.55, -0.2], [5.2, -0.2]], 0.06);
  // floats (pontoons) + struts
  for (const s of [-1, 1]) {
    const f = new Builder();
    f.loft('white', [
      { z: -3.45, y: -1.5, w: 0.08, h: 0.06, b: 0.04 },
      { z: -3.0, y: -1.58, w: 0.28, h: 0.22, b: 0.2 },
      { z: -1.6, y: -1.62, w: 0.32, h: 0.26, b: 0.28 },
      { z: 0.4, y: -1.62, w: 0.32, h: 0.26, b: 0.26 },
      { z: 3.2, y: -1.55, w: 0.12, h: 0.12, b: 0.1 },
    ]);
    f.box('paint2', 0.66, 0.06, 4.6, 0, -1.42, -0.6);
    const g = f.build(mats);
    g.position.x = s * 1.45;
    floats.push(g);
    for (const [z, x0] of [[-1.5, 0.45], [0.6, 0.45]]) {
      const xa = s * x0, ya = -0.3, xb = s * 1.45, yb = -1.38;
      const L = Math.hypot(xb - xa, yb - ya);
      b.box('metal', 0.07, L, 0.1, (xa + xb) / 2, (ya + yb) / 2, z, 0, 0, -Math.atan2(xb - xa, yb - ya));
    }
  }
  b.cyl('metal', 0.04, 0.04, 2.9, 6, 0, -1.38, -1.5, 'x');
  b.cyl('metal', 0.04, 0.04, 2.9, 6, 0, -1.38, 0.6, 'x');
  const root = b.build(mats);
  for (const g of floats) root.add(g);
  const surf = {
    ailL: hinged(mats, 'paint', -6.1, -3.6, 1.18, 0.18, 0.36, 0.09, dh),
    ailR: hinged(mats, 'paint', 3.6, 6.1, 1.18, 0.18, 0.36, 0.09, dh),
    flapL: hinged(mats, 'paint', -3.5, -0.65, 1.16, 0.18, 0.36, 0.09, dh),
    flapR: hinged(mats, 'paint', 0.65, 3.5, 1.16, 0.18, 0.36, 0.09, dh),
    elev: [hinged(mats, 'paint', -1.85, 1.85, 0.42, 5.24, 0.32, 0.05)],
    rudder: rudderSurface(mats, 'paint', 0.55, 1.82, 5.45, 0.32, 0.07),
  };
  for (const k of Object.keys(surf)) for (const s of [].concat(surf[k])) root.add(s.pivot);
  const prop = propeller(mats, 1.05, 3, -2.7, 0.15);
  root.add(prop.pivot);
  const lights = {
    navL: [navLight(mats.navRed, -6.4, 1.38, -0.45)],
    navR: [navLight(mats.navGreen, 6.4, 1.38, -0.45)],
    strobes: [navLight(mats.strobe, -6.4, 1.38, 0.05, 0.06), navLight(mats.strobe, 6.4, 1.38, 0.05, 0.06), navLight(mats.strobe, 0, 0.47, 5.65, 0.06)],
    beacons: [navLight(mats.beacon, 0, 1.9, 5.35, 0.07)],
  };
  addLights(root, lights);
  return { root, surf, gear: [], props: [prop], lights, landing: [-2.0, 1.1, -1.12], cockpit: [-0.32, 0.92, -0.5] };
}

// ---------------- Solstice 7: business jet ----------------
function buildSolstice(spec, mats) {
  const b = new Builder();
  b.loft('paint', [
    { z: -8.45, y: -0.18, w: 0.1, h: 0.1 },
    { z: -8.0, y: -0.08, w: 0.48, h: 0.42, b: 0.46 },
    { z: -7.0, y: 0.08, w: 0.85, h: 0.82, b: 0.86 },
    { z: -5.6, y: 0.12, w: 0.98, h: 0.98, b: 0.98 },
    { z: 3.8, y: 0.12, w: 0.98, h: 0.98, b: 0.98 },
    { z: 6.4, y: 0.42, w: 0.62, h: 0.66, b: 0.5 },
    { z: 8.4, y: 0.85, w: 0.14, h: 0.22, b: 0.14 },
  ]);
  b.loft('glass', [
    { z: -7.55, y: 0.22, w: 0.55, h: 0.18, b: 0.04 },
    { z: -6.85, y: 0.55, w: 0.82, h: 0.32, b: 0.04 },
    { z: -6.35, y: 0.7, w: 0.86, h: 0.24, b: 0.04 },
  ], { capEnd: false });
  for (let i = 0; i < 7; i++) {
    b.box('glass', 0.05, 0.32, 0.36, 0.975, 0.45, -4.6 + i * 1.05);
    b.box('glass', 0.05, 0.32, 0.36, -0.975, 0.45, -4.6 + i * 1.05);
  }
  b.box('paint2', 1.99, 0.12, 12.4, 0, -0.08, -1.6);
  b.box('paint2', 1.99, 0.05, 12.4, 0, 0.08, -1.6);
  // swept wing + winglets
  const dh = 0.05;
  b.plates('paint', [[0.85, -0.9], [8.1, 2.4], [8.1, 3.15], [4.3, 2.05], [0.85, 1.95]], 0.16, -0.45, dh);
  for (const s of [-1, 1]) b.profile('paint', [[2.4, 0], [3.2, 0], [3.5, 1.3], [3.15, 1.3]].map(([z, y]) => [z, y - 0.05 + 8.1 * Math.tan(dh) - 0.45]), 0.06, s * 8.12);
  // engines on pylons
  for (const s of [-1, 1]) {
    b.cyl('paint', 0.55, 0.48, 3.2, 12, s * 1.62, 0.65, 5.0, 'z');
    b.cyl('dark', 0.45, 0.45, 0.06, 12, s * 1.62, 0.65, 3.38, 'z');
    b.cyl('dark', 0.36, 0.3, 0.4, 10, s * 1.62, 0.65, 6.7, 'z');
    b.box('paint', 0.6, 0.14, 1.6, s * 1.05, 0.62, 5.1, 0, 0, -s * 0.15);
  }
  // T-tail fin
  b.profile('paint', [[6.0, 0.95], [7.8, 0.95], [8.65, 3.2], [7.6, 3.2]], 0.14);
  b.profile('paint2', [[7.4, 2.6], [8.4, 2.6], [8.65, 3.2], [7.6, 3.2]], 0.15);
  b.plates('paint', [[0.1, 7.05], [2.6, 7.75], [2.6, 8.05], [0.1, 8.0]], 0.08, 3.18);
  const root = b.build(mats);
  const surf = {
    ailL: hinged(mats, 'paint', -7.4, -4.6, -0.45, 2.6, 0.4, 0.09, dh),
    ailR: hinged(mats, 'paint', 4.6, 7.4, -0.45, 2.6, 0.4, 0.09, dh),
    flapL: hinged(mats, 'paint', -4.4, -1.0, -0.47, 1.95, 0.55, 0.1, dh),
    flapR: hinged(mats, 'paint', 1.0, 4.4, -0.47, 1.95, 0.55, 0.1, dh),
    elev: [hinged(mats, 'paint', -2.6, 2.6, 3.18, 8.02, 0.35, 0.06)],
    rudder: rudderSurface(mats, 'paint', 1.0, 2.55, 7.95, 0.45, 0.1),
  };
  // swept surfaces: align the aileron hinge with the trailing edge
  surf.ailL.pivot.rotation.y = -0.42; surf.ailR.pivot.rotation.y = 0.42;
  surf.ailL.pivot.position.z = 2.85; surf.ailR.pivot.position.z = 2.85;
  for (const k of Object.keys(surf)) for (const s of [].concat(surf[k])) root.add(s.pivot);
  const W = spec.wheels;
  const gear = [
    gearLeg(mats, W[0], { retract: { axis: 'x', angle: -1.65 } }),
    gearLeg(mats, W[1], { retract: { axis: 'z', angle: -1.6 } }),
    gearLeg(mats, W[2], { retract: { axis: 'z', angle: 1.6 } }),
  ];
  for (const g of gear) root.add(g.mount);
  const lights = {
    navL: [navLight(mats.navRed, -8.15, -0.2, 2.5)],
    navR: [navLight(mats.navGreen, 8.15, -0.2, 2.5)],
    strobes: [navLight(mats.strobe, -8.15, -0.2, 3.1, 0.07), navLight(mats.strobe, 8.15, -0.2, 3.1, 0.07), navLight(mats.strobe, 0, 3.25, 8.4, 0.07)],
    beacons: [navLight(mats.beacon, 0, 1.12, -1.0, 0.09), navLight(mats.beacon, 0, -0.88, 1.0, 0.09)],
  };
  addLights(root, lights);
  const engines = [-1, 1].map((s) => ({ x: s * 1.62, y: 0.65, z: 6.9 }));
  return { root, surf, gear, props: [], engines, lights, landing: [0, -0.7, -5.2], cockpit: [-0.45, 0.62, -6.55] };
}

const BUILDERS = { plane_trainer: buildPipit, plane_stunt: buildVortica, plane_seaplane: buildTarpon, plane_jet: buildSolstice };

export const PLANE_LOOKS = {
  plane_trainer: { color: 0xf4f2ee, color2: 0xd23a3a },
  plane_stunt: { color: 0xd4263f, color2: 0xfff1d6 },
  plane_seaplane: { color: 0x1ca6a0, color2: 0xf6c341 },
  plane_jet: { color: 0xf5f6f8, color2: 0x1f2f5c },
};

export function buildPlaneModel(id, spec, { color, color2 } = {}) {
  const look = PLANE_LOOKS[id];
  const mats = makeMaterials(color ?? look.color, color2 ?? look.color2);
  const m = BUILDERS[id](spec, mats);
  m.root.traverse((o) => { if (o.isMesh && o.name !== 'blurDisc' && !(o.material.emissiveIntensity > 0)) o.castShadow = true; });
  m.materials = mats;
  return m;
}
