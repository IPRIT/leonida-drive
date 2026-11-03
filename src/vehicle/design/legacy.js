// The six original hand-made designs (comet, muscle, super, suv, pickup, cruiser), ported to the
// array-based toolkit. Lamps/sirens are emitted as material buckets and split per side by the assembler.
import { arch, box, cyl, slab, extrudeSide, warp, classify } from './geom.js';

function split(a, cls) {
  const n = { x: 0, y: 0, z: 0 }, c = { x: 0, y: 0, z: 0 };
  return classify(a, (nx, ny, nz, cx, cy, cz) => {
    n.x = nx; n.y = ny; n.z = nz; c.x = cx; c.y = cy; c.z = cz;
    return cls(n, c);
  });
}

function cabinClassifier(roofY, z0, z1, extra) {
  return (n, c) => {
    if (n.y < -0.5) return null;
    if (extra) {
      const k = extra(n, c);
      if (k !== undefined) return k;
    }
    if (c.y > roofY - 0.035 && c.z > z0 && c.z < z1) return 'paint';
    const ax = Math.abs(n.x);
    if (ax > 0.3 && ax < 0.92 && Math.abs(n.z) > 0.18 && c.y > roofY * 0.75) return 'paint';
    return 'glass';
  };
}

function bodyClassifier(cladY = -1, extra) {
  return (n, c) => {
    if (extra) {
      const k = extra(n, c);
      if (k !== undefined) return k;
    }
    if (n.y < -0.55) return 'dark';
    if (c.y < cladY) return 'trim';
    return 'paint';
  };
}

function add(parts, key, g) {
  if (!g) return;
  (parts[key] ||= []).push(g);
}
function addAll(parts, dict) {
  for (const k of Object.keys(dict)) add(parts, k, dict[k]);
}

function pillar(parts, mat, z, y0, y1, halfW, tumble, yRef, yRange, depth = 0.12) {
  const xAt = (y) => halfW * (1 - tumble * Math.max(0, (y - yRef) / yRange)) + 0.012;
  const xa = xAt(y0), xb = xAt(y1);
  const ang = Math.atan2(xa - xb, y1 - y0);
  for (const sx of [1, -1]) add(parts, mat, box(0.03, (y1 - y0) / Math.cos(ang), depth, sx * (xa + xb) / 2, (y0 + y1) / 2, z, 0, 0, sx * ang));
}

function mirror(parts, mat, sx, x, y, z, size = 0.14) {
  add(parts, mat, box(size, size * 0.6, size * 0.75, sx * x, y, z));
  add(parts, 'trim', box(0.14, 0.03, 0.05, sx * (x - 0.1), y - 0.03, z + 0.02));
}

function pair(fn) {
  return [fn(1), fn(-1)];
}

export const LEGACY_DESIGNS = {
  comet(s) {
    const r = s.wheelRadius, zf = -s.wheelbase / 2, zr = s.wheelbase / 2;
    const P = {};
    const sill = 0.19;
    const body = [
      [-2.12, 0.22],
      ...arch(zf, r, r + 0.07, sill, 7),
      ...arch(zr, r, r + 0.08, sill, 7),
      [2.1, 0.24], [2.17, 0.32], [2.18, 0.62], [2.12, 0.88], [1.6, 0.9],
      [-0.6, 0.85], [-1.55, 0.74], [-2.06, 0.63], [-2.18, 0.5], [-2.17, 0.3],
    ];
    const bg = warp(extrudeSide(body, 1.82, 0.07, 0.06), (v) => {
      const k = 1 - 0.07 * Math.max(0, (-v.z - 1.6) / 0.6) ** 2 - 0.04 * Math.max(0, (v.z - 1.7) / 0.5) ** 2;
      v.x *= k;
    });
    addAll(P, split(bg, bodyClassifier(0.27)));
    const cab = [[-0.66, 0.84], [0.12, 1.15], [0.86, 1.16], [1.78, 0.9], [1.78, 0.83], [-0.66, 0.83]];
    const cg = warp(extrudeSide(cab, 1.44, 0.13, 0.11), (v) => {
      v.x *= 1 - 0.1 * Math.max(0, (v.y - 0.85) / 0.3);
    });
    addAll(P, split(cg, cabinClassifier(1.15, 0.15, 0.84)));
    // bumpers, skirts, louvers
    add(P, 'trim', box(1.78, 0.12, 0.1, 0, 0.27, -2.15));
    add(P, 'trim', box(1.8, 0.12, 0.1, 0, 0.3, 2.15));
    add(P, 'dark', box(1.2, 0.05, 0.06, 0, 0.42, -2.17));
    add(P, 'dark', box(1.55, 0.05, 0.42, 0, 0.905, 1.98));
    for (let i = 0; i < 4; i++) add(P, 'dark', box(1.5, 0.025, 0.04, 0, 0.94, 1.5 + i * 0.1));
    // tail bar + reverse
    add(P, 'tail', box(1.56, 0.12, 0.04, 0, 0.66, 2.18));
    add(P, 'reverse', box(0.16, 0.06, 0.045, 0.32, 0.55, 2.18));
    add(P, 'reverse', box(0.16, 0.06, 0.045, -0.32, 0.55, 2.18));
    add(P, 'amber', box(0.26, 0.05, 0.04, 0.62, 0.43, -2.16));
    add(P, 'amber', box(0.26, 0.05, 0.04, -0.62, 0.43, -2.16));
    // spoiler
    add(P, 'paint', box(1.5, 0.05, 0.26, 0, 1.0, 1.98, 0.08));
    add(P, 'trim', box(0.05, 0.1, 0.12, 0.6, 0.94, 2.0));
    add(P, 'trim', box(0.05, 0.1, 0.12, -0.6, 0.94, 2.0));
    // mirrors
    for (const sx of [1, -1]) mirror(P, 'paint', sx, 0.86, 0.9, -0.42);
    add(P, 'chrome', cyl(0.035, 0.035, 0.2, 8, 0.45, 0.24, 2.18, 'z'));
    add(P, 'chrome', cyl(0.035, 0.035, 0.2, 8, 0.55, 0.24, 2.18, 'z'));
    // pop-up headlights
    const popups = pair((sx) => ({ x: sx * 0.55, y: 0.645, z: -1.92, w: 0.44, d: 0.24 }));
    return {
      parts: P,
      popups,
      lamps: { head: [[0.55, 0.62, -2.05], [-0.55, 0.62, -2.05]], tail: [[0, 0.66, 2.2]] },
      rim: 'chrome',
      spokes: 5,
      rimStyle: 'turbine',
    };
  },

  muscle(s) {
    const r = s.wheelRadius, zf = -s.wheelbase / 2, zr = s.wheelbase / 2;
    const P = {};
    const sill = 0.21;
    const body = [
      [-2.38, 0.24],
      ...arch(zf, r, r + 0.07, sill, 7),
      ...arch(zr, r, r + 0.08, sill, 7),
      [2.38, 0.27], [2.42, 0.36], [2.43, 0.86], [2.38, 0.99], [1.58, 0.98],
      [-0.32, 0.98], [-2.2, 0.96], [-2.43, 0.92], [-2.45, 0.52], [-2.42, 0.3],
    ];
    const bg = warp(extrudeSide(body, 1.92, 0.06, 0.05), (v) => {
      v.x *= 1 - 0.03 * Math.max(0, (-v.z - 1.9) / 0.5);
    });
    addAll(P, split(bg, bodyClassifier(0.26)));
    const cab = [[-0.36, 0.96], [0.34, 1.29], [1.02, 1.3], [1.66, 1.0], [1.66, 0.95], [-0.36, 0.95]];
    const cg = warp(extrudeSide(cab, 1.5, 0.12, 0.1), (v) => {
      v.x *= 1 - 0.08 * Math.max(0, (v.y - 0.98) / 0.32);
    });
    addAll(P, split(cg, cabinClassifier(1.29, 0.36, 1.0)));
    // hood scoop + stripes
    add(P, 'paint', slab([[-1.75, 0.96], [-1.6, 1.06], [-1.0, 1.06], [-0.95, 0.96]], -0.32, 0.32));
    add(P, 'dark', box(0.5, 0.06, 0.04, 0, 1.02, -1.7));
    add(P, 'paint2', box(0.16, 0.012, 1.9, 0.14, 0.968, -1.3));
    add(P, 'paint2', box(0.16, 0.012, 1.9, -0.14, 0.968, -1.3));
    add(P, 'paint2', box(0.16, 0.012, 0.75, 0.14, 1.306, 0.67));
    add(P, 'paint2', box(0.16, 0.012, 0.75, -0.14, 1.306, 0.67));
    add(P, 'paint2', box(0.16, 0.012, 0.75, 0.14, 0.99, 2.0));
    add(P, 'paint2', box(0.16, 0.012, 0.75, -0.14, 0.99, 2.0));
    // grille + quad lamps
    add(P, 'dark', box(1.6, 0.3, 0.06, 0, 0.7, -2.44));
    add(P, 'chrome', box(1.7, 0.03, 0.07, 0, 0.86, -2.445));
    add(P, 'chrome', box(1.7, 0.03, 0.07, 0, 0.54, -2.445));
    for (const x of [0.62, 0.38, -0.38, -0.62]) add(P, 'head', cyl(0.085, 0.085, 0.05, 10, x, 0.7, -2.46, 'z'));
    add(P, 'chrome', box(1.86, 0.1, 0.1, 0, 0.32, -2.44));
    add(P, 'chrome', box(1.86, 0.1, 0.1, 0, 0.34, 2.44));
    // tail lamps
    add(P, 'tail', box(0.62, 0.13, 0.04, 0.5, 0.74, 2.44));
    add(P, 'tail', box(0.62, 0.13, 0.04, -0.5, 0.74, 2.44));
    add(P, 'reverse', box(0.12, 0.13, 0.045, 0, 0.74, 2.44));
    add(P, 'dark', box(1.0, 0.06, 0.03, 0, 0.95, 2.4));
    for (const sx of [1, -1]) mirror(P, 'chrome', sx, 0.9, 1.07, -0.12);
    for (const sx of [1, -1]) add(P, 'chrome', cyl(0.045, 0.045, 0.25, 8, sx * 0.6, 0.24, 2.42, 'z'));
    return {
      parts: P,
      lamps: { head: [[0.5, 0.7, -2.5], [-0.5, 0.7, -2.5]], tail: [[0, 0.74, 2.46]] },
      rim: 'chrome',
      spokes: 5,
      rimStyle: 'star',
    };
  },

  super(s) {
    const r = s.wheelRadius, zf = -s.wheelbase / 2, zr = s.wheelbase / 2;
    const P = {};
    const sill = 0.16;
    const body = [
      [-2.25, 0.17],
      ...arch(zf, r, r + 0.06, sill, 7),
      ...arch(zr, r, r + 0.07, sill, 7),
      [2.27, 0.2], [2.31, 0.32], [2.33, 0.78], [2.2, 0.9], [0.9, 0.98], [0.1, 0.8],
      [-1.0, 0.78], [-1.9, 0.62], [-2.27, 0.44], [-2.31, 0.3],
    ];
    const bg = warp(extrudeSide(body, 2.02, 0.09, 0.08), (v) => {
      const front = Math.max(0, (-v.z - 1.4) / 0.9);
      v.x *= 1 - 0.12 * front * front;
      v.x *= 1 - 0.05 * Math.max(0, (v.y - 0.6) / 0.35); // shoulder tuck
    });
    addAll(P, split(bg, bodyClassifier(0.22)));
    const cab = [[-1.12, 0.75], [-0.22, 1.11], [0.42, 1.12], [1.25, 0.94], [1.3, 0.85], [-1.12, 0.73]];
    const cg = warp(extrudeSide(cab, 1.46, 0.16, 0.13), (v) => {
      v.x *= 1 - 0.12 * Math.max(0, (v.y - 0.78) / 0.34);
    });
    addAll(P, split(cg, cabinClassifier(1.11, -0.2, 0.4)));
    // side intakes, splitter, diffuser
    for (const sx of [1, -1]) add(P, 'dark', slab([[0.45, 0.32], [0.62, 0.68], [0.95, 0.66], [0.95, 0.3]], sx * 0.93 - 0.06, sx * 0.93 + 0.06));
    add(P, 'dark', box(1.9, 0.04, 0.3, 0, 0.16, -2.15));
    add(P, 'dark', box(1.7, 0.2, 0.3, 0, 0.27, 2.2));
    for (let i = -2; i <= 2; i++) add(P, 'trim', box(0.03, 0.16, 0.3, i * 0.32, 0.22, 2.25));
    add(P, 'dark', box(1.2, 0.1, 0.05, 0, 0.32, -2.3));
    // headlight blades
    for (const sx of [1, -1]) add(P, 'head', box(0.42, 0.05, 0.14, sx * 0.68, 0.55, -2.1, 0.45, sx * -0.25));
    add(P, 'tail', box(1.85, 0.05, 0.05, 0, 0.74, 2.33));
    for (const sx of [1, -1]) add(P, 'tail', box(0.18, 0.1, 0.05, sx * 0.88, 0.7, 2.31));
    add(P, 'reverse', box(0.2, 0.05, 0.05, 0, 0.62, 2.33));
    // rear wing
    add(P, 'paint2', box(1.9, 0.04, 0.34, 0, 1.12, 2.08, -0.1));
    for (const sx of [1, -1]) {
      add(P, 'paint2', box(0.04, 0.18, 0.4, sx * 0.97, 1.1, 2.08));
      add(P, 'trim', box(0.05, 0.2, 0.08, sx * 0.55, 1.0, 2.05));
    }
    for (const sx of [1, -1]) mirror(P, 'paint', sx, 0.92, 0.88, -0.72);
    for (const sx of [1, -1]) add(P, 'chrome', cyl(0.05, 0.05, 0.12, 8, sx * 0.12, 0.45, 2.31, 'z'));
    return {
      parts: P,
      lamps: { head: [[0.68, 0.55, -2.2], [-0.68, 0.55, -2.2]], tail: [[0, 0.74, 2.35]] },
      rim: 'dark',
      spokes: 10,
      rimStyle: 'mesh',
    };
  },

  suv(s) {
    const r = s.wheelRadius, zf = -s.wheelbase / 2, zr = s.wheelbase / 2;
    const P = {};
    const sill = 0.34;
    const body = [
      [-2.33, 0.42],
      ...arch(zf, r, r + 0.08, sill, 7),
      ...arch(zr, r, r + 0.08, sill, 7),
      [2.33, 0.44], [2.39, 0.52], [2.4, 1.16], [2.36, 1.19], [-0.6, 1.17],
      [-2.2, 1.12], [-2.38, 1.06], [-2.41, 0.56],
    ];
    const bg = extrudeSide(body, 1.96, 0.06, 0.05);
    addAll(P, split(bg, bodyClassifier(0.52)));
    const cab = [[-0.65, 1.15], [0.02, 1.82], [2.24, 1.85], [2.38, 1.24], [2.38, 1.15]];
    const cg = warp(extrudeSide(cab, 1.78, 0.1, 0.09), (v) => {
      v.x *= 1 - 0.06 * Math.max(0, (v.y - 1.18) / 0.66);
    });
    addAll(
      P,
      split(cg, cabinClassifier(1.82, 0.0, 2.25, (n, c) => (c.z > 2.3 && n.z > 0.5 && c.y < 1.45 ? 'paint' : undefined))),
    );
    pillar(P, 'paint', 0.82, 1.2, 1.8, 0.89, 0.06, 1.18, 0.66, 0.14);
    pillar(P, 'paint', 1.72, 1.2, 1.82, 0.89, 0.06, 1.18, 0.66, 0.2);
    // roof rails, grille, bumpers
    for (const sx of [1, -1]) {
      add(P, 'trim', box(0.05, 0.05, 2.1, sx * 0.72, 1.89, 1.15));
      add(P, 'trim', box(0.06, 0.08, 0.06, sx * 0.72, 1.86, 0.2));
      add(P, 'trim', box(0.06, 0.08, 0.06, sx * 0.72, 1.86, 2.1));
    }
    add(P, 'dark', box(1.3, 0.34, 0.05, 0, 0.84, -2.41));
    for (let i = 0; i < 3; i++) add(P, 'chrome', box(1.3, 0.035, 0.06, 0, 0.74 + i * 0.1, -2.42));
    for (const sx of [1, -1]) add(P, 'head', box(0.3, 0.16, 0.05, sx * 0.78, 0.9, -2.42));
    for (const sx of [1, -1]) add(P, 'amber', box(0.3, 0.05, 0.05, sx * 0.78, 0.78, -2.42));
    add(P, 'trim', box(1.98, 0.22, 0.14, 0, 0.5, -2.4));
    add(P, 'dark', box(1.0, 0.08, 0.3, 0, 0.36, -2.4));
    add(P, 'trim', box(1.98, 0.2, 0.14, 0, 0.52, 2.4));
    for (const sx of [1, -1]) {
      add(P, 'tail', box(0.12, 0.42, 0.05, sx * 0.9, 1.0, 2.41));
      add(P, 'reverse', box(0.12, 0.08, 0.055, sx * 0.9, 0.74, 2.41));
    }
    // spare wheel
    add(P, 'tire', cyl(0.36, 0.36, 0.22, 12, 0, 1.0, 2.52, 'z'));
    add(P, 'paint', cyl(0.25, 0.25, 0.04, 12, 0, 1.0, 2.64, 'z'));
    for (const sx of [1, -1]) mirror(P, 'trim', sx, 1.02, 1.36, -0.42, 0.16);
    add(P, 'chrome', cyl(0.05, 0.05, 0.2, 8, 0.6, 0.38, 2.4, 'z'));
    return {
      parts: P,
      lamps: { head: [[0.78, 0.9, -2.46], [-0.78, 0.9, -2.46]], tail: [[0, 1.0, 2.44]] },
      rim: 'dark',
      spokes: 6,
      rimStyle: 'star',
    };
  },

  pickup(s) {
    const r = s.wheelRadius, zf = -s.wheelbase / 2, zr = s.wheelbase / 2;
    const P = {};
    const sill = 0.36;
    const body = [
      [-2.6, 0.44],
      ...arch(zf, r, r + 0.08, sill, 7),
      ...arch(zr, r, r + 0.08, sill, 7),
      [2.6, 0.46], [2.65, 0.56], [2.66, 0.95], [0.62, 0.95], [0.58, 1.2], [-0.92, 1.2],
      [-2.35, 1.16], [-2.63, 1.1], [-2.66, 0.56],
    ];
    const bg = extrudeSide(body, 1.98, 0.06, 0.05);
    addAll(P, split(bg, bodyClassifier(0.46)));
    const cab = [[-0.97, 1.18], [-0.38, 1.84], [0.5, 1.86], [0.58, 1.24], [0.58, 1.17]];
    const cg = warp(extrudeSide(cab, 1.78, 0.1, 0.09), (v) => {
      v.x *= 1 - 0.05 * Math.max(0, (v.y - 1.2) / 0.66);
    });
    addAll(P, split(cg, cabinClassifier(1.84, -0.35, 0.48)));
    // bed
    for (const sx of [1, -1]) add(P, 'paint', box(0.08, 0.32, 2.06, sx * 0.95, 1.1, 1.62));
    add(P, 'paint', box(1.98, 0.36, 0.08, 0, 1.12, 2.62));
    add(P, 'dark', box(1.82, 0.02, 2.0, 0, 0.96, 1.62));
    add(P, 'trim', box(1.98, 0.04, 0.06, 0, 1.28, 2.62));
    // grille / bumpers / lamps
    add(P, 'chrome', box(1.5, 0.42, 0.06, 0, 0.86, -2.66));
    add(P, 'dark', box(1.3, 0.3, 0.07, 0, 0.86, -2.665));
    for (const sx of [1, -1]) add(P, 'head', box(0.24, 0.2, 0.05, sx * 0.84, 0.92, -2.66));
    add(P, 'chrome', box(2.02, 0.16, 0.16, 0, 0.5, -2.66));
    add(P, 'chrome', box(2.02, 0.14, 0.14, 0, 0.5, 2.68));
    for (const sx of [1, -1]) {
      add(P, 'tail', box(0.08, 0.3, 0.05, sx * 0.93, 1.06, 2.665));
      add(P, 'reverse', box(0.08, 0.07, 0.055, sx * 0.93, 0.86, 2.665));
      mirror(P, 'chrome', sx, 1.03, 1.36, -0.72, 0.18);
    }
    add(P, 'chrome', cyl(0.05, 0.05, 0.25, 8, 0.7, 0.4, 2.6, 'z'));
    return {
      parts: P,
      lamps: { head: [[0.84, 0.92, -2.7], [-0.84, 0.92, -2.7]], tail: [[0, 1.06, 2.7]] },
      rim: 'chrome',
      spokes: 6,
      rimStyle: 'steel',
    };
  },

  cruiser(s) {
    const r = s.wheelRadius, zf = -s.wheelbase / 2, zr = s.wheelbase / 2;
    const P = {};
    const sill = 0.22;
    const body = [
      [-2.48, 0.26],
      ...arch(zf, r, r + 0.07, sill, 7),
      ...arch(zr, r, r + 0.07, sill, 7),
      [2.48, 0.28], [2.52, 0.38], [2.53, 0.92], [2.46, 1.0], [1.32, 1.0],
      [-0.8, 0.98], [-2.3, 0.94], [-2.52, 0.86], [-2.53, 0.4],
    ];
    const bg = warp(extrudeSide(body, 1.9, 0.07, 0.06), (v) => {
      v.x *= 1 - 0.04 * Math.max(0, (-v.z - 2.0) / 0.5);
    });
    // two-tone: light doors / dark ends
    addAll(
      P,
      split(bg, bodyClassifier(0.27, (n, c) => (n.y < 0.6 && c.y > 0.27 && Math.abs(c.z) > 1.15 ? 'paint2' : n.y >= 0.6 && Math.abs(c.z) > 1.3 ? 'paint2' : undefined))),
    );
    const cab = [[-0.84, 0.96], [-0.12, 1.43], [0.86, 1.44], [1.38, 1.0], [1.38, 0.95], [-0.84, 0.95]];
    const cg = warp(extrudeSide(cab, 1.56, 0.11, 0.09), (v) => {
      v.x *= 1 - 0.07 * Math.max(0, (v.y - 0.98) / 0.46);
    });
    addAll(P, split(cg, cabinClassifier(1.43, -0.1, 0.84)));
    pillar(P, 'paint2', 0.42, 1.0, 1.42, 0.78, 0.07, 0.98, 0.46, 0.13);
    // light bar
    add(P, 'dark', box(1.25, 0.07, 0.28, 0, 1.5, 0.35));
    const lightbar = { red: [box(0.56, 0.09, 0.22, -0.31, 1.575, 0.35)], blue: [box(0.56, 0.09, 0.22, 0.31, 1.575, 0.35)] };
    // push bar
    for (const sx of [1, -1]) add(P, 'dark', box(0.07, 0.42, 0.07, sx * 0.42, 0.62, -2.66));
    add(P, 'dark', box(1.0, 0.07, 0.07, 0, 0.78, -2.66));
    add(P, 'dark', box(1.0, 0.07, 0.07, 0, 0.5, -2.66));
    for (const sx of [1, -1]) add(P, 'dark', box(0.06, 0.06, 0.16, sx * 0.42, 0.62, -2.58));
    add(P, 'dark', box(1.0, 0.16, 0.05, 0, 0.72, -2.53));
    for (const sx of [1, -1]) add(P, 'head', box(0.34, 0.12, 0.05, sx * 0.68, 0.76, -2.53));
    add(P, 'trim', box(1.9, 0.14, 0.12, 0, 0.33, -2.5));
    add(P, 'trim', box(1.9, 0.14, 0.12, 0, 0.35, 2.5));
    for (const sx of [1, -1]) {
      add(P, 'tail', box(0.36, 0.14, 0.05, sx * 0.7, 0.8, 2.53));
      add(P, 'reverse', box(0.12, 0.06, 0.055, sx * 0.44, 0.8, 2.53));
      mirror(P, 'paint2', sx, 0.9, 1.06, -0.58);
    }
    add(P, 'chrome', cyl(0.12, 0.12, 0.08, 10, 0.86, 1.08, -0.68, 'z'));
    add(P, 'chrome', cyl(0.045, 0.045, 0.2, 8, 0.6, 0.26, 2.5, 'z'));
    return {
      parts: P,
      lightbar,
      lamps: { head: [[0.68, 0.76, -2.58], [-0.68, 0.76, -2.58]], tail: [[0, 0.8, 2.56]] },
      rim: 'dark',
      spokes: 0,
      rimStyle: 'steel',
    };
  },
};

// Approximate damage zones of the legacy designs (model space).
export const LEGACY_ZONES = {
  comet: { zF: -2.18, zR: 2.18, zA: -0.62, zC: 1.7, deck: true, hatch: false, sill: 0.2, beltF: 0.85, beltR: 0.9, roofY: 1.16, doors: [{ z0: -0.55, z1: 0.75, rear: false }], bumperF: -1.85, bumperR: 1.9, bumperTopF: 0.48, bumperTopR: 0.5, hoodY: 0.6, hoodZ: -2.1, layout: 'front' },
  muscle: { zF: -2.45, zR: 2.43, zA: -0.35, zC: 1.62, deck: true, hatch: false, sill: 0.21, beltF: 0.97, beltR: 0.98, roofY: 1.3, doors: [{ z0: -0.3, z1: 0.95, rear: false }], bumperF: -2.15, bumperR: 2.15, bumperTopF: 0.6, bumperTopR: 0.5, hoodY: 0.9, hoodZ: -2.38, layout: 'front' },
  super: { zF: -2.3, zR: 2.33, zA: -1.1, zC: 1.28, deck: true, hatch: false, sill: 0.16, beltF: 0.78, beltR: 0.94, roofY: 1.12, doors: [{ z0: -0.9, z1: 0.3, rear: false }], bumperF: -1.95, bumperR: 2.0, bumperTopF: 0.42, bumperTopR: 0.5, hoodY: 0.4, hoodZ: -2.2, layout: 'mid' },
  suv: { zF: -2.41, zR: 2.4, zA: -0.63, zC: 2.38, deck: false, hatch: true, sill: 0.34, beltF: 1.17, beltR: 1.17, roofY: 1.85, doors: [{ z0: -0.55, z1: 0.78, rear: false }, { z0: 0.86, z1: 1.68, rear: true }], bumperF: -2.15, bumperR: 2.15, bumperTopF: 0.65, bumperTopR: 0.65, hoodY: 1.05, hoodZ: -2.35, layout: 'front' },
  pickup: { zF: -2.66, zR: 2.66, zA: -0.95, zC: 0.58, deck: false, hatch: false, bed: true, sill: 0.36, beltF: 1.2, beltR: 1.2, roofY: 1.86, doors: [{ z0: -0.9, z1: 0.5, rear: false }], bumperF: -2.45, bumperR: 2.45, bumperTopF: 0.62, bumperTopR: 0.62, hoodY: 1.05, hoodZ: -2.6, layout: 'front' },
  cruiser: { zF: -2.53, zR: 2.53, zA: -0.82, zC: 1.36, deck: true, hatch: false, sill: 0.22, beltF: 0.97, beltR: 0.98, roofY: 1.44, doors: [{ z0: -0.75, z1: 0.38, rear: false }, { z0: 0.46, z1: 1.3, rear: true }], bumperF: -2.25, bumperR: 2.25, bumperTopF: 0.5, bumperTopR: 0.5, hoodY: 0.9, hoodZ: -2.48, layout: 'front' },
};
