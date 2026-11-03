// Two-wheelers: motorcycles (sport, naked, cruiser, scooter, dirt, chopper) and bicycles (road, bmx, mtb, cruiser).
// Model space as for cars: y = 0 ground, -Z forward, wheels on the centreline at z = -wb/2 and +wb/2.
// Parts that turn with the bars go to the animated group 'steer' (pivot at the steering head).
import { Parts, box, cyl, tube, bar, slab, extrudeSide, sphere, lathe, rotate, translate, mirrorX } from './geom.js';

const lerp = (a, b, t) => a + (b - a) * t;

function base(spec, D, lod) {
  const r = spec.wheelRadius, wb = spec.wheelbase;
  return {
    P: new Parts(), hi: lod !== 'low', r, wb, zf: -wb / 2, zr: wb / 2,
    H: spec.size.height, L: spec.size.length, W: spec.size.width, D, spec,
    lamps: { head: [], tail: [] },
  };
}

/** Steering head + fork (into the 'steer' group). Returns the head point. */
function fork(c, rakeDeg, headY, o = {}) {
  const { P, r, zf } = c;
  const rake = (rakeDeg * Math.PI) / 180;
  const head = [0, headY, zf + (headY - r) * Math.tan(rake)];
  const pivot = head;
  const sp = o.spread ?? 0.085;
  const fr = o.r ?? 0.024;
  const m = o.mat || 'chrome';
  for (const sx of [1, -1]) {
    P.group('steer', m, tube([sx * sp, r - 0.02, zf - 0.005], [sx * sp, headY + 0.05, head[2] + 0.02], fr, fr * 1.15, c.hi ? 8 : 5), pivot);
    if (o.lower) P.group('steer', o.lower, tube([sx * sp, r - 0.04, zf], [sx * sp, lerp(r, headY, 0.45), lerp(zf, head[2], 0.45)], fr * 1.5, fr * 1.5, c.hi ? 8 : 5));
  }
  P.group('steer', 'trim', box(sp * 2 + 0.07, 0.05, 0.08, 0, headY + 0.04, head[2] + 0.02));
  P.group('steer', 'trim', box(sp * 2 + 0.06, 0.04, 0.06, 0, lerp(r, headY, 0.7), lerp(zf, head[2], 0.7)));
  return { head, rake };
}

function bars(c, head, w, rise, back, o = {}) {
  const { P } = c;
  const y = head[1] + rise, z = head[2] + back;
  const m = o.mat || 'trim';
  if (o.ape) {
    for (const sx of [1, -1]) {
      P.group('steer', m, tube([sx * 0.06, head[1] + 0.06, head[2]], [sx * 0.14, y, z], 0.014, 0.014, 6));
      P.group('steer', m, tube([sx * 0.14, y, z], [sx * w / 2, y - 0.04, z + 0.12], 0.014, 0.014, 6));
      P.group('steer', 'dark', tube([sx * w / 2, y - 0.04, z + 0.12], [sx * (w / 2 + 0.1), y - 0.06, z + 0.18], 0.02, 0.02, 6));
    }
    return [w / 2, y, z + 0.12];
  }
  P.group('steer', m, tube([0, head[1] + 0.06, head[2]], [0, y, z], 0.016, 0.016, 6));
  P.group('steer', m, tube([-w / 2, y, z + (o.sweep ?? 0.05)], [w / 2, y, z + (o.sweep ?? 0.05)], 0.013, 0.013, 6));
  for (const sx of [1, -1]) P.group('steer', 'dark', tube([sx * (w / 2 - 0.12), y, z + (o.sweep ?? 0.05)], [sx * (w / 2 + 0.01), y, z + (o.sweep ?? 0.05)], 0.019, 0.019, 6));
  if (o.mirrors !== false) {
    for (const sx of [1, -1]) {
      P.group('steer', 'trim', tube([sx * (w / 2 - 0.06), y, z], [sx * (w / 2 + 0.02), y + 0.17, z - 0.03], 0.007, 0.007, 4));
      P.group('steer', 'chrome', box(0.1, 0.06, 0.02, sx * (w / 2 + 0.03), y + 0.19, z - 0.035));
    }
  }
  return [w / 2, y, z];
}

function swingarm(c, pivotY, pivotZ, o = {}) {
  const { P, r, zr } = c;
  const m = o.mat || 'trim';
  for (const sx of [1, -1]) P.add(m, bar([sx * 0.1, pivotY, pivotZ], [sx * 0.1, r, zr], o.w ?? 0.045, o.h ?? 0.07));
  P.add('chrome', cyl(0.02, 0.02, 0.26, 6, 0, r, zr, 'x'));
  if (o.shock !== false) P.add(o.shockMat || 'paint2', tube([0, pivotY + 0.05, pivotZ + 0.05], [0, pivotY + 0.32, pivotZ - 0.1], 0.03, 0.03, 6));
}

function tailLamp(c, y, z, w = 0.12, h = 0.05) {
  c.P.lamp('tail', 'tail', box(w, h, 0.04, 0, y, z), 'body');
  for (const sx of [1, -1]) c.P.lamp('amber', `indR${sx < 0 ? 'L' : 'R'}`, box(0.05, 0.03, 0.03, sx * 0.13, y - 0.04, z - 0.03), 'body');
  c.lamps.tail.push([0, y, z]);
}

function headLampRound(c, y, z, rad = 0.08, into = 'steer') {
  const g = cyl(rad, rad * 0.9, 0.1, c.hi ? 12 : 8, 0, y, z, 'z');
  const lens = cyl(rad * 0.88, rad * 0.88, 0.02, c.hi ? 12 : 8, 0, y, z - 0.055, 'z');
  if (into === 'steer') c.P.group('steer', 'chrome', g);
  else c.P.add('chrome', g);
  c.P.lamp('head', 'head', lens, 'body');
  c.lamps.head.push([0, y, z - 0.07]);
}

function engineBlock(c, kind, y, z) {
  const { P, hi } = c;
  if (kind === 'vtwin') {
    P.add('trim', box(0.24, 0.22, 0.42, 0, y - 0.06, z));
    for (const a of [-0.45, 0.45]) {
      const g = cyl(0.085, 0.085, 0.36, hi ? 10 : 6, 0, 0.18, 0);
      rotate(g, a, 0, 0);
      P.add('chrome', translate(g, 0, y + 0.02, z));
      if (hi) for (let k = 0; k < 4; k++) {
        const f = cyl(0.11, 0.11, 0.015, hi ? 10 : 6, 0, 0.12 + k * 0.06, 0);
        rotate(f, a, 0, 0);
        P.add('chrome', translate(f, 0, y + 0.02, z));
      }
    }
    P.add('chrome', cyl(0.13, 0.13, 0.08, hi ? 12 : 8, 0.15, y - 0.08, z + 0.1, 'x'));
  } else if (kind === 'single') {
    P.add('trim', box(0.2, 0.28, 0.32, 0, y, z));
    P.add('dark', box(0.16, 0.18, 0.18, 0, y + 0.2, z - 0.04, -0.3, 0, 0));
  } else {
    // inline four
    P.add('trim', box(0.36, 0.3, 0.42, 0, y, z));
    P.add('dark', box(0.32, 0.18, 0.3, 0, y + 0.2, z - 0.06, -0.35, 0, 0));
    P.add('chrome', cyl(0.11, 0.11, 0.06, hi ? 10 : 6, 0.19, y - 0.04, z + 0.06, 'x'));
  }
}

function pegs(c, y, z, w = 0.36) {
  for (const sx of [1, -1]) c.P.add('trim', box(0.1, 0.025, 0.035, sx * w / 2, y, z));
}

// ======================================================================================

export function designBike(spec, D = {}, lod = 'high') {
  const c = base(spec, D, lod);
  const { P, hi, r, zf, zr, H } = c;
  const style = D.bike || 'sport';
  let seat = { y: 0.85, z: 0.12 };
  if (style === 'sport') {
    const { head } = fork(c, 24, H * 0.82, { mat: 'rimGold', lower: 'chrome', spread: 0.09 });
    // twin-spar frame + swingarm
    for (const sx of [1, -1]) P.add('trim', bar([sx * 0.13, head[1] - 0.05, head[2] + 0.05], [sx * 0.13, 0.48, 0.16], 0.04, 0.12));
    swingarm(c, 0.42, 0.16, { mat: 'rim', w: 0.05, h: 0.1 });
    engineBlock(c, 'four', 0.45, -0.08);
    // fairing (upper + belly pan)
    const fp = [[zf - 0.02, 0.72], [zf + 0.06, 0.92], [head[2] + 0.02, 1.02], [head[2] + 0.25, 0.9], [0.0, 0.62], [0.02, 0.3], [-0.2, 0.25], [zf + 0.2, 0.42]];
    P.add('paint', extrudeSide(fp, 0.44, 0.08, 0.07));
    P.add('paint2', extrudeSide([[zf + 0.25, 0.43], [-0.18, 0.27], [0.0, 0.3], [-0.02, 0.5], [zf + 0.3, 0.55]], 0.46, 0.05));
    P.add('glass', extrudeSide([[zf + 0.06, 0.92], [head[2] + 0.1, H], [head[2] + 0.22, H - 0.05], [head[2] + 0.02, 0.98]], 0.3, 0.03));
    // tank, seat, tail
    P.add('paint', extrudeSide([[head[2] + 0.12, 0.88], [head[2] + 0.18, 0.98], [0.06, 0.98], [0.16, 0.86], [0.1, 0.72], [head[2] + 0.12, 0.74]], 0.38, 0.09, 0.08));
    P.add('dark', extrudeSide([[0.1, 0.84], [0.42, 0.88], [0.46, 0.84], [0.12, 0.8]], 0.27, 0.04));
    P.add('paint', extrudeSide([[0.1, 0.78], [0.42, 0.84], [0.82, 0.97], [0.86, 0.92], [0.45, 0.68], [0.15, 0.62]], 0.24, 0.05));
    P.add('paint2', extrudeSide([[0.46, 0.88], [0.68, 0.94], [0.7, 0.9], [0.48, 0.85]], 0.2, 0.03));
    tailLamp(c, 0.93, 0.86, 0.1, 0.04);
    // twin headlamp slits
    for (const sx of [1, -1]) P.lamp('head', `head${sx < 0 ? 'L' : 'R'}`, box(0.09, 0.04, 0.04, sx * 0.07, 0.8, zf + 0.0, 0.5, sx * -0.3, 0), 'body');
    c.lamps.head.push([0, 0.8, zf - 0.04]);
    for (const sx of [1, -1]) P.lamp('amber', `indF${sx < 0 ? 'L' : 'R'}`, box(0.06, 0.03, 0.03, sx * 0.2, 0.86, zf + 0.12), 'body');
    bars(c, head, 0.56, -0.03, 0.12, { mirrors: false });
    for (const sx of [1, -1]) {
      P.add('trim', tube([sx * 0.2, 0.92, head[2] + 0.05], [sx * 0.27, 0.97, head[2] + 0.02], 0.008, 0.008, 4));
      P.add('paint', box(0.1, 0.05, 0.03, sx * 0.29, 0.98, head[2] + 0.01));
    }
    // exhaust under the tail
    P.add('trim', tube([0.08, 0.3, -0.05], [0.12, 0.42, 0.45], 0.04, 0.045, 8));
    P.add('chrome', tube([0.12, 0.42, 0.45], [0.14, 0.58, 0.72], 0.06, 0.065, hi ? 10 : 6));
    // front mudguard + rear hugger
    P.group('steer', 'paint', slabArc(c, zf, r + 0.035, -0.6, 0.6, 0.13));
    pegs(c, 0.36, 0.3);
    seat = { y: 0.87, z: 0.22 };
  } else if (style === 'naked') {
    const { head } = fork(c, 25, H * 0.82, { mat: 'rimGold', lower: 'trim' });
    for (const sx of [1, -1]) P.add('paint2', bar([sx * 0.12, head[1] - 0.05, head[2] + 0.04], [sx * 0.12, 0.45, 0.14], 0.035, 0.08));
    for (const sx of [1, -1]) P.add('paint2', bar([sx * 0.11, 0.45, 0.14], [sx * 0.11, 0.82, 0.55], 0.03, 0.04));
    swingarm(c, 0.42, 0.15, { mat: 'paint2' });
    engineBlock(c, 'four', 0.44, -0.06);
    P.add('paint', extrudeSide([[head[2] + 0.06, 0.86], [head[2] + 0.14, 1.0], [0.04, 1.0], [0.16, 0.86], [0.08, 0.7], [head[2] + 0.06, 0.72]], 0.42, 0.1, 0.09));
    for (const sx of [1, -1]) P.add('paint', slab([[head[2] + 0.02, 0.86], [head[2] + 0.12, 0.98], [head[2] + 0.2, 0.72]], sx > 0 ? 0.2 : -0.24, sx > 0 ? 0.24 : -0.2));
    P.add('dark', extrudeSide([[0.1, 0.84], [0.5, 0.88], [0.56, 0.85], [0.12, 0.8]], 0.28, 0.04));
    P.add('paint', extrudeSide([[0.45, 0.8], [0.76, 0.92], [0.8, 0.88], [0.5, 0.74]], 0.2, 0.04));
    tailLamp(c, 0.88, 0.8, 0.09, 0.04);
    headLampRound(c, head[1] - 0.06, head[2] - 0.12, 0.085);
    for (const sx of [1, -1]) P.group('steer', 'amber', box(0.05, 0.03, 0.03, sx * 0.14, head[1] - 0.05, head[2] - 0.08));
    bars(c, head, 0.74, 0.08, 0.12);
    P.add('chrome', tube([0.1, 0.28, -0.02], [0.16, 0.36, 0.35], 0.04, 0.04, 8));
    P.add('chrome', tube([0.16, 0.36, 0.35], [0.18, 0.5, 0.62], 0.065, 0.06, hi ? 10 : 6));
    P.group('steer', 'paint2', slabArc(c, zf, r + 0.03, -0.5, 0.55, 0.12));
    pegs(c, 0.36, 0.28);
    seat = { y: 0.87, z: 0.24 };
  } else if (style === 'cruiser') {
    const { head } = fork(c, 30, H * 0.72, { mat: 'chrome', lower: 'chrome', spread: 0.1, r: 0.028 });
    for (const sx of [1, -1]) P.add('trim', tube([sx * 0.04, head[1], head[2] + 0.03], [sx * 0.05, 0.32, 0.18], 0.03, 0.03, 6));
    swingarm(c, 0.36, 0.25, { mat: 'chrome', shock: false });
    engineBlock(c, 'vtwin', 0.42, -0.08);
    // tank, seat, valanced fenders
    P.add('paint', extrudeSide([[head[2] + 0.08, 0.84], [head[2] + 0.18, 0.95], [0.08, 0.92], [0.18, 0.78], [head[2] + 0.12, 0.74]], 0.42, 0.11, 0.1));
    P.add('dark', extrudeSide([[0.14, 0.72], [0.22, 0.76], [0.48, 0.74], [0.62, 0.84], [0.68, 0.8], [0.5, 0.66], [0.15, 0.66]], 0.36, 0.06));
    P.add('paint', slabArc(c, zr, r + 0.06, -0.15, 1.3, 0.26));
    P.group('steer', 'paint', slabArc(c, zf, r + 0.04, -0.7, 0.9, 0.2));
    // batwing fairing + windscreen
    P.group('steer', 'paint', extrudeSide([[head[2] - 0.12, head[1] - 0.24], [head[2] - 0.16, head[1] + 0.02], [head[2] - 0.06, head[1] + 0.12], [head[2] + 0.06, head[1] + 0.1], [head[2] + 0.02, head[1] - 0.24]], 0.72, 0.08, 0.07));
    P.group('steer', 'glass', box(0.55, 0.28, 0.02, 0, head[1] + 0.25, head[2] - 0.08, -0.35, 0, 0));
    headLampRound(c, head[1] - 0.08, head[2] - 0.17, 0.09, 'body');
    // saddlebags
    for (const sx of [1, -1]) {
      P.add('paint', extrudeSide([[0.4, 0.38], [0.4, 0.7], [0.95, 0.72], [1.02, 0.6], [0.95, 0.38]], 0.2, 0.05).map((v, i) => (i % 3 === 0 ? v + sx * 0.3 : v)));
      P.add('chrome', tube([sx * 0.13, 0.25, 0.0], [sx * 0.22, 0.32, 1.05], 0.045, 0.05, hi ? 10 : 6));
    }
    tailLamp(c, 0.66, 1.06, 0.14, 0.05);
    bars(c, head, 0.8, 0.14, 0.24, { mat: 'chrome', sweep: 0.12 });
    for (const sx of [1, -1]) P.add('chrome', box(0.14, 0.02, 0.28, sx * 0.3, 0.32, -0.25));
    P.add('chrome', bar([-0.33, 0.48, -0.42], [0.33, 0.48, -0.42], 0.03, 0.03));
    seat = { y: 0.74, z: 0.3 };
  } else if (style === 'scooter') {
    const { head } = fork(c, 28, H * 0.8, { mat: 'trim', spread: 0.055, r: 0.02 });
    // step-through body
    P.add('paint', extrudeSide([[zf + 0.06, 0.5], [head[2] - 0.08, head[1] - 0.15], [head[2] + 0.06, head[1] - 0.12], [head[2] + 0.14, 0.42], [head[2] + 0.12, 0.28], [zf + 0.2, 0.28]], 0.44, 0.08, 0.07));
    P.add('trim', box(0.36, 0.05, 0.62, 0, 0.27, 0.05));
    P.add('paint', extrudeSide([[0.0, 0.3], [0.05, 0.68], [0.3, 0.8], [0.72, 0.76], [0.82, 0.6], [0.72, 0.4], [0.5, 0.3]], 0.46, 0.14, 0.12));
    P.add('dark', extrudeSide([[0.05, 0.72], [0.15, 0.86], [0.62, 0.86], [0.7, 0.78], [0.1, 0.72]], 0.3, 0.06));
    P.add('chrome', box(0.32, 0.03, 0.2, 0, 0.79, 0.78));
    P.group('steer', 'paint', extrudeSide([[head[2] - 0.12, head[1] - 0.12], [head[2] - 0.1, head[1] + 0.1], [head[2] + 0.06, head[1] + 0.1], [head[2] + 0.04, head[1] - 0.12]], 0.36, 0.05));
    P.group('steer', 'paint', slabArc(c, zf, r + 0.03, -0.9, 0.6, 0.12));
    headLampRound(c, head[1] + 0.02, head[2] - 0.12, 0.07);
    tailLamp(c, 0.66, 0.82, 0.12, 0.05);
    bars(c, head, 0.6, 0.14, 0.04);
    P.add('chrome', tube([0.12, 0.25, 0.35], [0.14, 0.32, 0.8], 0.04, 0.04, 8));
    P.add('trim', box(0.14, 0.2, 0.42, 0.08, 0.3, 0.52));
    seat = { y: 0.86, z: 0.36 };
  } else if (style === 'dirt') {
    const { head } = fork(c, 27, H * 0.82, { mat: 'rimGold', lower: 'trim', spread: 0.08, r: 0.026 });
    for (const sx of [1, -1]) P.add('trim', bar([sx * 0.05, head[1] - 0.04, head[2] + 0.04], [sx * 0.07, 0.42, 0.0], 0.03, 0.05));
    swingarm(c, 0.5, 0.06, { mat: 'rim', w: 0.04, h: 0.07, shockMat: 'paint2' });
    engineBlock(c, 'single', 0.45, -0.08);
    P.add('paint', extrudeSide([[head[2] + 0.04, 0.98], [head[2] + 0.12, 1.06], [0.05, 0.98], [0.1, 0.88], [head[2] + 0.06, 0.84]], 0.34, 0.08));
    for (const sx of [1, -1]) P.add('paint2', slab([[head[2] + 0.02, 0.98], [head[2] + 0.22, 0.98], [0.06, 0.7], [head[2] + 0.06, 0.66]], sx > 0 ? 0.16 : -0.2, sx > 0 ? 0.2 : -0.16));
    P.add('dark', extrudeSide([[head[2] + 0.18, 1.0], [0.62, 0.98], [0.66, 0.94], [head[2] + 0.2, 0.95]], 0.24, 0.04));
    P.add('paint', extrudeSide([[0.35, 0.92], [0.82, 1.04], [0.85, 1.0], [0.4, 0.82]], 0.2, 0.04));
    P.group('steer', 'paint', extrudeSide([[zf - 0.25, head[1] - 0.22], [zf + 0.0, head[1] - 0.12], [zf + 0.25, head[1] - 0.2], [zf + 0.0, head[1] - 0.25]], 0.18, 0.03));
    P.group('steer', 'plate', box(0.24, 0.22, 0.02, 0, head[1] - 0.04, head[2] - 0.1, -0.35, 0, 0));
    headLampRound(c, head[1] - 0.06, head[2] - 0.12, 0.055);
    tailLamp(c, 0.98, 0.82, 0.07, 0.03);
    bars(c, head, 0.78, 0.14, 0.12, { sweep: 0.03 });
    P.add('chrome', tube([0.1, 0.62, -0.1], [0.14, 0.82, 0.5], 0.035, 0.04, 8));
    P.add('trim', tube([0.14, 0.82, 0.5], [0.15, 0.86, 0.72], 0.045, 0.045, 8));
    pegs(c, 0.42, 0.18);
    seat = { y: 0.98, z: 0.15 };
  } else if (style === 'chopper') {
    const { head } = fork(c, 38, H * 0.82, { mat: 'chrome', spread: 0.08, r: 0.022 });
    for (const sx of [1, -1]) {
      P.add('chrome', tube([sx * 0.04, head[1], head[2]], [sx * 0.05, 0.3, 0.05], 0.025, 0.025, 6));
      P.add('chrome', tube([sx * 0.04, head[1], head[2]], [sx * 0.08, 0.62, 0.62], 0.022, 0.022, 6));
      P.add('chrome', tube([sx * 0.08, 0.62, 0.62], [sx * 0.11, r, zr], 0.022, 0.022, 6));
      P.add('chrome', tube([sx * 0.05, 0.3, 0.05], [sx * 0.11, r, zr], 0.025, 0.025, 6));
    }
    engineBlock(c, 'vtwin', 0.4, 0.12);
    P.add('paint', sphere(0.18, hi ? 12 : 8, hi ? 8 : 5, 0, head[1] - 0.12, head[2] + 0.42, 0.75, 0.62, 1.5));
    P.add('dark', extrudeSide([[0.42, 0.62], [0.55, 0.66], [0.8, 0.64], [0.86, 0.7], [0.9, 0.66], [0.8, 0.58], [0.45, 0.58]], 0.32, 0.05));
    P.add('chrome', bar([-0.14, 0.64, 0.86], [-0.14, 1.12, 1.0], 0.025, 0.025));
    P.add('chrome', bar([0.14, 0.64, 0.86], [0.14, 1.12, 1.0], 0.025, 0.025));
    P.add('chrome', bar([-0.14, 1.12, 1.0], [0.14, 1.12, 1.0], 0.025, 0.025));
    P.add('paint', slabArc(c, zr, r + 0.05, -0.1, 1.2, 0.3));
    headLampRound(c, head[1] - 0.12, head[2] - 0.1, 0.07);
    tailLamp(c, 0.6, zr + 0.36, 0.09, 0.04);
    bars(c, head, 0.75, 0.42, 0.05, { ape: true, mat: 'chrome' });
    for (const sx of [1, -1]) P.add('chrome', tube([sx * 0.13, 0.28, -0.0], [sx * 0.17, 0.3, 0.95], 0.04, 0.045, hi ? 10 : 6));
    for (const sx of [1, -1]) P.add('chrome', box(0.14, 0.02, 0.06, sx * 0.3, 0.32, -0.45));
    seat = { y: 0.66, z: 0.62 };
  }
  P.add('dark', box(0.04, 0.02, 0.5, 0.11, c.r, (zr + 0.0) / 2 + 0.1)); // chain
  const wheels = [
    { phys: 0, x: 0, z: zf, r, w: spec.tireWidth[0], steer: true, bike: true, style: D.frontRim || (style === 'cruiser' || style === 'chopper' || style === 'dirt' ? 'wire' : style === 'scooter' ? 'moto' : 'moto'), spokes: style === 'scooter' ? 5 : 3, rimMat: style === 'sport' ? 'rimGold' : style === 'naked' ? 'paint2' : style === 'dirt' ? 'rim' : 'rim', rotor: style !== 'chopper' },
    { phys: 1, x: 0, z: zr, r, w: spec.tireWidth[1], steer: false, bike: true, style: D.rearRim || (style === 'cruiser' || style === 'chopper' || style === 'dirt' ? 'wire' : 'moto'), spokes: style === 'scooter' ? 5 : 3, rimMat: style === 'sport' ? 'rimGold' : style === 'naked' ? 'paint2' : 'rim', rotor: false },
  ];
  return {
    parts: P, zones: null, lamps: c.lamps, wheels,
    seats: [{ x: 0, y: seat.y, z: seat.z }],
    doors: [],
    enginePos: [0, 0.45, -0.05],
    exhaustPos: [0.16, 0.45, zr * 0.6],
    rim: 'chrome', rimStyle: 'moto', spokes: 3,
    dims: { length: c.L, width: c.W, height: c.H },
    seatPose: 'bike',
    anim: null,
  };
}

/** Mudguard arc (side profile) around a wheel at zc from angle a0..a1 (0 = top, + = rearward), width w. */
function slabArc(c, zc, R, a0, a1, w, th = 0.025) {
  const n = c.hi ? 8 : 5;
  const outer = [], inner = [];
  for (let i = 0; i <= n; i++) {
    const a = lerp(a0, a1, i / n);
    outer.push([zc + Math.sin(a) * (R + th), c.r + Math.cos(a) * (R + th)]);
    inner.push([zc + Math.sin(a) * R, c.r + Math.cos(a) * R]);
  }
  return extrudeSide([...outer, ...inner.reverse()], w, 0);
}

// ======================================================================================

export function designBicycle(spec, D = {}, lod = 'high') {
  const c = base(spec, D, lod);
  const { P, hi, r, zf, zr, H } = c;
  const kind = D.bicycle || 'road';
  const seg = hi ? 6 : 4;
  const tr = kind === 'mtb' || kind === 'bmx' ? 0.022 : kind === 'cruiser' ? 0.02 : 0.016;
  const T = (a, b, rr = tr, m = 'paint') => P.add(m, tube(a, b, rr, rr, seg));
  // key points: bottom bracket, seat cluster, head tube top/bottom
  const bb = [0, kind === 'bmx' ? 0.3 : r * 0.82, kind === 'bmx' ? 0.08 : 0.05];
  const rake = kind === 'cruiser' ? 22 : 18;
  const headTop = [0, H * (kind === 'bmx' ? 0.72 : kind === 'road' ? 0.86 : 0.84), zf + (kind === 'bmx' ? 0.2 : 0.28)];
  const headBot = [0, headTop[1] - (kind === 'bmx' ? 0.1 : 0.15), headTop[2] - 0.06];
  const seatTop = [0, H * (kind === 'bmx' ? 0.6 : 0.82), bb[2] + (kind === 'bmx' ? 0.12 : 0.17)];
  const rearAx = [0, r, zr];
  // frame
  if (kind === 'cruiser') {
    // curvy double top tube
    const mid = [0, headTop[1] - 0.18, (headTop[2] + seatTop[2]) / 2];
    T(headTop, mid);
    T(mid, [0, seatTop[1] - 0.12, seatTop[2] - 0.04]);
    T(headBot, [0, bb[1] + 0.12, bb[2] - 0.15]);
    T([0, bb[1] + 0.12, bb[2] - 0.15], bb);
  } else {
    T(headTop, seatTop);
    T(headBot, bb, tr * 1.25);
  }
  T(bb, seatTop, tr * 1.1);
  for (const sx of [1, -1]) {
    T([sx * 0.04, bb[1], bb[2]], [sx * 0.06, r, zr], tr * 0.7);
    T([sx * 0.03, seatTop[1] - 0.03, seatTop[2]], [sx * 0.06, r, zr], tr * 0.65);
  }
  if (kind === 'mtb') {
    P.add('trim', tube([0, seatTop[1] - 0.18, seatTop[2] - 0.02], [0, bb[1] + 0.12, bb[2] - 0.2], 0.03, 0.03, seg));
    P.add('paint2', tube([0, seatTop[1] - 0.18, seatTop[2] - 0.02], [0, bb[1] + 0.25, bb[2] - 0.12], 0.018, 0.018, seg));
  }
  // seat post + saddle
  const saddle = [0, seatTop[1] + (kind === 'bmx' ? 0.12 : 0.18), seatTop[2] + 0.05];
  P.add('chrome', tube(seatTop, saddle, 0.013, 0.013, seg));
  if (kind === 'cruiser') P.add('dark', box(0.26, 0.07, 0.24, 0, saddle[1] + 0.03, saddle[2] + 0.02));
  else P.add('dark', box(0.13, 0.04, 0.27, 0, saddle[1] + 0.02, saddle[2] - 0.02));
  // fork, stem and bars (steer group)
  const pivot = headTop;
  const forkMat = kind === 'mtb' ? 'trim' : 'paint';
  for (const sx of [1, -1]) P.group('steer', forkMat, tube([sx * 0.045, r, zf], [sx * 0.03, headBot[1], headBot[2]], kind === 'mtb' ? 0.02 : 0.012, kind === 'mtb' ? 0.02 : 0.012, seg), pivot);
  P.group('steer', 'paint', tube(headBot, headTop, tr * 1.4, tr * 1.4, seg));
  const stem = [0, headTop[1] + (kind === 'bmx' ? 0.18 : 0.06), headTop[2] + (kind === 'cruiser' ? 0.1 : -0.05)];
  P.group('steer', 'chrome', tube(headTop, stem, 0.014, 0.014, seg));
  const bw = kind === 'road' ? 0.42 : kind === 'bmx' ? 0.66 : kind === 'cruiser' ? 0.66 : 0.72;
  if (kind === 'road') {
    P.group('steer', 'dark', tube([-bw / 2, stem[1], stem[2]], [bw / 2, stem[1], stem[2]], 0.012, 0.012, seg));
    for (const sx of [1, -1]) {
      P.group('steer', 'dark', tube([sx * bw / 2, stem[1], stem[2]], [sx * bw / 2, stem[1] - 0.06, stem[2] - 0.1], 0.012, 0.012, seg));
      P.group('steer', 'dark', tube([sx * bw / 2, stem[1] - 0.06, stem[2] - 0.1], [sx * bw / 2, stem[1] - 0.12, stem[2] + 0.02], 0.012, 0.012, seg));
    }
  } else if (kind === 'cruiser') {
    for (const sx of [1, -1]) {
      P.group('steer', 'chrome', tube([0, stem[1], stem[2]], [sx * bw / 2, stem[1] + 0.06, stem[2] + 0.16], 0.012, 0.012, seg));
      P.group('steer', 'dark', tube([sx * (bw / 2 - 0.1), stem[1] + 0.05, stem[2] + 0.13], [sx * bw / 2, stem[1] + 0.06, stem[2] + 0.16], 0.017, 0.017, seg));
    }
    // basket
    P.group('steer', 'canvas', box(0.36, 0.22, 0.26, 0, headTop[1] - 0.02, headTop[2] - 0.24));
  } else {
    P.group('steer', 'dark', tube([-bw / 2, stem[1], stem[2]], [bw / 2, stem[1], stem[2]], 0.012, 0.012, seg));
    if (kind === 'bmx') P.group('steer', 'dark', tube([-0.12, stem[1] - 0.1, stem[2]], [0.12, stem[1] - 0.1, stem[2]], 0.01, 0.01, seg));
    for (const sx of [1, -1]) P.group('steer', 'dark', tube([sx * (bw / 2 - 0.1), stem[1], stem[2]], [sx * bw / 2, stem[1], stem[2]], 0.017, 0.017, seg));
  }
  // cranks (animated around the bottom bracket)
  const crankL = kind === 'bmx' ? 0.17 : 0.17;
  P.group('crank', 'chrome', cyl(kind === 'bmx' ? 0.06 : 0.09, kind === 'bmx' ? 0.06 : 0.09, 0.012, hi ? 14 : 8, 0.07, bb[1], bb[2], 'x'), bb);
  for (const sx of [1, -1]) {
    P.group('crank', 'trim', bar([sx * 0.08, bb[1], bb[2]], [sx * 0.09, bb[1] + sx * crankL, bb[2]], 0.02, 0.025));
    P.group('crank', 'dark', box(0.09, 0.02, 0.07, sx * 0.13, bb[1] + sx * crankL, bb[2]));
  }
  P.add('dark', box(0.008, 0.012, zr - bb[2], 0.07, bb[1] + 0.03, (zr + bb[2]) / 2));
  if (kind === 'bmx') for (const sx of [1, -1]) P.add('chrome', cyl(0.022, 0.022, 0.1, 6, sx * 0.1, r, zr, 'x'));
  if (kind === 'cruiser') {
    P.add('paint', slabArc(c, zr, r + 0.04, -0.3, 1.6, 0.07, 0.012));
    P.group('steer', 'paint', slabArc(c, zf, r + 0.04, -1.2, 0.6, 0.07, 0.012));
    P.add('chrome', box(0.24, 0.02, 0.3, 0, r + 0.32, zr - 0.02));
  }
  // lamps: small front light / rear reflector
  P.lamp('head', 'head', box(0.05, 0.04, 0.04, 0, headTop[1] - 0.05, headTop[2] - 0.06), 'body');
  P.lamp('tail', 'tail', box(0.04, 0.03, 0.02, 0, seatTop[1] + 0.06, seatTop[2] + 0.06), 'body');
  c.lamps.head.push([0, headTop[1] - 0.05, headTop[2] - 0.1]);
  c.lamps.tail.push([0, seatTop[1], seatTop[2] + 0.08]);
  const wstyle = 'bicycle';
  const wheels = [
    { phys: 0, x: 0, z: zf, r, w: spec.tireWidth[0], steer: true, bike: true, style: wstyle, rimMat: kind === 'road' ? 'rimDark' : 'rim', spokeMat: 'rim' },
    { phys: 1, x: 0, z: zr, r, w: spec.tireWidth[1], steer: false, bike: true, style: wstyle, rimMat: kind === 'road' ? 'rimDark' : 'rim', spokeMat: 'rim' },
  ];
  return {
    parts: P, zones: null, lamps: c.lamps, wheels,
    seats: [{ x: 0, y: saddle[1] + 0.04, z: saddle[2] }],
    doors: [],
    enginePos: [0, bb[1], bb[2]],
    exhaustPos: [0, bb[1], bb[2]],
    rim: 'silver', rimStyle: 'bicycle', spokes: 20,
    dims: { length: c.L, width: c.W, height: c.H },
    seatPose: 'bike',
    anim: 'crank',
    crankPos: bb,
  };
}
