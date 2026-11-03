// Trucks and buses: cab generator (conventional / cab-over / step van) x body module
// (box, dump, mixer, garbage, flatbed, tanker, tow, fire, ambulance, semi) and bus bodies.
import { Parts, arch, box, cyl, slab, extrudeSide, slice, sliceMany, warp, classify, bar, lathe, rotate, translate, concat, mirrorX } from './geom.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

function stations(spec, D) {
  const r = spec.wheelRadius, wb = spec.wheelbase;
  const L = spec.size.length, W = spec.size.width, H = spec.size.height;
  const over = Math.max(0.8, L - wb);
  const ohF = D.ohF ?? over * (D.ohFrac ?? 0.42);
  const zf = -wb / 2, zr = wb / 2;
  return { r, wb, L, W, H, zf, zr, zF: zf - ohF, zR: zr + (over - ohF), hw: W / 2 };
}

/** Thick arched fender shell over a wheel (both sides), x from x0 to x1 (positive side). */
function fender(P, zc, r, R, x0, x1, yBase, mat = 'paint', thick = 0.1, n = 8) {
  const outer = arch(zc, r, R + thick, yBase, n);
  const inner = arch(zc, r, R, yBase, n).reverse();
  const g = slab([...outer, ...inner], x0, x1, 0.02);
  P.add(mat, g);
  P.add(mat, mirrorX(g));
}

function addWheels(spec, D, z, rearAxles) {
  const out = [];
  const { r } = spec;
  for (const [i, left] of [[0, true], [1, false]]) out.push({ phys: i, x: (left ? -1 : 1) * spec.track[0] / 2, z: -spec.wheelbase / 2, r: spec.wheelRadius, w: spec.tireWidth[0], left, steer: true, style: D.rim || 'truck' });
  for (const za of rearAxles) {
    for (const [i, left] of [[2, true], [3, false]]) {
      out.push({ phys: i, x: (left ? -1 : 1) * spec.track[1] / 2, z: za, r: spec.wheelRadius, w: spec.tireWidth[1], left, steer: false, dual: D.dual !== false, style: D.rim || 'truck' });
    }
  }
  return out;
}

function mirrorsTruck(P, x, y, z) {
  for (const sx of [1, -1]) {
    P.add('trim', box(0.05, 0.42, 0.16, sx * (x + 0.22), y, z));
    P.add('chrome', bar([sx * x, y - 0.12, z], [sx * (x + 0.22), y - 0.12, z], 0.025, 0.025));
    P.add('chrome', bar([sx * x, y + 0.12, z], [sx * (x + 0.22), y + 0.12, z], 0.025, 0.025));
  }
}

function lampPair(P, kind, name, w, h, x, y, z, attach = 'body') {
  for (const sx of [1, -1]) P.lamp(kind, `${name}${sx < 0 ? 'L' : 'R'}`, box(w, h, 0.05, sx * x, y, z), attach);
}

// ======================================================================================
// cabs
// ======================================================================================

/** Long-nose conventional cab. Returns { zBack, floor, roof } */
function cabConventional(c, o) {
  const { P, hi, r, zf, zF, hw, H } = c;
  const hoodLen = o.hoodLen ?? 1.7;
  const hoodY = o.hoodY ?? r * 2 + 0.55;
  const hoodW = o.hoodW ?? Math.min(1.5, hw * 2 - 0.7);
  const zHood = zF + hoodLen;
  const bumperY = r * 0.9;
  // bumper
  P.part('frontBumper', o.bumperMat || 'chrome', box(hw * 2 - 0.05, 0.28, 0.22, 0, bumperY, zF + 0.08));
  // hood
  const hp = [[zF + 0.18, bumperY + 0.12], [zF + 0.15, hoodY - 0.12], [zF + 0.3, hoodY], [zHood, hoodY + 0.08], [zHood, bumperY + 0.12]];
  P.add('paint', extrudeSide(hp, hoodW, 0.06));
  // grille
  const gh = hoodY - bumperY - 0.3;
  P.add(o.grilleMat || 'chrome', box(hoodW * 0.86, gh + 0.06, 0.05, 0, bumperY + 0.2 + gh / 2, zF + 0.155));
  P.add('dark', box(hoodW * 0.74, gh - 0.04, 0.05, 0, bumperY + 0.2 + gh / 2, zF + 0.145));
  if (hi) for (let i = 1; i < 8; i++) P.add(o.grilleMat || 'chrome', box(0.02, gh - 0.04, 0.03, -hoodW * 0.37 + (hoodW * 0.74 * i) / 8, bumperY + 0.2 + gh / 2, zF + 0.13));
  // fenders + headlights
  const R = r + 0.08;
  fender(c.P, zf, r, R, hoodW / 2 - 0.05, hw - 0.02, r - 0.05, o.fenderMat || 'paint', 0.12);
  P.pair('paint', (sx) => box(hw - hoodW / 2, 0.1, zHood - zf - R + 0.05, sx * (hw + hoodW / 2) / 2, r + R + 0.07, (zf + R + zHood) / 2 - 0.02));
  for (const sx of [1, -1]) {
    P.lamp('head', `head${sx < 0 ? 'L' : 'R'}`, box(0.26, 0.14, 0.05, sx * (hoodW / 2 + 0.2), bumperY + 0.32, zF + 0.32), 'body');
    P.add('chrome', box(0.3, 0.18, 0.05, sx * (hoodW / 2 + 0.2), bumperY + 0.32, zF + 0.345));
    P.lamp('amber', `indF${sx < 0 ? 'L' : 'R'}`, box(0.12, 0.06, 0.04, sx * (hoodW / 2 + 0.2), bumperY + 0.18, zF + 0.33), 'frontBumper');
  }
  c.lamps.head.push([hoodW / 2 + 0.2, bumperY + 0.32, zF + 0.28], [-(hoodW / 2 + 0.2), bumperY + 0.32, zF + 0.28]);
  // cab
  const cabLen = o.cabLen ?? 1.7;
  const floor = r * 2 + 0.05;
  const cabTop = o.cabTop ?? Math.min(H, hoodY + 1.25);
  const belt = hoodY + 0.25;
  const zBack = zHood + cabLen;
  const cp = [[zHood - 0.05, floor], [zHood - 0.05, belt], [zHood + 0.38, cabTop - 0.05], [zHood + 0.5, cabTop], [zBack, cabTop], [zBack, floor]];
  let cab = extrudeSide(cp, hw * 2 - 0.08, 0.08);
  cab = sliceMany(cab, 1, [belt + 0.04, cabTop - 0.14]);
  cab = sliceMany(cab, 2, [zHood + 0.55, zHood + Math.min(1.25, cabLen - 0.25)]);
  const winZ1 = zHood + Math.min(1.25, cabLen - 0.25);
  const b = classify(cab, (nx, ny, nz, cx, cy, cz) => {
    if (ny < -0.6) return 'dark';
    if (nz < -0.3 && cy > belt + 0.04) return 'glass'; // windshield
    if (Math.abs(nx) > 0.8 && cy > belt + 0.04 && cy < cabTop - 0.14 && cz > zHood + 0.55 && cz < winZ1) return 'glass';
    return 'paint';
  });
  for (const k of Object.keys(b)) P.add(k, b[k]);
  // windshield divider, visor
  P.add('trim', box(0.05, cabTop - belt - 0.1, 0.05, 0, (belt + cabTop) / 2, zHood + 0.22, -Math.atan2(0.38, cabTop - belt)));
  if (o.visor) P.add('paint', box(hw * 2 - 0.1, 0.06, 0.32, 0, cabTop - 0.02, zHood + 0.4, 0.15));
  // sleeper / roof fairing
  if (o.sleeper) {
    const sl = o.sleeper;
    const zs = zBack + sl;
    P.add('paint', extrudeSide([[zBack - 0.02, floor], [zBack - 0.02, cabTop], [zs, cabTop], [zs, floor]], hw * 2 - 0.08, 0.08));
    if (o.fairing) P.add('paint', extrudeSide([[zHood + 0.9, cabTop - 0.02], [zHood + 1.6, H - 0.02], [zs, H], [zs, cabTop - 0.02]], hw * 2 - 0.14, 0.1));
    c.zBack = zs;
  } else c.zBack = zBack;
  // doors seams + steps + tanks
  for (const sx of [1, -1]) {
    P.add('dark', box(0.006, belt - floor - 0.05, 0.012, sx * (hw - 0.035), (belt + floor) / 2, zHood + 0.08));
    P.add('dark', box(0.006, belt - floor - 0.05, 0.012, sx * (hw - 0.035), (belt + floor) / 2, winZ1 + 0.05));
    P.add('chrome', box(0.18, 0.04, 0.5, sx * (hw - 0.12), floor - 0.25, zHood + 0.5));
    P.add('chrome', box(0.18, 0.04, 0.5, sx * (hw - 0.12), floor - 0.55, zHood + 0.5));
    if (o.tanks) {
      const tz = zHood + 0.6 + (o.tankZ ?? 0.6);
      P.add('chrome', cyl(0.3, 0.3, o.tanks, hi ? 14 : 8, sx * (hw - 0.32), r + 0.12, tz + o.tanks / 2, 'z'));
    }
  }
  mirrorsTruck(P, hw - 0.02, belt + 0.3, zHood + 0.25);
  // stacks
  if (o.stacks) {
    for (const sx of [1, -1]) {
      const x = sx * (hw - 0.18), z = c.zBack + 0.15;
      P.add('chrome', cyl(0.08, 0.08, H - floor + 0.1, hi ? 10 : 6, x, (H + floor) / 2 + 0.05, z));
      P.add('dark', cyl(0.085, 0.085, 0.08, hi ? 10 : 6, x, H + 0.06, z));
    }
  }
  // marker lamps on the roof
  if (o.roofMarkers) for (let i = -2; i <= 2; i++) P.lamp('amber', `roofMark${i + 2}`, box(0.07, 0.04, 0.05, i * 0.2, (o.sleeper && o.fairing ? H : cabTop) + 0.02, (o.sleeper && o.fairing ? zHood + 1.62 : zHood + 0.52)), 'body');
  c.cabFloor = floor;
  c.cabTop = cabTop;
  c.belt = belt;
  c.zA = zHood;
  c.doors = [{ z0: zHood, z1: winZ1, rear: false }];
  c.seat = { y: floor + 0.5, z: zHood + 0.75 };
  c.enginePos = [0, hoodY - 0.4, zf];
  return c;
}

/** Flat-fronted cab-over (fire engine, garbage, box trucks, kei trucks). */
function cabOver(c, o) {
  const { P, hi, r, zf, zF, hw, H } = c;
  const cabLen = o.cabLen ?? 2.0;
  const floor = Math.max(r * 2 * 0.8, r + 0.25);
  const cabTop = o.cabTop ?? Math.min(H, floor + 2.0);
  const belt = floor + (o.beltH ?? 0.75);
  const zBack = zF + cabLen;
  const bumperY = Math.max(0.35, r * 0.8);
  P.part('frontBumper', o.bumperMat || 'trim', box(hw * 2 - 0.02, 0.26, 0.2, 0, bumperY, zF + 0.06));
  const cp = [[zF + 0.1, bumperY + 0.1], [zF + 0.08, belt], [zF + 0.2, cabTop - 0.08], [zF + 0.32, cabTop], [zBack, cabTop], [zBack, bumperY + 0.1]];
  let cab = extrudeSide(cp, hw * 2 - 0.04, o.bevel ?? 0.1);
  cab = sliceMany(cab, 1, [belt + 0.04, cabTop - 0.16]);
  const winZ1 = zF + Math.min(1.35, cabLen - 0.2);
  cab = sliceMany(cab, 2, [zF + 0.3, winZ1]);
  const roofMat = o.roofMat || 'paint';
  const b = classify(cab, (nx, ny, nz, cx, cy, cz) => {
    if (ny < -0.6) return 'dark';
    if (ny > 0.7 && cy > cabTop - 0.05) return roofMat;
    if (nz < -0.5 && cy > belt + 0.04 && cy < cabTop - 0.1) return 'glass';
    if (Math.abs(nx) > 0.8 && cy > belt + 0.04 && cy < cabTop - 0.16 && cz > zF + 0.3 && cz < winZ1) return 'glass';
    return 'paint';
  });
  for (const k of Object.keys(b)) P.add(k, b[k]);
  // wheel arch fenders (dark) cut into the cab sides
  fender(P, zf, r, r + 0.06, hw - 0.25, hw + 0.02, r - 0.1, 'dark', 0.08);
  // grille + lamps
  const gy = lerp(bumperY, belt, 0.55);
  P.add(o.grilleMat || 'trim', box(hw * 1.1, (belt - bumperY) * 0.5, 0.04, 0, gy, zF + 0.075));
  if (hi) for (let i = 0; i < 4; i++) P.add('dark', box(hw * 1.0, 0.025, 0.03, 0, gy - (belt - bumperY) * 0.18 + i * (belt - bumperY) * 0.12, zF + 0.055));
  for (const sx of [1, -1]) {
    P.lamp('head', `head${sx < 0 ? 'L' : 'R'}`, box(0.28, 0.14, 0.05, sx * (hw - 0.3), bumperY + 0.24, zF + 0.085), 'frontBumper');
    P.lamp('amber', `indF${sx < 0 ? 'L' : 'R'}`, box(0.1, 0.1, 0.05, sx * (hw - 0.08), bumperY + 0.24, zF + 0.09), 'frontBumper');
  }
  c.lamps.head.push([hw - 0.3, bumperY + 0.24, zF + 0.04], [-(hw - 0.3), bumperY + 0.24, zF + 0.04]);
  for (const sx of [1, -1]) {
    P.add('dark', box(0.006, belt - floor, 0.012, sx * (hw - 0.015), (belt + floor) / 2 + 0.1, winZ1 + 0.03));
    P.add('trim', box(0.16, 0.035, 0.42, sx * (hw - 0.1), floor - 0.12, zF + 0.75));
  }
  mirrorsTruck(P, hw, belt + 0.35, zF + 0.25);
  if (o.visor) P.add('paint', box(hw * 2 - 0.1, 0.05, 0.28, 0, cabTop - 0.02, zF + 0.2, 0.12));
  c.zBack = zBack;
  c.cabFloor = floor;
  c.cabTop = cabTop;
  c.belt = belt;
  c.zA = zF + 0.2;
  c.doors = [{ z0: zF + 0.3, z1: winZ1, rear: false }];
  c.seat = { y: floor + 0.5, z: zF + 0.75 };
  c.enginePos = [0, floor - 0.1, zf + 0.3];
  return c;
}

// ======================================================================================
// bodies
// ======================================================================================

function rearLamps(c, y, z, x) {
  const { P } = c;
  for (const sx of [1, -1]) {
    P.lamp('tail', `tail${sx < 0 ? 'L' : 'R'}`, box(0.2, 0.12, 0.05, sx * x, y, z), 'rearBumper');
    P.lamp('reverse', `rev${sx < 0 ? 'L' : 'R'}`, box(0.1, 0.08, 0.05, sx * (x - 0.18), y, z), 'rearBumper');
    P.lamp('amber', `indR${sx < 0 ? 'L' : 'R'}`, box(0.1, 0.08, 0.05, sx * (x + 0.12), y, z), 'rearBumper');
  }
  c.lamps.tail.push([0, y, z]);
}

function frameRails(c, z0, z1, y) {
  const { P } = c;
  for (const sx of [1, -1]) P.add('dark', box(0.1, 0.24, z1 - z0, sx * 0.43, y, (z0 + z1) / 2));
}

function rearBumperBar(c, y) {
  c.P.part('rearBumper', 'trim', box(c.hw * 2 - 0.2, 0.14, 0.12, 0, y, c.zR - 0.06));
  for (const sx of [1, -1]) c.P.add('dark', box(0.4, 0.45, 0.02, sx * (c.hw - 0.4), c.r * 0.9, c.zR - 0.35));
}

function cargoBox(c, z0, z1, y0, y1, mat = 'paint2', o = {}) {
  const { P, hi, hw } = c;
  const w = hw * 2 - 0.02;
  let g = box(w, y1 - y0, z1 - z0, 0, (y0 + y1) / 2, (z0 + z1) / 2);
  if (hi) g = sliceMany(sliceMany(g, 2, [z0 + (z1 - z0) / 3, z0 + (2 * (z1 - z0)) / 3]), 1, [(y0 + y1) / 2]);
  P.add(mat, g);
  // corner posts / top rails
  for (const sx of [1, -1]) {
    P.add('trim', box(0.06, y1 - y0 + 0.02, 0.06, sx * (hw - 0.02), (y0 + y1) / 2, z1 - 0.02));
    P.add('trim', box(0.06, y1 - y0 + 0.02, 0.06, sx * (hw - 0.02), (y0 + y1) / 2, z0 + 0.02));
    P.add('trim', box(0.05, 0.06, z1 - z0, sx * (hw - 0.01), y1 - 0.02, (z0 + z1) / 2));
    P.add('trim', box(0.05, 0.08, z1 - z0, sx * (hw - 0.01), y0 + 0.03, (z0 + z1) / 2));
    if (o.markers !== false) for (let i = 0; i < 3; i++) P.lamp('amber', `side${sx < 0 ? 'L' : 'R'}${i}`, box(0.02, 0.05, 0.08, sx * (hw + 0.002), y0 + 0.12, lerp(z0 + 0.3, z1 - 0.3, i / 2)), 'body');
  }
  // roll-up door slats
  if (o.rollup !== false && hi) for (let i = 1; i < 9; i++) P.part('trunk', 'trim', box(w - 0.2, 0.015, 0.02, 0, y0 + ((y1 - y0) * i) / 9, z1 + 0.005));
  if (o.stripe) P.add(o.stripe, box(w + 0.01, 0.18, z1 - z0 - 0.2, 0, lerp(y0, y1, 0.35), (z0 + z1) / 2));
}

function bodyModule(c, kind, o) {
  const { P, hi, r, zr, zR, hw, H } = c;
  const z0 = c.zBack + (o.gap ?? 0.1);
  const deck = r * 2 + 0.1;
  c.extraAnim = c.extraAnim || [];
  switch (kind) {
    case 'semi': {
      frameRails(c, c.zBack - 0.3, zR, r + 0.25);
      P.add('dark', cyl(0.62, 0.62, 0.1, hi ? 16 : 8, 0, deck + 0.05, zr - 0.15));
      P.add('trim', box(1.2, 0.08, 0.5, 0, deck - 0.02, zr - 0.15));
      for (const z of [zr - 0.68, zr + 0.68]) fender(P, z, r, r + 0.06, hw - 0.5, hw - 0.04, r + 0.1, 'trim', 0.04, 6);
      for (const sx of [1, -1]) P.add('dark', box(0.5, 0.6, 0.02, sx * (hw - 0.35), r * 0.85, zR - 0.1));
      P.add('trim', box(hw * 2 - 0.3, 0.12, 0.12, 0, r + 0.15, zR - 0.08));
      rearLamps(c, r + 0.15, zR - 0.01, hw - 0.4);
      // air lines
      P.add('sirenRed', bar([0.1, c.cabTop - 0.3, c.zBack + 0.05], [0.1, deck + 0.1, zr - 0.5], 0.02, 0.02));
      P.add('sirenBlue', bar([-0.1, c.cabTop - 0.3, c.zBack + 0.05], [-0.1, deck + 0.1, zr - 0.5], 0.02, 0.02));
      break;
    }
    case 'box': {
      frameRails(c, c.zBack - 0.3, zR - 0.2, r + 0.3);
      cargoBox(c, z0, zR - 0.08, deck, H, o.boxMat || 'paint2', { stripe: o.stripe });
      rearBumperBar(c, r * 0.95);
      rearLamps(c, r * 0.95 + 0.14, zR - 0.01, hw - 0.3);
      break;
    }
    case 'dump': {
      frameRails(c, c.zBack - 0.3, zR, r + 0.3);
      const y0 = deck + 0.1, y1 = H - 0.05;
      const zz0 = z0 + 0.1, zz1 = zR - 0.05;
      const m = o.bedMat || 'paint2';
      for (const sx of [1, -1]) {
        const g = slab([[zz0, y0], [zz0 - 0.05, y1], [zz1, y1], [zz1, y0]], sx > 0 ? hw - 0.12 : -hw, sx > 0 ? hw : -hw + 0.12);
        warp(g, (v) => { if (v.y > y0 + 0.1) v.x += Math.sign(v.x) * 0.06 * ((v.y - y0) / (y1 - y0)); });
        P.add(m, g);
        for (let i = 1; i < 5; i++) P.add('trim', box(0.06, y1 - y0 - 0.1, 0.06, sx * (hw + 0.02), (y0 + y1) / 2, lerp(zz0, zz1, i / 5)));
      }
      P.add(m, box(hw * 2, 0.12, zz1 - zz0, 0, y0, (zz0 + zz1) / 2));
      P.add(m, box(hw * 2, y1 - y0, 0.1, 0, (y0 + y1) / 2, zz0));
      P.part('trunk', m, box(hw * 2, y1 - y0 - 0.05, 0.1, 0, (y0 + y1) / 2, zz1));
      P.add(m, box(hw * 2 - 0.1, 0.08, 0.95, 0, y1 + 0.05, zz0 - 0.4, -0.12)); // cab guard
      P.add('dark', box(hw * 2 - 0.3, 0.1, zz1 - zz0 - 0.3, 0, y0 + 0.07, (zz0 + zz1) / 2));
      P.add('chrome', cyl(0.09, 0.09, 1.2, 8, 0, y0 - 0.2, zz0 + 0.3, 'y'));
      if (o.load) P.add('dark', box(hw * 2 - 0.3, 0.3, zz1 - zz0 - 0.4, 0, y1 - 0.35, (zz0 + zz1) / 2));
      rearBumperBar(c, r * 0.95);
      rearLamps(c, r * 0.95 + 0.15, zR - 0.01, hw - 0.3);
      break;
    }
    case 'mixer': {
      frameRails(c, c.zBack - 0.3, zR, r + 0.3);
      const zc = (z0 + zR) / 2 + 0.1;
      const len = zR - z0 - 0.4;
      const rad = Math.min(1.15, (H - deck - 0.3) / 2);
      const yc = deck + rad + 0.25;
      const prof = [[0.05, -len / 2], [rad * 0.55, -len / 2 + 0.05], [rad, -len * 0.18], [rad, len * 0.12], [rad * 0.42, len / 2 - 0.05], [0.25, len / 2]];
      let drum = lathe(prof, hi ? 16 : 10);
      // stripes for the rotation to read
      const fins = [];
      for (let i = 0; i < 2; i++) {
        const g = box(0.08, len * 0.55, 0.06, 0, 0, rad + 0.02);
        rotate(g, 0, 0, 0);
        const a = i * Math.PI;
        for (let k = 0; k < g.length; k += 3) {
          const x = g[k], y = g[k + 1], z = g[k + 2];
          const ang = a + (y / len) * 3.5;
          g[k] = x * Math.cos(ang) - z * Math.sin(ang);
          g[k + 2] = x * Math.sin(ang) + z * Math.cos(ang);
        }
        fins.push(g);
      }
      const tilt = -0.2;
      const toWorld = (g) => translate(rotate(rotate(g, Math.PI / 2, 0, 0), tilt, 0, 0), 0, yc, zc);
      P.group('drum', o.drumMat || 'paint2', toWorld(drum), [0, yc, zc]);
      for (const f of fins) P.group('drum', 'paint', toWorld(f));
      c.drumAxis = [0, Math.sin(-tilt), Math.cos(tilt)];
      P.add('trim', box(1.3, 0.8, 0.12, 0, deck + 0.4, z0 + 0.2));
      P.add('trim', box(1.0, 1.0, 0.12, 0, deck + 0.5, zR - 0.4));
      P.add('chrome', cyl(0.3, 0.3, 0.9, hi ? 12 : 8, 0, deck + 0.35, z0 + 0.65, 'x'));
      P.add('trim', bar([0, yc + 0.3, zR - 0.3], [0, deck + 0.3, zR + 0.4], 0.35, 0.08));
      rearBumperBar(c, r * 0.95);
      rearLamps(c, r * 0.95 + 0.15, zR - 0.01, hw - 0.3);
      break;
    }
    case 'garbage': {
      frameRails(c, c.zBack - 0.3, zR, r + 0.3);
      const y0 = deck, y1 = H;
      const zz1 = zR - 1.1;
      const bp = [[z0, y0], [z0, y1 - 0.25], [z0 + 0.3, y1], [zz1, y1], [zz1, y0]];
      P.add(o.boxMat || 'paint2', extrudeSide(bp, hw * 2 - 0.04, 0.08));
      // packer hopper
      const hp = [[zz1 - 0.02, y0 - 0.25], [zz1 - 0.02, y1 - 0.1], [zR - 0.25, y1 - 0.45], [zR, y0 + 0.3], [zR - 0.2, y0 - 0.25]];
      P.part('trunk', o.hopperMat || 'paint', extrudeSide(hp, hw * 2 - 0.02, 0.06));
      P.part('trunk', 'dark', box(hw * 2 - 0.5, 0.5, 0.1, 0, y0 + 0.2, zR - 0.08, 0.25));
      for (const sx of [1, -1]) P.add('trim', box(0.04, y1 - y0 - 0.2, 0.05, sx * (hw - 0.01), (y0 + y1) / 2, zz1 - 0.6));
      if (o.stripe) for (const sx of [1, -1]) P.add(o.stripe, box(0.01, 0.3, zz1 - z0 - 0.2, sx * (hw - 0.02 + 0.005), y0 + 0.5, (z0 + zz1) / 2));
      for (const sx of [1, -1]) P.lamp('tail', `tail${sx < 0 ? 'L' : 'R'}`, box(0.12, 0.3, 0.05, sx * (hw - 0.15), y1 - 0.35, zR - 0.15), 'trunk');
      P.lamp('amber', 'beaconR', cyl(0.08, 0.08, 0.14, 8, 0, y1 + 0.07, zz1 - 0.3), 'body');
      c.lamps.tail.push([0, y1 - 0.35, zR - 0.1]);
      rearBumperBar(c, r * 0.95);
      break;
    }
    case 'flatbed': {
      frameRails(c, c.zBack - 0.3, zR, r + 0.3);
      const y = deck + 0.05;
      const g = box(hw * 2 - 0.04, 0.14, zR - z0, 0, y, (z0 + zR) / 2, 0.05, 0, 0);
      P.add(o.deckMat || 'trim', g);
      for (const sx of [1, -1]) P.add('paint', box(0.05, 0.16, zR - z0, sx * (hw - 0.02), y + 0.04, (z0 + zR) / 2, 0.05, 0, 0));
      P.add('paint', box(hw * 2 - 0.1, 0.9, 0.12, 0, y + 0.5, z0 + 0.05));
      for (let i = 0; i < 5; i++) P.add('trim', box(hw * 2 - 0.4, 0.04, 0.04, 0, y + 0.2 + i * 0.17, z0 + 0.12));
      P.add('dark', cyl(0.14, 0.14, 0.6, 10, 0, y + 0.25, z0 + 0.35, 'x'));
      if (o.cargo === 'crates') {
        P.add('trim', box(1.2, 0.8, 1.4, -0.3, y + 0.47, z0 + 1.4));
        P.add('paint2', box(1.0, 0.6, 1.0, 0.4, y + 0.37, zR - 1.2));
      }
      rearBumperBar(c, r * 0.95);
      rearLamps(c, r * 0.95 + 0.15, zR - 0.01, hw - 0.3);
      break;
    }
    case 'tanker': {
      frameRails(c, c.zBack - 0.3, zR, r + 0.3);
      const rad = Math.min(hw - 0.05, (H - deck) / 2 - 0.02);
      const yc = deck + rad + 0.05;
      const len = zR - z0 - 0.15;
      const zc = z0 + len / 2 + 0.05;
      const tank = lathe([[0.01, -len / 2 - 0.15], [rad * 0.7, -len / 2 - 0.1], [rad, -len / 2 + 0.05], [rad, len / 2 - 0.05], [rad * 0.7, len / 2 + 0.1], [0.01, len / 2 + 0.15]], hi ? 20 : 10);
      rotate(tank, Math.PI / 2, 0, 0);
      translate(tank, 0, yc, zc);
      warp(tank, (v) => { v.x *= 1.05; v.y = yc + (v.y - yc) * 0.92; });
      P.add(o.tankMat || 'chrome', tank);
      for (let i = 0; i < 3; i++) P.add('trim', cyl(rad + 0.02, rad + 0.02, 0.06, hi ? 20 : 10, 0, yc, z0 + 0.4 + i * (len - 0.6) / 2, 'z'));
      P.add('trim', box(0.5, 0.05, len - 0.2, 0, yc + rad * 0.92 + 0.05, zc));
      for (let i = 0; i < 4; i++) P.add('dark', cyl(0.12, 0.12, 0.08, 8, 0, yc + rad * 0.92 + 0.06, z0 + 0.6 + i * (len - 1.0) / 3));
      if (o.stripe) P.add(o.stripe, translate(rotate(cyl(rad + 0.012, rad + 0.012, len * 0.7, hi ? 20 : 10, 0, 0, 0, 'z'), 0, 0, 0), 0, yc, zc).map((v, i) => v));
      rearBumperBar(c, r * 0.95);
      rearLamps(c, r * 0.95 + 0.15, zR - 0.01, hw - 0.3);
      break;
    }
    case 'tow': {
      frameRails(c, c.zBack - 0.3, zR, r + 0.3);
      const y = deck;
      for (const sx of [1, -1]) {
        P.add('paint', box(0.5, 0.75, zR - z0 - 0.6, sx * (hw - 0.25), y + 0.35, (z0 + zR - 0.6) / 2));
        P.add('chrome', box(0.52, 0.04, zR - z0 - 0.6, sx * (hw - 0.25), y + 0.74, (z0 + zR - 0.6) / 2));
      }
      P.add('dark', box(hw * 2 - 1.1, 0.1, zR - z0, 0, y, (z0 + zR) / 2));
      // boom
      P.add(o.boomMat || 'paint2', bar([0, y + 0.2, z0 + 0.5], [0, y + 1.9, zR - 0.6], 0.28, 0.28));
      P.add(o.boomMat || 'paint2', box(0.6, 1.2, 0.3, 0, y + 0.55, z0 + 0.5));
      P.add('dark', bar([0, y + 1.9, zR - 0.6], [0, y + 0.8, zR - 0.4], 0.03, 0.03));
      P.add('chrome', box(0.12, 0.12, 0.12, 0, y + 0.75, zR - 0.4));
      // wheel lift
      P.add('dark', box(0.2, 0.14, 1.0, 0, r * 0.75, zR + 0.3));
      P.add('dark', box(1.6, 0.12, 0.2, 0, r * 0.75, zR + 0.75));
      for (const sx of [1, -1]) P.add('trim', box(0.12, 0.25, 0.35, sx * 0.7, r * 0.75 + 0.1, zR + 0.75));
      rearLamps(c, y + 0.5, zR - 0.6 + 0.01, hw - 0.25);
      break;
    }
    case 'fire': {
      frameRails(c, c.zBack - 0.3, zR, r + 0.3);
      const y0 = deck - 0.15, y1 = c.cabTop - 0.15;
      const bp = [[z0, y0], [z0, y1], [zR - 0.05, y1], [zR - 0.05, y0]];
      let g = extrudeSide(bp, hw * 2 - 0.04, 0.05);
      P.add('paint', g);
      // compartment doors
      const n = 4;
      for (let i = 0; i < n; i++) {
        const za = lerp(z0 + 0.15, zR - 0.2, i / n) + 0.05, zb = lerp(z0 + 0.15, zR - 0.2, (i + 1) / n) - 0.05;
        if (Math.abs((za + zb) / 2 - zr) < 0.9) continue;
        for (const sx of [1, -1]) {
          P.add('chrome', box(0.02, y1 - y0 - 0.3, zb - za, sx * (hw - 0.01), (y0 + y1) / 2 + 0.05, (za + zb) / 2));
          if (hi) for (let k = 1; k < 6; k++) P.add('trim', box(0.025, 0.012, zb - za, sx * (hw - 0.005), y0 + 0.2 + k * (y1 - y0 - 0.3) / 6, (za + zb) / 2));
        }
      }
      for (const sx of [1, -1]) P.add('plate', box(0.012, 0.14, zR - z0, sx * (hw - 0.012), y0 + 0.2, (z0 + zR) / 2));
      // ladder
      const ly = y1 + 0.25;
      const lz0 = c.zA - 0.1, lz1 = zR + 0.5;
      for (const sx of [1, -1]) P.add('chrome', box(0.06, 0.1, lz1 - lz0, sx * 0.32, ly, (lz0 + lz1) / 2));
      if (hi) for (let z = lz0 + 0.15; z < lz1; z += 0.32) P.add('chrome', box(0.6, 0.03, 0.04, 0, ly, z));
      P.add('trim', box(0.8, 0.3, 0.7, 0, y1 + 0.12, zR - 0.6));
      for (const sx of [1, -1]) P.add('dark', cyl(0.25, 0.25, 0.3, 10, sx * (hw - 0.3), y1 + 0.2, z0 + 0.4, 'x'));
      rearBumperBar(c, r * 0.95);
      rearLamps(c, r * 0.95 + 0.16, zR - 0.01, hw - 0.3);
      break;
    }
    case 'ambulance': {
      frameRails(c, c.zBack - 0.3, zR, r + 0.3);
      const y0 = deck - 0.1, y1 = H;
      let g = extrudeSide([[z0, y0], [z0, y1], [zR - 0.05, y1], [zR - 0.05, y0]], hw * 2 - 0.04, 0.07);
      g = sliceMany(g, 1, [y0 + 0.55, y0 + 0.75, y1 - 0.45]);
      P.add('paint', g);
      for (const sx of [1, -1]) {
        P.add(o.stripe || 'paint2', box(0.012, 0.2, zR - z0 - 0.1, sx * (hw - 0.01), y0 + 0.65, (z0 + zR) / 2));
        P.add('glass', box(0.012, 0.4, 0.5, sx * (hw - 0.012), y1 - 0.65, z0 + 0.6));
        P.lamp('sirenRed', `boxRed${sx < 0 ? 'L' : 'R'}`, box(0.08, 0.14, 0.2, sx * (hw - 0.04), y1 - 0.12, zR - 0.2), 'body');
        P.lamp('sirenRed', `boxRedF${sx < 0 ? 'L' : 'R'}`, box(0.2, 0.14, 0.08, sx * (hw - 0.15), y1 - 0.1, z0 + 0.04), 'body');
      }
      for (const sx of [1, -1]) P.part('trunk', 'glass', box(0.4, 0.45, 0.012, sx * 0.4, y1 - 0.6, zR - 0.04));
      P.part('trunk', 'dark', box(0.01, y1 - y0 - 0.2, 0.012, 0, (y0 + y1) / 2, zR - 0.045));
      P.add('plate', box(0.6, 0.6, 0.012, 0, y0 + 0.65, zR - 0.04)); // emblem backing
      P.add('sirenRed', box(0.4, 0.12, 0.012, 0, y0 + 0.65, zR - 0.034));
      P.add('sirenRed', box(0.12, 0.4, 0.012, 0, y0 + 0.65, zR - 0.033));
      rearBumperBar(c, r * 0.95);
      rearLamps(c, y0 + 0.3, zR - 0.02, hw - 0.15);
      break;
    }
    case 'kei': {
      const y0 = r * 2 + 0.05;
      P.add('trim', box(hw * 2 - 0.06, 0.06, zR - z0, 0, y0, (z0 + zR) / 2));
      for (const sx of [1, -1]) P.add('paint', box(0.04, 0.3, zR - z0, sx * (hw - 0.05), y0 + 0.17, (z0 + zR) / 2));
      P.part('trunk', 'paint', box(hw * 2 - 0.1, 0.3, 0.04, 0, y0 + 0.17, zR - 0.02));
      P.add('paint', box(hw * 2 - 0.1, 0.55, 0.04, 0, y0 + 0.3, z0 + 0.02));
      if (hi) for (let i = 0; i < 4; i++) P.add('trim', box(0.03, 0.5, 0.03, -hw * 0.6 + i * hw * 0.4, y0 + 0.4, z0 + 0.05));
      for (const sx of [1, -1]) P.lamp('tail', `tail${sx < 0 ? 'L' : 'R'}`, box(0.12, 0.1, 0.04, sx * (hw - 0.12), y0 - 0.12, zR - 0.02), 'rearBumper');
      P.part('rearBumper', 'trim', box(hw * 2 - 0.1, 0.1, 0.08, 0, y0 - 0.22, zR - 0.04));
      c.lamps.tail.push([0, y0 - 0.12, zR]);
      if (o.cargo) P.add('paint2', box(hw * 1.2, 0.35, (zR - z0) * 0.5, 0, y0 + 0.2, (z0 + zR) / 2));
      break;
    }
  }
}

function lightbarOn(c, y, z, w, kind = 'police') {
  const { P } = c;
  P.add('dark', box(w, 0.08, 0.3, 0, y, z));
  c.lightbar = { red: [box(w * 0.46, 0.1, 0.24, -w * 0.26, y + 0.08, z)], blue: [box(w * 0.46, 0.1, 0.24, w * 0.26, y + 0.08, z)] };
  if (kind === 'amber') c.lightbar.amber = true;
  if (kind === 'red') c.lightbar.allRed = true;
}

// ======================================================================================

export function designTruck(spec, D = {}, lod = 'high') {
  const st = stations(spec, D);
  const c = { ...st, P: new Parts(), hi: lod !== 'low', lamps: { head: [], tail: [] }, d: D };
  const cab = D.cab || 'conventional';
  if (cab === 'conventional') cabConventional(c, D);
  else if (cab === 'step') stepVan(c, D);
  else cabOver(c, D);
  if (D.body && cab !== 'step') bodyModule(c, D.body, D);
  if (D.lightbar) lightbarOn(c, (c.cabTop ?? st.H) + 0.05, (c.zA ?? st.zF) + 0.45, Math.min(1.6, st.W - 0.4), D.lightbar);
  if (D.beacons) for (const sx of [1, -1]) c.P.lamp('amber', `beacon${sx < 0 ? 'L' : 'R'}`, cyl(0.08, 0.08, 0.14, 8, sx * (st.hw - 0.25), (c.cabTop ?? st.H) + 0.07, (c.zA ?? st.zF) + 0.5), 'body');
  const rearAxles = D.tandem ? [st.zr - 0.68, st.zr + 0.68] : [st.zr];
  const wheels = addWheels(spec, D, st.zr, rearAxles);
  // tandem/rear fenders (mud guards)
  if (D.body !== 'semi' && D.cab !== 'step') for (const z of rearAxles) fender(c.P, z, st.r, st.r + 0.07, st.hw - 0.42, st.hw + 0.01, st.r + 0.05, 'trim', 0.03, 6);
  const seatY = c.seat?.y ?? 1.4, seatZ = c.seat?.z ?? st.zF + 1.0;
  return {
    parts: c.P,
    zones: {
      zF: st.zF, zR: st.zR, zA: c.zA ?? st.zF, zC: c.zBack ?? st.zF + 2, deck: false, hatch: false, sill: c.cabFloor ?? 1, beltF: c.belt ?? 2, beltR: c.belt ?? 2,
      roofY: c.cabTop ?? st.H, doors: c.doors || [], bumperF: st.zF + 0.25, bumperR: st.zR - 0.25, bumperTopF: 1.0, bumperTopR: 0.9, hoodY: 99, hoodZ: st.zF,
    },
    lamps: c.lamps,
    lightbar: c.lightbar || null,
    seats: [{ x: -0.5, y: seatY, z: seatZ }, { x: 0.5, y: seatY, z: seatZ }],
    doors: (c.doors || []).map((dr) => ({ z: (dr.z0 + dr.z1) / 2, y: (c.cabFloor ?? 1) + 0.5 })),
    enginePos: c.enginePos || [0, 1, st.zf],
    exhaustPos: D.stacks ? [st.hw - 0.18, st.H + 0.1, (c.zBack ?? 0) + 0.15] : [st.hw - 0.4, st.r * 0.6, (c.zBack ?? 0) + 0.3],
    wheels,
    rim: D.rimColor || 'chrome', rimStyle: D.rim || 'truck', spokes: 10,
    dims: { length: st.L, width: st.W, height: st.H },
    seatPose: 'truck',
    anim: D.body === 'mixer' ? 'drum' : null,
  };
}

/** Walk-in delivery van: one big box with a short sloped nose. */
function stepVan(c, D) {
  const { P, hi, r, zf, zF, zR, hw, H } = c;
  const bumperY = r * 0.9;
  P.part('frontBumper', 'trim', box(hw * 2 - 0.05, 0.22, 0.18, 0, bumperY, zF + 0.06));
  const hoodY = r * 2 + 0.35;
  const wsTop = H - 0.35;
  const pts = [[zF + 0.1, bumperY + 0.1], [zF + 0.1, hoodY - 0.1], [zF + 0.25, hoodY], [zF + 0.7, hoodY + 0.12], [zF + 0.95, wsTop], [zF + 1.1, H], [zR, H], [zR, bumperY + 0.1]];
  let g = extrudeSide(pts, hw * 2 - 0.02, 0.09);
  const doorZ0 = zF + 1.0, doorZ1 = zF + 1.75;
  g = sliceMany(g, 2, [zF + 0.75, doorZ0, doorZ1, zR - 0.6]);
  g = sliceMany(g, 1, [hoodY + 0.2, wsTop - 0.1, H - 0.6]);
  const b = classify(g, (nx, ny, nz, cx, cy, cz) => {
    if (ny < -0.6) return 'dark';
    if (nz < -0.4 && cy > hoodY + 0.14 && cy < wsTop) return 'glass';
    if (Math.abs(nx) > 0.8 && cz > doorZ0 && cz < doorZ1 && cy > r * 2 && cx > 0) return 'dark'; // open walk-in door
    if (Math.abs(nx) > 0.8 && cz > zF + 0.75 && cz < doorZ0 && cy > hoodY + 0.2 && cy < wsTop - 0.1) return 'glass';
    if (Math.abs(nx) > 0.8 && cz > doorZ0 && cz < doorZ1 && cy > hoodY + 0.2 && cy < wsTop - 0.1 && cx < 0) return 'glass';
    return 'paint';
  });
  for (const k of Object.keys(b)) P.add(k, b[k]);
  fender(P, zf, r, r + 0.06, hw - 0.3, hw + 0.015, r - 0.05, 'dark', 0.06);
  fender(P, c.zr, r, r + 0.06, hw - 0.3, hw + 0.015, r - 0.05, 'dark', 0.06);
  P.add('trim', box(hw * 1.0, 0.24, 0.04, 0, bumperY + 0.25, zF + 0.1));
  for (const sx of [1, -1]) {
    P.lamp('head', `head${sx < 0 ? 'L' : 'R'}`, cyl(0.1, 0.1, 0.05, hi ? 12 : 8, sx * (hw - 0.3), bumperY + 0.28, zF + 0.09, 'z'), 'frontBumper');
    P.lamp('tail', `tail${sx < 0 ? 'L' : 'R'}`, box(0.15, 0.3, 0.04, sx * (hw - 0.12), bumperY + 0.4, zR + 0.01), 'body');
  }
  c.lamps.head.push([hw - 0.3, bumperY + 0.28, zF + 0.05], [-(hw - 0.3), bumperY + 0.28, zF + 0.05]);
  c.lamps.tail.push([0, bumperY + 0.4, zR]);
  P.part('rearBumper', 'trim', box(hw * 2 - 0.1, 0.18, 0.12, 0, bumperY, zR - 0.02));
  if (hi) for (let i = 1; i < 8; i++) P.part('trunk', 'trim', box(hw * 1.5, 0.014, 0.02, 0, bumperY + 0.2 + ((H - bumperY - 0.35) * i) / 8, zR + 0.006));
  if (D.stripe) for (const sx of [1, -1]) P.add(D.stripe, box(0.012, 0.16, zR - zF - 2.0, sx * (hw - 0.005), H - 0.45, (zF + 1.9 + zR) / 2));
  mirrorsTruck(P, hw, hoodY + 0.55, zF + 0.85);
  c.zBack = zR;
  c.cabFloor = r * 2;
  c.cabTop = H;
  c.belt = hoodY + 0.2;
  c.zA = zF + 0.7;
  c.doors = [{ z0: doorZ0, z1: doorZ1, rear: false }];
  c.seat = { y: r * 2 + 0.55, z: zF + 1.3 };
  c.enginePos = [0, hoodY - 0.25, zF + 0.5];
}

// ======================================================================================
// buses
// ======================================================================================

export function designBus(spec, D = {}, lod = 'high') {
  const st = stations(spec, D);
  const { r, zf, zr, zF, zR, hw, H } = st;
  const hi = lod !== 'low';
  const P = new Parts();
  const c = { ...st, P, hi, lamps: { head: [], tail: [] } };
  const kind = D.bus || 'city';
  const floor = kind === 'coach' ? r * 2 + 0.55 : kind === 'school' ? r * 2 + 0.25 : 0.38;
  const winY0 = kind === 'coach' ? 1.75 : kind === 'school' ? r * 2 + 0.75 : 1.15;
  const winY1 = H - (kind === 'school' ? 0.4 : 0.32);
  let zFront = zF;
  // school bus: conventional nose
  if (kind === 'school') {
    const hoodLen = 1.2;
    const hoodY = r * 2 + 0.4;
    P.add('paint', extrudeSide([[zF + 0.15, r * 0.9], [zF + 0.1, hoodY - 0.15], [zF + 0.3, hoodY], [zF + hoodLen + 0.1, hoodY + 0.1], [zF + hoodLen + 0.1, r * 0.9]], 1.4, 0.08));
    P.add('chrome', box(1.0, hoodY - r * 0.9 - 0.3, 0.05, 0, (hoodY + r * 0.9) / 2, zF + 0.13));
    fender(P, zf, r, r + 0.08, 0.6, hw - 0.12, r - 0.1, 'paint', 0.12);
    for (const sx of [1, -1]) {
      P.lamp('head', `head${sx < 0 ? 'L' : 'R'}`, cyl(0.1, 0.1, 0.06, 10, sx * 0.85, r + 0.45, zF + 0.32, 'z'), 'body');
    }
    c.lamps.head.push([0.85, r + 0.45, zF + 0.28], [-0.85, r + 0.45, zF + 0.28]);
    P.part('frontBumper', 'dark', box(hw * 2 - 0.1, 0.25, 0.2, 0, r * 0.85, zF + 0.05));
    zFront = zF + hoodLen;
  }
  // main body shell
  const top = H;
  const nose = kind === 'school' ? zFront : zF;
  const wsRake = kind === 'coach' ? 0.45 : kind === 'school' ? 0.1 : 0.15;
  const pts = [
    [nose + (kind === 'school' ? 0 : 0.06), floor - 0.25], [nose, winY0 - 0.25], [nose + wsRake * 0.6, winY1 - 0.1], [nose + wsRake + 0.08, top],
    [zR - 0.1, top], [zR, top - 0.15], [zR, floor - 0.25],
  ];
  if (kind !== 'school') pts[0] = [nose + 0.06, 0.32];
  let g = extrudeSide(pts, hw * 2 - 0.02, 0.12);
  // window pillars
  const pitch = kind === 'school' ? 0.75 : kind === 'coach' ? 1.35 : 1.25;
  const zs = [];
  const zW0 = nose + wsRake + 0.4, zW1 = zR - 0.6;
  if (hi) for (let z = zW0; z < zW1; z += pitch) zs.push(z, z + 0.09);
  else for (let z = zW0; z < zW1; z += pitch) for (const sx of [1, -1]) P.add('dark', box(0.02, winY1 - winY0, 0.09, sx * (hw - 0.0), (winY0 + winY1) / 2, z + 0.045));
  const doorF = { z0: nose + wsRake + 0.15, z1: nose + wsRake + 1.25 };
  const doorM = kind === 'city' ? { z0: zr - 0.2 - 2.4, z1: zr - 0.2 - 1.2 } : null;
  if (kind === 'city') zs.push(doorM.z0, doorM.z1);
  zs.push(doorF.z0, doorF.z1);
  g = sliceMany(g, 2, zs);
  g = sliceMany(g, 1, [winY0, winY1, floor + 0.1]);
  const inPillar = (z) => {
    if (!hi) return false;
    for (let zz = zW0; zz < zW1; zz += pitch) if (z > zz && z < zz + 0.09) return true;
    return false;
  };
  const stripeMat = D.stripe || 'paint2';
  const b = classify(g, (nx, ny, nz, cx, cy, cz) => {
    if (ny < -0.6) return 'dark';
    if (ny > 0.7 && cy > top - 0.05) return D.roofMat || (kind === 'school' ? 'paint' : 'plate');
    if (nz < -0.5 && cy > winY0 - 0.15 && cy < winY1) return 'glass';
    if (Math.abs(nx) > 0.8) {
      const right = cx > 0;
      if (right && cz > doorF.z0 && cz < doorF.z1 && cy > floor - 0.2) return cy > winY1 ? 'paint' : 'glass';
      if (right && doorM && cz > doorM.z0 && cz < doorM.z1 && cy > floor - 0.2) return cy > winY1 ? 'paint' : 'glass';
      if (cy > winY0 && cy < winY1 && cz > zW0 && cz < zW1) return inPillar(cz) ? 'dark' : 'glass';
      if (kind !== 'school' && cy < winY0 && cy > floor + 0.1) return stripeMat;
    }
    if (nz > 0.5 && cy > winY0 && cy < winY1 && kind !== 'school') return 'glass';
    return 'paint';
  });
  for (const k of Object.keys(b)) P.add(k, b[k]);
  // wheel arches (dark) + skirts
  for (const z of [zf, zr, ...(D.tag ? [zr + 1.35] : [])]) fender(P, z, r, r + 0.06, hw - 0.3, hw + 0.012, r - 0.08, 'dark', 0.05);
  // destination sign, lamps
  if (kind !== 'school') {
    P.lamp('amber', 'destSign', box(1.5, 0.22, 0.04, 0, winY1 + 0.14, nose + wsRake * 0.7 + 0.02, -0.15, 0, 0), 'body');
    for (const sx of [1, -1]) {
      P.lamp('head', `head${sx < 0 ? 'L' : 'R'}`, box(0.32, 0.12, 0.05, sx * (hw - 0.3), 0.62, nose + 0.035), 'frontBumper');
      P.lamp('amber', `indF${sx < 0 ? 'L' : 'R'}`, box(0.12, 0.1, 0.05, sx * (hw - 0.09), 0.62, nose + 0.04), 'frontBumper');
    }
    c.lamps.head.push([hw - 0.3, 0.62, nose], [-(hw - 0.3), 0.62, nose]);
    P.part('frontBumper', 'trim', box(hw * 2 - 0.05, 0.3, 0.12, 0, 0.42, nose + 0.06));
  } else {
    // school bus: warning lamps + stop arm + rub rails
    for (const sx of [1, -1]) {
      P.lamp('amber', `warnF${sx < 0 ? 'L' : 'R'}`, cyl(0.08, 0.08, 0.05, 8, sx * 0.55, winY1 + 0.15, zFront + 0.12, 'z'), 'body');
      P.lamp('tail', `warnFr${sx < 0 ? 'L' : 'R'}`, cyl(0.08, 0.08, 0.05, 8, sx * 0.8, winY1 + 0.15, zFront + 0.12, 'z'), 'body');
      P.lamp('tail', `warnR${sx < 0 ? 'L' : 'R'}`, cyl(0.08, 0.08, 0.05, 8, sx * 0.8, winY1 + 0.15, zR + 0.02, 'z'), 'body');
      for (const y of [floor + 0.05, floor + 0.45, winY0 - 0.12]) P.add('dark', box(0.02, 0.07, zR - zFront - 0.3, sx * (hw + 0.002), y, (zFront + zR) / 2));
    }
    P.add('sirenRed', cyl(0.2, 0.2, 0.02, 8, -(hw + 0.05), winY0 - 0.25, zFront + 1.0, 'x'));
  }
  // rear
  for (const sx of [1, -1]) {
    P.lamp('tail', `tail${sx < 0 ? 'L' : 'R'}`, box(0.18, 0.35, 0.05, sx * (hw - 0.15), 0.85, zR + 0.012), 'rearBumper');
    P.lamp('amber', `indR${sx < 0 ? 'L' : 'R'}`, box(0.18, 0.12, 0.05, sx * (hw - 0.15), 1.12, zR + 0.012), 'rearBumper');
  }
  c.lamps.tail.push([0, 0.85, zR]);
  P.part('rearBumper', 'trim', box(hw * 2 - 0.05, 0.3, 0.12, 0, 0.42, zR - 0.04));
  if (kind === 'city' || kind === 'coach') {
    if (hi) for (let i = 0; i < 6; i++) P.add('dark', box(1.4, 0.03, 0.02, 0, 0.75 + i * 0.08, zR + 0.012));
  }
  // roof equipment
  if (kind === 'city') P.add('plate', box(1.6, 0.25, 2.6, 0, top + 0.12, zr - 1.8));
  if (kind === 'coach') for (const sx of [1, -1]) for (let i = 0; i < 4; i++) P.add('dark', box(0.01, 0.6, 1.1, sx * (hw + 0.002), floor - 0.15, zf + 1.6 + i * 1.6));
  mirrorsTruck(P, hw, winY0 + 0.3, nose + 0.25);
  const wheels = addWheels(spec, { ...D, dual: D.dual ?? true, rim: D.rim || 'truck' }, zr, [zr]);
  if (D.tag) for (const [i, left] of [[2, true], [3, false]]) wheels.push({ phys: i, x: (left ? -1 : 1) * spec.track[1] / 2, z: zr + 1.35, r, w: spec.tireWidth[0], left, steer: false, style: 'truck' });
  return {
    parts: P,
    zones: {
      zF, zR, zA: nose, zC: zR, deck: false, hatch: false, sill: floor, beltF: winY0, beltR: winY0, roofY: top,
      doors: [{ z0: doorF.z0, z1: doorF.z1, rear: false }], bumperF: zF + 0.2, bumperR: zR - 0.2, bumperTopF: 0.7, bumperTopR: 0.7, hoodY: 99, hoodZ: zF,
    },
    lamps: c.lamps,
    seats: [{ x: -0.7, y: floor + 0.55, z: nose + wsRake + 0.7 }],
    doors: [{ z: (doorF.z0 + doorF.z1) / 2, y: floor + 0.6, side: 1 }],
    enginePos: kind === 'school' ? [0, r * 2, zf] : [0, 1.0, zR - 0.8],
    exhaustPos: [hw - 0.3, 0.3, zR - 0.2],
    wheels,
    rim: D.rimColor || 'silver', rimStyle: 'truck', spokes: 10,
    dims: { length: st.L, width: st.W, height: st.H },
    seatPose: 'truck',
  };
}
