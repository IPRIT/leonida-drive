// Parametric passenger-car generator: side profile (lower body) + greenhouse + details.
// One parameter set (see `carDefaults`) per body style; catalog entries override a few values.
import {
  Parts, Profile, arch, box, cyl, slab, extrudeSide, slice, sliceMany, slicePlane, warp, classify, tube, bar, sphere, rotate, translate, mirrorX,
} from './geom.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Style defaults from the vehicle dimensions. Heights are absolute metres. */
export function carDefaults(style, s) {
  const H = s.size.height, r = s.wheelRadius, wb = s.wheelbase;
  const d = {
    style,
    cab: '3box',
    ohFrac: 0.46,
    sill: clamp(r * 0.58, 0.14, 0.42),
    archGap: 0.045 + r * 0.1,
    archFlat: 0,
    archR: 1,
    chin: 0.12,
    noseY: H * 0.5,
    noseRake: 0.1,
    noseRound: 0.07,
    noseBulge: 0.04,
    hoodCrown: 0.02,
    beltF: H * 0.63,
    beltR: H * 0.66,
    deckY: H * 0.68,
    tailY: H * 0.665,
    tailRake: 0.06,
    tailRound: 0.09,
    tailUnder: 0.14,
    aOff: wb * 0.13,
    wsRun: H * 0.6,
    roofY: H,
    roofRound: 0.13,
    crown: 0.015,
    rearLen: 0.88,
    backRun: H * 0.5,
    bevel: 0.075,
    cabBevel: 0.1,
    shoulder: 0.11,
    tumble: 0.1,
    taperF: 0.07,
    taperR: 0.045,
    hips: 0,
    tuck: 0.035,
    doors: 4,
    quarter: 0, // solid C-pillar fraction of the rear side glass
    pillars: 'paint', // 'paint' | 'dark'
    beltTrim: 'chrome',
    head: 'rect',
    headH: 0.12,
    headW: 0.34,
    tail: 'block',
    grille: 'bars',
    grilleMat: 'chrome',
    fbumper: 'body',
    rbumper: 'body',
    exhaust: 'single',
    wing: 'none',
    hood: 'flat',
    roof: 'plain',
    mirrors: 'paint',
    handles: true,
    skirt: false,
    clad: 0, // unpainted lower cladding height (SUV)
    cladArch: false,
    twoTone: null, // 'roof' | 'lower' | 'pillars'
    stripe: null, // 'rally' | 'side' | 'center'
    rim: 'star',
    rimColor: 'chrome',
    spokes: 5,
    whitewall: false,
    layout: 'front',
    plate: true,
    mirrorsZ: 0.32,
  };
  const S = {
    sedan: {},
    taxi: {},
    limo: { aOff: wb * 0.1, rearLen: 1.0, crown: 0.01 },
    coupe: { doors: 2, aOff: wb * 0.16, wsRun: H * 0.66, backRun: H * 0.66, rearLen: 0.85, quarter: 0.25, tumble: 0.12 },
    hatch: { cab: 'hatch', tailRake: 0.12, backRun: H * 0.18, tailRound: 0.07, ohFrac: 0.56, aOff: wb * 0.06, wsRun: H * 0.58, tailY: H * 0.62, beltR: H * 0.62 },
    wagon: { cab: 'wagon', tailRake: 0.06, backRun: H * 0.12, tailY: H * 0.66 },
    fastback: { cab: 'fastback', doors: 2, aOff: wb * 0.2, wsRun: H * 0.66, backRun: H * 0.95, rearLen: 0.55, quarter: 0.3, tumble: 0.14, shoulder: 0.13 },
    sports: { cab: 'fastback', doors: 2, aOff: wb * 0.2, wsRun: H * 0.72, backRun: H * 0.92, rearLen: 0.5, quarter: 0.28, tumble: 0.16, shoulder: 0.15, noseY: H * 0.46, beltF: H * 0.62, beltR: H * 0.68, deckY: H * 0.68, tailY: H * 0.66, noseRake: 0.16 },
    mid: { cab: 'mid', doors: 2, aOff: -0.05, wsRun: H * 0.92, backRun: H * 0.9, rearLen: 0.55, quarter: 0.4, tumble: 0.18, shoulder: 0.2, noseY: H * 0.4, noseRake: 0.22, beltF: H * 0.6, beltR: H * 0.71, deckY: H * 0.73, tailY: H * 0.7, layout: 'mid', taperF: 0.11, hips: 0.03, grille: 'none', head: 'blade' },
    rear: { cab: 'fastback', doors: 2, aOff: wb * 0.28, wsRun: H * 0.5, backRun: H * 1.12, crown: 0.05, roofRound: 0.2, rearLen: 0.36, quarter: 0.35, tumble: 0.17, shoulder: 0.2, noseY: H * 0.48, noseRake: 0.08, noseRound: 0.1, hoodCrown: 0.03, beltF: H * 0.6, beltR: H * 0.66, deckY: H * 0.69, tailY: H * 0.66, layout: 'rear', grille: 'none', head: 'frog', taperF: 0.08, podF: { h: 0.09 }, podR: { h: 0.03 }, deckCrown: 0.06 },
    suv: { cab: 'wagon', sill: clamp(r * 0.82, 0.3, 0.46), noseY: H * 0.56, noseRake: 0.06, beltF: H * 0.62, beltR: H * 0.64, tailY: H * 0.63, deckY: H * 0.63, tailRake: 0.04, backRun: H * 0.08, aOff: wb * 0.16, wsRun: H * 0.4, clad: 0, cladArch: true, roof: 'rails', taperF: 0.05, archGap: 0.06 + r * 0.1, grille: 'big', head: 'rect' },
    offroad: { cab: 'wagon', sill: clamp(r * 0.9, 0.34, 0.5), noseY: H * 0.6, noseRake: 0.02, noseRound: 0.04, beltF: H * 0.62, beltR: H * 0.62, tailY: H * 0.62, deckY: H * 0.62, tailRake: 0.0, tailRound: 0.04, backRun: H * 0.03, aOff: wb * 0.24, wsRun: H * 0.2, roofRound: 0.06, crown: 0, bevel: 0.04, cabBevel: 0.05, shoulder: 0.07, tumble: 0.04, taperF: 0.015, taperR: 0.01, archFlat: 0.5, cladArch: true, grille: 'bars', head: 'round', roof: 'rack', spare: true, fbumper: 'offroad', rbumper: 'offroad' },
    pickup: { cab: 'pickup', sill: clamp(r * 0.85, 0.3, 0.48), noseY: H * 0.56, noseRake: 0.04, noseRound: 0.05, beltF: H * 0.63, beltR: H * 0.63, tailY: H * 0.6, tailRake: 0.0, tailRound: 0.03, aOff: wb * 0.17, wsRun: H * 0.34, cabLen: 1.5, bedY: H * 0.52, railY: H * 0.68, ohFrac: 0.42, grille: 'big', head: 'rect', archFlat: 0.4, taperF: 0.03, taperR: 0.0, roofRound: 0.07, fbumper: 'chrome', rbumper: 'chrome' },
    van: { cab: 'onebox', sill: clamp(r * 0.8, 0.26, 0.4), noseY: H * 0.48, noseRake: 0.12, beltF: H * 0.55, beltR: H * 0.57, tailY: H * 0.57, deckY: H * 0.57, tailRake: 0.02, backRun: H * 0.06, aOff: -0.3, wsRun: H * 0.5, ohFrac: 0.42, taperF: 0.06, roofRound: 0.12, shoulder: 0.06, tumble: 0.05, head: 'rect', grille: 'bars' },
    minivan: { cab: 'onebox', sill: clamp(r * 0.7, 0.2, 0.36), noseY: H * 0.46, noseRake: 0.16, beltF: H * 0.56, beltR: H * 0.58, tailY: H * 0.58, deckY: H * 0.58, tailRake: 0.08, backRun: H * 0.12, aOff: -0.15, wsRun: H * 0.66, ohFrac: 0.46, taperF: 0.08, roofRound: 0.14, head: 'blade', grille: 'wide' },
    micro: { cab: 'hatch', tailRake: 0.06, backRun: H * 0.1, ohFrac: 0.5, aOff: -0.05, wsRun: H * 0.5, noseY: H * 0.48, beltF: H * 0.55, beltR: H * 0.55, tailY: H * 0.55, doors: 2, taperF: 0.12, taperR: 0.1, roofRound: 0.16, bevel: 0.09, cabBevel: 0.12 },
    roadster: { cab: 'open', doors: 2, aOff: wb * 0.24, wsRun: 0.32, rearLen: 1.0, tumble: 0.0, shoulder: 0.14 },
  };
  Object.assign(d, S[style] || {});
  return d;
}

const ZERO = [0, 0, 0];

/**
 * Generate a passenger car. spec = derived physics spec; D = catalog design overrides.
 * Returns { parts: Parts, zones, wheels, lamps, popups, lightbar, seats, doors, enginePos, exhaustPos, rimStyle... }.
 */
export function designCar(spec, D = {}, lod = 'high') {
  const hi = lod !== 'low';
  const d = { ...carDefaults(D.style || 'sedan', spec), ...D };
  const P = new Parts();
  const r = spec.wheelRadius, wb = spec.wheelbase;
  const zf = -wb / 2, zr = wb / 2;
  const L = spec.size.length, W = spec.size.width;
  const over = Math.max(0.6, L - wb);
  const ohF = d.ohF ?? over * d.ohFrac, ohR = over - ohF;
  const zF = zf - ohF, zR = zr + ohR;
  const hw = W / 2;
  const R = r + d.archGap;
  const sill = d.sill;
  const bumperY = d.bumperY || [sill + 0.03, sill + 0.06];
  const yBF = Math.min(bumperY[0], d.noseY - 0.25), yBR = Math.min(bumperY[1], d.tailY - 0.25);
  const cab = d.cab;
  const roofY = d.roofY;

  // ---------- key stations ----------
  const zA = zf + d.aOff; // windshield base
  const zRoofF = zA + d.wsRun;
  let zC, zRoofR, deck;
  const tailTopZ = zR - d.tailRake - d.tailRound;
  if (cab === 'hatch' || cab === 'wagon' || cab === 'onebox') {
    zC = tailTopZ + d.tailRound * 0.3;
    zRoofR = zC - d.backRun;
    deck = false;
  } else if (cab === 'pickup') {
    zC = zA + d.cabLen;
    zRoofR = zC - 0.06;
    deck = false;
  } else if (cab === 'open') {
    zC = zR - d.rearLen;
    zRoofR = zC;
    deck = true;
  } else {
    zC = zR - d.rearLen;
    zRoofR = zC - d.backRun;
    deck = true;
  }
  zRoofR = Math.max(zRoofR, zRoofF + 0.25);
  const beltAt = (z) => lerp(d.beltF, d.beltR, clamp((z - zA) / Math.max(0.1, zC - zA), 0, 1));
  const deckY = cab === 'pickup' ? d.bedY : deck ? d.deckY : d.beltR;

  // ---------- lower body profile ----------
  // centre section: straight bottom (blocks the wheel tunnels); side sections: wheel arches + raised fenders
  const archN = hi ? 9 : 6;
  const tailTop = cab === 'pickup' ? d.tailY : Math.max(d.tailY, deckY - 0.02);
  const chin = Math.max(0.02, Math.min(d.chin, zf - R - zF - 0.05));
  const tailUnder = Math.max(0.02, Math.min(d.tailUnder, zR - (zr + R * d.archR) - 0.05));
  const rearFace = [
    [zR - tailUnder, yBR], [zR, yBR + 0.1],
    [zR - d.tailRake * 0.55, lerp(yBR, tailTop, 0.55)],
    [zR - d.tailRake, tailTop - d.tailRound],
    [zR - d.tailRake - d.tailRound, tailTop],
  ];
  const top = []; // rear -> front
  if (cab === 'pickup') {
    top.push([zC + 0.08, deckY], [zC + 0.04, d.beltR]);
  } else if (deck) {
    if (zC + 0.25 < tailTopZ) top.push([lerp(zC, tailTopZ, 0.55), Math.max(deckY, tailTop) + (d.deckCrown ?? 0.015)]);
    top.push([zC + 0.03, deckY]);
    if (Math.abs(deckY - d.beltR) > 0.03) top.push([zC - 0.02, d.beltR]);
  }
  top.push([zA + 0.02, d.beltF]);
  const zN = zF + d.noseRake;
  const cowl = d.cowlY ?? d.beltF - 0.01;
  top.push([zA - 0.06, cowl]);
  top.push([lerp(zN, zA, 0.5), lerp(d.noseY, cowl, 0.5) + d.hoodCrown]);
  top.push([zN + d.noseRound, d.noseY]);
  const yMidNose = lerp(yBF, d.noseY, 0.45);
  const noseFace = [[zN + d.noseRound * 0.2, d.noseY - d.noseRound * 0.7], [zF - d.noseBulge * 0.3, yMidNose], [zF + 0.03, yBF + 0.05]];
  const loC = [[zF + chin, yBF], [zf - R, sill], [zr + R, sill], ...rearFace, ...top, ...noseFace];
  const prof = new Profile(loC);
  // fender line: raise the side sections over the arches (low bonnets, frog-eye / hip pods)
  const RR = R * d.archR;
  const wheels2 = [
    { zc: zf, R, need: Math.max(r + R + (d.fenderPad ?? 0.045), d.podF ? (prof.topAt(zf) ?? 0) + (d.podF.h ?? 0.1) : 0) },
    { zc: zr, R: RR, need: Math.max(r + RR + (d.fenderPad ?? 0.045), d.podR ? (prof.topAt(zr) ?? 0) + (d.podR.h ?? 0.04) : 0) },
  ];
  const blend = d.fenderBlend ?? 0.38;
  const topS = [];
  {
    const zsTop = new Set(top.map((p) => p[0]));
    const extra = [];
    for (const w of wheels2) for (const k of [-1.25, -0.95, -0.6, -0.2, 0.2, 0.6, 0.95, 1.25]) extra.push(w.zc + k * (w.R + blend * 0.5));
    const all = [...top];
    const zMin = top[top.length - 1][0], zMax = top[0][0];
    for (const z of extra) if (z > zMin + 0.02 && z < zMax - 0.02 && !zsTop.has(z)) all.push([z, prof.topAt(z) ?? 0]);
    all.sort((a, b) => b[0] - a[0]);
    for (let i = all.length - 1; i > 0; i--) if (Math.abs(all[i][0] - all[i - 1][0]) < 0.025) all.splice(zsTop.has(all[i][0]) ? i - 1 : i, 1);
    for (const [z, y0] of all) {
      let y = y0;
      for (const w of wheels2) {
        const t = 1 - sstep(w.R * 0.85, w.R + blend, Math.abs(z - w.zc));
        if (t > 0 && w.need > y0) y = Math.max(y, y0 + (w.need - y0) * t);
      }
      topS.push([z, y]);
    }
  }
  const loS = [[zF + chin, yBF], ...arch(zf, r, R, sill, archN, d.archFlat), ...arch(zr, r, RR, sill, archN, d.archFlat), ...rearFace, ...topS, ...noseFace];
  const profS = new Profile(loS);

  // plan-view shaping
  const noseStart = zf + 0.25, tailStart = zr - 0.15;
  const kx = (z, y) => {
    let k = 1;
    if (z < noseStart) {
      const t = clamp((noseStart - z) / (noseStart - zF), 0, 1);
      const yk = 1 + 0.35 * clamp((y - yBF) / Math.max(0.1, d.noseY - yBF), 0, 1.4);
      k -= d.taperF * yk * t * t;
    }
    if (z > tailStart) {
      const t = clamp((z - tailStart) / (zR - tailStart), 0, 1);
      k -= d.taperR * t * t;
    }
    if (d.hips) k += d.hips * Math.exp(-(((z - zr) / 0.85) ** 2)) * sstep(sill, sill + 0.25, y);
    k -= d.tuck * clamp((sill + 0.12 - y) / 0.18, 0, 1);
    return k;
  };
  const halfW = (z, y) => hw * kx(z, y);

  const innerX = Math.max(0.25, Math.min(spec.track[0], spec.track[1]) / 2 - Math.max(...spec.tireWidth) / 2 - 0.1);
  const sideW = hw - innerX + d.bevel + 0.03;
  const sideR = translate(extrudeSide(loS, sideW, d.bevel, d.bevel * 0.85), hw - sideW / 2, 0, 0);
  const centre = extrudeSide(loC, innerX * 2, 0);
  let body = new Float32Array(sideR.length * 2 + centre.length);
  body.set(sideR, 0);
  body.set(mirrorX(sideR), sideR.length);
  body.set(centre, sideR.length * 2);
  // slice for plan rounding (+ deformation density on the player LOD)
  const zs = [];
  for (let i = 1; i <= (hi ? 4 : 2); i++) zs.push(lerp(noseStart, zF, i / ((hi ? 4 : 2) + 1)));
  for (let i = 1; i <= (hi ? 3 : 1); i++) zs.push(lerp(tailStart, zR, i / ((hi ? 3 : 1) + 1)));
  if (hi) {
    for (let z = zf + 0.3; z < zr - 0.2; z += 0.42) zs.push(z);
    for (const z of doorCuts()) zs.push(z);
  }
  body = sliceMany(body, 2, zs);
  if (hi) body = sliceMany(body, 1, [sill + 0.12, lerp(sill, d.beltF, 0.55), d.beltF - 0.06]);
  if (d.clad) body = slice(body, 1, d.clad);
  warp(body, (v) => {
    v.x *= kx(v.z, v.y);
  });

  const twoLowerY = d.twoTone === 'lower' || d.twoTone === 'upper' ? d.twoToneY ?? lerp(sill, d.beltF, 0.42) : -1;
  if (twoLowerY > 0) body = slice(body, 1, twoLowerY);
  const sp = d.sidePanel;
  if (sp) body = sliceMany(sliceMany(body, 1, [sp.y0, sp.y1]), 2, [sp.z0 ?? zf + R + 0.08, sp.z1 ?? zR - 0.25]);
  const innerLim = innerX + 0.02;
  const archLip = (ny, nz, cz, cy) => {
    for (const w of wheels2) {
      const dz = cz - w.zc, dy = cy - r;
      const dd = Math.hypot(dz, dy);
      if (dd > w.R - 0.03 && dd < w.R + d.bevel * 1.8 && cy > sill - 0.03 && (nz * dz + ny * dy) / dd < -0.2) return true;
    }
    return false;
  };
  const lowerB = classify(body, (nx, ny, nz, cx, cy, cz) => {
    if (archLip(ny, nz, cz, cy)) return Math.abs(nx) < 0.35 ? 'dark' : d.clad && cy < d.clad ? 'trim' : twoLowerY > 0 && cy < twoLowerY && d.twoTone !== 'upper' ? 'paint2' : 'paint';
    if (ny < -0.6) return 'dark';
    if (Math.abs(nx) > 0.6 && Math.abs(cx) < innerLim * kx(cz, cy) + 0.01 && cy < (prof.topAt(cz) ?? 9) - 0.03) return 'dark'; // wheel-well walls
    if (d.clad && cy < d.clad) return 'trim';
    if (sp && Math.abs(nx) > 0.75 && cy > sp.y0 && cy < sp.y1 && cz > (sp.z0 ?? zf + R + 0.08) && cz < (sp.z1 ?? zR - 0.25)) return sp.mat || 'paint2';
    if (twoLowerY > 0 && (d.twoTone === 'upper' ? cy > twoLowerY : cy < twoLowerY)) return 'paint2';
    return 'paint';
  });
  for (const k of Object.keys(lowerB)) P.add(k, lowerB[k]);
  const fenderPeak = { z: zf - R - blend * 0.25, y: wheels2[0].need, x: (innerX + hw) / 2, profS };

  // ---------- greenhouse ----------
  let roofLine = null;
  if (cab !== 'open') {
    const rr = d.roofRound;
    const cabPts = [];
    const zCb = cab === 'pickup' ? zC : zC + 0.02;
    cabPts.push([zA - 0.05, d.beltF - 0.05]);
    cabPts.push([zRoofF - rr * 0.55, roofY - rr * 0.32]);
    cabPts.push([zRoofF + rr * 0.45, roofY]);
    if (d.crown) cabPts.push([lerp(zRoofF, zRoofR, 0.5), roofY + d.crown]);
    cabPts.push([zRoofR - rr * 0.45, roofY]);
    cabPts.push([zRoofR + rr * 0.35, roofY - rr * 0.35]);
    cabPts.push([zCb, (cab === 'pickup' ? d.beltR : deck ? deckY : d.beltR) - 0.05]);
    roofLine = new Profile(cabPts);
    const cw = W - 2 * d.shoulder;
    let cg = extrudeSide(cabPts, cw, d.cabBevel, d.cabBevel * 0.85);
    // cut planes for pillars / quarter panel / belt trim
    const pz = pillarStations();
    const cuts = [];
    for (const p of pz) cuts.push(p.z - p.w / 2, p.z + p.w / 2);
    if (d.quarter > 0) cuts.push(quarterZ());
    if (d.panel) cuts.push(doorRanges()[0].z1 + 0.06);
    cg = sliceMany(cg, 2, cuts);
    // belt trim plane (inclined along the belt)
    {
      const dz = zC - zA, dy = d.beltR - d.beltF;
      const n = Math.hypot(dz, dy) || 1;
      // plane through (zA, beltF + 0.035) with normal perpendicular to the belt line in the y/z plane
      const ny = dz / n, nz = -dy / n;
      cg = slicePlane(cg, 0, ny, nz, ny * (d.beltF + 0.035) + nz * zA);
    }
    const tumble = d.tumble;
    warp(cg, (v) => {
      const t = clamp((v.y - d.beltF) / Math.max(0.2, roofY - d.beltF), 0, 1.2);
      v.x *= 1 - tumble * t;
    });
    const qz = d.quarter > 0 ? quarterZ() : Infinity;
    const up = d.twoTone === 'upper';
    const roofMat = d.twoTone === 'roof' || up ? 'paint2' : d.roof === 'vinyl' ? 'dark' : d.roof === 'glass' ? 'glass' : 'paint';
    const pillarMat = d.twoTone === 'pillars' || up ? 'paint2' : d.pillars === 'dark' ? 'dark' : 'paint';
    const panelZ = d.panel ? doorRanges()[0].z1 + 0.06 : Infinity;
    const parts = classify(cg, (nx, ny, nz, cx, cy, cz) => {
      if (ny < -0.6) return null;
      const belt = beltAt(cz);
      const ax = Math.abs(nx);
      if (ax > 0.82) {
        if (cy < belt + 0.035) return d.beltTrim;
        for (const p of pz) if (Math.abs(cz - p.z) < p.w / 2) return p.mat || pillarMat;
        if (cz > qz || cz > panelZ) return pillarMat === 'dark' ? 'paint' : pillarMat;
        return 'glass';
      }
      if (ny > 0.55 && cy > roofY - 0.06) return roofMat;
      if (ax > 0.25 && Math.abs(nz) > 0.15) return pillarMat; // A/C pillars (chamfers)
      if (ax > 0.25 && ny > 0.25) return roofMat; // roof rails (chamfers)
      return 'glass';
    });
    for (const k of Object.keys(parts)) P.add(k, parts[k]);
  }

  // ---------- helpers for details ----------
  const noseZ = (y) => prof.frontAt(y) ?? zF;
  const tailZ = (y) => prof.rearAt(y) ?? zR;
  const topY = (z) => prof.topAt(z) ?? d.beltF;
  const rakeAt = (y0, y1, front = true) => {
    const a = front ? noseZ(y0) : tailZ(y0), b = front ? noseZ(y1) : tailZ(y1);
    return Math.atan2(b - a, y1 - y0) * (front ? 1 : -1);
  };
  const cornerYaw = (z, y, sx) => {
    const a = halfW(z, y), b = halfW(z + (z < 0 ? 0.12 : -0.12), y);
    return sx * Math.atan2(b - a, 0.12) * (z < 0 ? 1 : -1);
  };
  const front = { zF, zN, yBF, nose: d.noseY };
  const ctx = { d, P, spec, hi, r, wb, zf, zr, zF, zR, zA, zC, zN, zRoofF, zRoofR, hw, W, sill, yBF, yBR, prof, roofLine, roofY, noseZ, tailZ, topY, halfW, beltAt, deckY, rakeAt, cornerYaw, front, tailTop };

  // ---------- details ----------
  const lamps = { head: [], tail: [] };
  ctx.lamps = lamps;
  ctx.fenderPeak = fenderPeak;
  ctx.topS = (z) => profS.topAt(z) ?? topY(z);
  frontEnd(ctx);
  rearEnd(ctx);
  sides(ctx);
  if (cab === 'pickup') pickupBed(ctx);
  if (cab === 'open') openCockpit(ctx);
  roofExtras(ctx);
  hoodExtras(ctx);
  spoilers(ctx);
  stripes(ctx);

  // ---------- zones & semantic points ----------
  const doorList = doorRanges();
  const zones = {
    zF, zR, zA, zC, zRoofF, zRoofR, roofY, sill, beltF: d.beltF, beltR: d.beltR, deck, hatch: cab === 'hatch' || cab === 'wagon' || cab === 'onebox',
    deckY, noseY: d.noseY, tailTop,
    doors: doorList,
    bumperF: zF + Math.min(0.42, ohF * 0.42), bumperR: zR - Math.min(0.42, ohR * 0.4),
    bumperTopF: lerp(yBF, d.noseY, d.fbumper === 'chrome' ? 0.45 : 0.62), bumperTopR: lerp(yBR, tailTop, 0.5),
    hoodY: d.noseY - 0.05, hoodZ: zN + 0.02,
    halfW: hw,
  };
  const seatY = Math.max(sill + 0.32, r + 0.12);
  const seatZ = cab === 'onebox' ? zA + 0.75 : zA + Math.max(0.75, d.wsRun * 0.85 + 0.3);
  const seatX = Math.min(0.38, hw * 0.42);
  const seats = [
    { x: -seatX, y: seatY, z: seatZ },
    { x: seatX, y: seatY, z: seatZ },
  ];
  const nSeats = D.seats ?? (d.doors >= 4 ? 5 : 2);
  if (nSeats > 2 && cab !== 'pickup') {
    const z2 = seatZ + (d.style === 'limo' ? 1.6 : 0.85);
    if (z2 < zC + 0.1 || cab !== '3box') {
      seats.push({ x: -seatX, y: seatY + 0.02, z: Math.min(z2, zR - 0.6) }, { x: seatX, y: seatY + 0.02, z: Math.min(z2, zR - 0.6) });
    }
  } else if (nSeats > 2 && cab === 'pickup' && d.cabLen > 1.9) {
    seats.push({ x: -seatX, y: seatY + 0.02, z: seatZ + 0.8 }, { x: seatX, y: seatY + 0.02, z: seatZ + 0.8 });
  }
  const layout = d.layout;
  const enginePos = layout === 'mid' ? [0, d.beltR - 0.25, zr - 0.75] : layout === 'rear' ? [0, deckY - 0.25, zr + 0.35] : [0, d.noseY - 0.2, zf + 0.05];
  return {
    parts: P, zones, lamps, popups: ctx.popups || null, lightbar: ctx.lightbar || null,
    seats, doors: doorList.map((dr) => ({ z: (dr.z0 + dr.z1) / 2, y: lerp(sill, d.beltF, 0.6) })),
    enginePos, exhaustPos: ctx.exhaustPos || [0.45, yBR + 0.06, zR],
    rim: d.rimColor, rimStyle: d.rim, spokes: d.spokes, whitewall: d.whitewall,
    wheels: d.dualRear ? [0, 1, 2, 3].map((i) => {
      const ai = i < 2 ? 0 : 1, left = i % 2 === 0;
      return { phys: i, x: (left ? -1 : 1) * (spec.track[ai] / 2), z: ai === 0 ? zf : zr, r, w: spec.tireWidth[ai], left, steer: ai === 0, dual: ai === 1 };
    }) : undefined,
    dims: { length: L, width: W, height: roofY },
  };

  // ---- local helpers needing the closure ----
  function doorRanges() {
    if (cab === 'open') return [{ z0: zA + 0.08, z1: Math.min(zA + 1.15, zC - 0.1), rear: false }];
    const z0 = zA + 0.04;
    if (cab === 'pickup') {
      if (d.cabLen > 1.9) return [{ z0, z1: z0 + d.cabLen * 0.52, rear: false }, { z0: z0 + d.cabLen * 0.52 + 0.02, z1: zC - 0.06, rear: true }];
      return [{ z0, z1: zC - 0.08, rear: false }];
    }
    const zArchR = zr - R - 0.02;
    if (d.doors <= 2) return [{ z0, z1: Math.min(z0 + (cab === 'onebox' ? 0.95 : 1.2), zArchR - 0.1), rear: false }];
    const zB = d.zB ?? lerp(z0, zArchR + 0.25, 0.5);
    return [{ z0, z1: zB - 0.03, rear: false }, { z0: zB + 0.03, z1: Math.min(zArchR + 0.3, zC - 0.05), rear: true }];
  }
  function doorCuts() {
    const out = [];
    for (const dr of doorRanges()) out.push(dr.z0, dr.z1);
    return out;
  }
  function pillarStations() {
    const out = [];
    if (cab === 'open') return out;
    const doorsR = doorRanges();
    if (doorsR.length > 1 || d.doors > 2) {
      const zB = (doorsR[0].z1 + (doorsR[1]?.z0 ?? doorsR[0].z1)) / 2;
      out.push({ z: zB, w: 0.1 });
    }
    if ((cab === 'wagon' || cab === 'onebox') && doorsR.length > 1) {
      const zCp = doorsR[1].z1 + 0.02;
      if (zCp < zRoofR - 0.25) out.push({ z: zCp, w: 0.13 });
    } else if (cab === 'onebox' && d.doors <= 2) {
      out.push({ z: doorsR[0].z1 + 0.04, w: 0.1 });
    }
    if (d.extraPillars) for (const p of d.extraPillars) out.push({ z: zA + p, w: 0.1 });
    return out;
  }
  function quarterZ() {
    return lerp(zRoofR, zC, 1 - d.quarter) - d.quarter * 0.2;
  }
}

// ======================================================================================
// detail builders (ctx = shared closure values)
// ======================================================================================

export function wheelWells(c) {
  const { P, spec, r, zf, zr, sill } = c;
  const R = r + (c.d?.archGap ?? 0.08);
  const innerW = Math.min(spec.track[0], spec.track[1]) - Math.max(...spec.tireWidth) - 0.04;
  const y0 = Math.max(0.05, Math.min(sill, r) - 0.12);
  for (const z of [zf, zr]) {
    // stay below the body surface (low bonnets)
    let top = r + R - 0.02;
    if (c.topY) for (let k = -1; k <= 1; k += 0.25) top = Math.min(top, c.topY(z + k * R) - 0.05);
    else top = Math.min(top, r + 0.04 + r * 0.575);
    P.add('dark', box(Math.max(0.3, innerW), top - y0, 2 * R + 0.04, 0, (y0 + top) / 2, z));
  }
}

function lampBox(c, kind, name, w, h, x, y, z, rx, ry, attach, depth = 0.05) {
  c.P.lamp(kind, name, box(w, h, depth, x, y, z, rx, ry, 0), attach);
}

function frontEnd(c) {
  const { d, P, hi, zF, yBF, noseZ, halfW, rakeAt, cornerYaw, lamps, zf } = c;
  const nose = d.noseY;
  const headY = d.headY ?? lerp(yBF, nose, 0.76);
  const hh = d.headH, hwl = d.headW;
  const rk = rakeAt(headY - hh / 2, headY + hh / 2);
  const zAt = (y) => noseZ(y);
  const edgeX = (y) => halfW(zAt(y) + 0.05, y) - d.bevel * 0.9;
  const hx = d.headX ?? edgeX(headY) - hwl / 2 - 0.03;
  const attachF = 'frontBumper';
  const style = d.head;
  if (style === 'rect' || style === 'wrap' || style === 'square4') {
    for (const sx of [1, -1]) {
      const z = zAt(headY) - 0.005;
      const ry = style === 'wrap' ? cornerYaw(z + 0.1, headY, sx) * 0.8 : cornerYaw(z + 0.1, headY, sx) * 0.35;
      if (style === 'square4') {
        for (const k of [0, 1]) lampBox(c, 'head', `head${sx < 0 ? 'L' : 'R'}${k}`, hwl * 0.46, hh, sx * (hx - hwl * 0.26 + k * hwl * 0.52), headY, z, rk, ry, 'body');
      } else lampBox(c, 'head', `head${sx < 0 ? 'L' : 'R'}`, hwl, hh, sx * hx, headY, z, rk, ry, 'body');
      P.add('dark', box(hwl + 0.03, hh + 0.03, 0.03, sx * hx, headY, z + 0.02, rk, ry, 0));
      lamps.head.push([sx * hx, headY, z - 0.03]);
    }
  } else if (style === 'round' || style === 'round4') {
    const n = style === 'round4' ? 2 : 1;
    const rad = d.headR ?? (n === 2 ? 0.075 : Math.min(0.1, hh * 0.7));
    for (const sx of [1, -1]) {
      for (let k = 0; k < n; k++) {
        const x = sx * (hx + (n === 2 ? (k - 0.5) * rad * 2.4 : 0));
        const z = zAt(headY);
        c.P.lamp('head', `head${sx < 0 ? 'L' : 'R'}${k || ''}`, rotate(cyl(rad, rad, 0.05, hi ? 14 : 8, 0, 0, 0, 'z'), rk, 0, 0).map((v, i) => v + [x, headY, z - 0.01][i % 3]), 'body');
        P.add('chrome', translate(rotate(cyl(rad + 0.018, rad + 0.018, 0.035, hi ? 14 : 8, 0, 0, 0, 'z'), rk, 0, 0), x, headY, z + 0.005));
      }
      lamps.head.push([sx * hx, headY, zAt(headY) - 0.03]);
    }
  } else if (style === 'blade' || style === 'slit') {
    const h = style === 'slit' ? 0.035 : 0.06;
    for (const sx of [1, -1]) {
      const z = zAt(headY);
      const ry = cornerYaw(z + 0.08, headY, sx) * 0.9;
      lampBox(c, 'head', `head${sx < 0 ? 'L' : 'R'}`, hwl, h, sx * hx, headY, z - 0.005, rk, ry, 'body');
      P.add('dark', box(hwl * 0.96, h * 1.8, 0.03, sx * hx, headY - h * 0.6, z + 0.015, rk, ry, 0));
      lamps.head.push([sx * hx, headY, z - 0.03]);
    }
  } else if (style === 'frog') {
    // round lamps on raised front fenders (rear-engine sports, classics)
    const pk = c.fenderPeak;
    for (const sx of [1, -1]) {
      const zl = pk.z, yl = c.topS(pk.z) - 0.035;
      const x = sx * pk.x * 0.98;
      const rr = d.headR ?? 0.085;
      const g = rotate(cyl(rr, rr, 0.06, hi ? 16 : 8, 0, 0, 0, 'z'), 0.35, 0, 0);
      c.P.lamp('head', `head${sx < 0 ? 'L' : 'R'}`, translate(g, x, yl, zl - 0.03), 'body');
      P.add(d.frogRing || 'paint', translate(rotate(cyl(rr + 0.02, rr + 0.02, 0.06, hi ? 16 : 8, 0, 0, 0, 'z'), 0.35, 0, 0), x, yl + 0.004, zl - 0.005));
      lamps.head.push([x, yl, zl - 0.08]);
    }
  } else if (style === 'popup') {
    c.popups = [1, -1].map((sx) => ({ x: sx * (hx - 0.02), y: c.topY(zF + 0.38) + 0.005, z: zF + 0.32, w: 0.38, d: 0.22 }));
    for (const sx of [1, -1]) lamps.head.push([sx * hx, nose + 0.05, zF + 0.1]);
  }
  // LED bar / DRL accents
  if (d.drl === 'bar') lampBox(c, 'head', 'headBar', halfW(zAt(headY + 0.06), headY) * 1.6, 0.025, 0, headY + hh * 0.5 + 0.03, zAt(headY + 0.06) - 0.005, rk, 0, 'body', 0.03);

  // grille
  const gY = d.grilleY ?? lerp(yBF, nose, d.grille === 'big' || d.grille === 'tall' ? 0.6 : 0.5);
  const gZ = zAt(gY);
  const gm = d.grilleMat;
  const g = d.grille;
  const span = Math.max(0.3, (hx - hwl / 2 - 0.06) * 2);
  if (g === 'bars' || g === 'big' || g === 'wide' || g === 'mesh') {
    const gw = g === 'big' ? Math.max(span, hx * 2 - 0.05) : g === 'wide' ? span * 1.05 : span;
    const gh = g === 'big' ? Math.min(0.42, (nose - yBF) * 0.62) : g === 'wide' ? (nose - yBF) * 0.48 : Math.min(0.2, (nose - yBF) * 0.4);
    const rg = rakeAt(gY - gh / 2, gY + gh / 2);
    P.add('dark', box(gw, gh, 0.04, 0, gY, gZ + 0.005, rg));
    if (g !== 'mesh') {
      const n = Math.max(2, Math.round(gh / 0.06));
      for (let i = 0; i <= n; i++) P.add(gm, box(gw + 0.01, 0.022, 0.03, 0, gY - gh / 2 + (gh * i) / n, gZ - 0.012, rg));
      if (g === 'big') for (const sx of [1, -1]) P.add(gm, box(0.03, gh + 0.03, 0.035, (sx * gw) / 2, gY, gZ - 0.012, rg));
    } else if (hi) {
      for (let i = 1; i < 6; i++) P.add('trim', box(0.012, gh * 0.9, 0.03, -gw / 2 + (gw * i) / 6, gY, gZ - 0.008, rg));
    }
  } else if (g === 'vbars') {
    const gw = span * 0.9, gh = Math.min(0.24, (nose - yBF) * 0.5);
    const rg = rakeAt(gY - gh / 2, gY + gh / 2);
    P.add('dark', box(gw, gh, 0.04, 0, gY, gZ + 0.005, rg));
    P.add(gm, box(gw + 0.04, gh + 0.04, 0.03, 0, gY, gZ + 0.012, rg));
    for (let i = 1; i < 10; i++) P.add(gm, box(0.014, gh, 0.03, -gw / 2 + (gw * i) / 10, gY, gZ - 0.01, rg));
    P.add(gm, bar([gw * 0.35, gY - gh * 0.4, gZ - 0.015], [-gw * 0.35, gY + gh * 0.4, gZ - 0.015], 0.025, 0.02));
  } else if (g === 'twin') {
    for (const sx of [1, -1]) {
      P.add('dark', box(0.22, 0.14, 0.04, sx * 0.14, gY + 0.03, zAt(gY + 0.03) + 0.004, rakeAt(gY - 0.04, gY + 0.1)));
      P.add('chrome', box(0.25, 0.17, 0.03, sx * 0.14, gY + 0.03, zAt(gY + 0.03) + 0.012, rakeAt(gY - 0.04, gY + 0.1)));
    }
  } else if (g === 'shield' || g === 'tall') {
    const gh = g === 'tall' ? (nose - yBF) * 0.75 : 0.24;
    const gw = g === 'tall' ? 0.52 : 0.2;
    const yy = g === 'tall' ? lerp(yBF, nose, 0.52) : gY;
    const rg = rakeAt(yy - gh / 2, yy + gh / 2);
    P.add('chrome', box(gw + 0.04, gh + 0.04, 0.035, 0, yy, zAt(yy) + 0.008, rg));
    P.add('dark', box(gw, gh, 0.04, 0, yy, zAt(yy), rg));
    for (let i = 1; i < (g === 'tall' ? 9 : 4); i++) P.add('chrome', box(0.012, gh, 0.03, -gw / 2 + (gw * i) / (g === 'tall' ? 9 : 4), yy, zAt(yy) - 0.012, rg));
  } else if (g === 'egg') {
    const g1 = cyl(0.28, 0.28, 0.04, hi ? 16 : 8, 0, 0, 0, 'z');
    P.add('dark', translate(rotate(g1.map((v, i) => (i % 3 === 1 ? v * 0.42 : v)), rakeAt(gY - 0.1, gY + 0.1), 0, 0), 0, gY, gZ + 0.005));
  } else if (g === 'slot') {
    P.add('dark', box(span * 0.9, 0.05, 0.04, 0, headY - 0.02, zAt(headY - 0.02) + 0.004, rk));
  }
  // lower intake / bumper
  const fb = d.fbumper;
  const by = lerp(yBF, nose, 0.22);
  if (fb === 'body' || fb === 'sport') {
    const iw = fb === 'sport' ? span * 1.25 : span * 0.95;
    const ih = fb === 'sport' ? 0.14 : 0.08;
    P.add('dark', box(iw, ih, 0.04, 0, by, zAt(by) + 0.006, rakeAt(by - ih / 2, by + ih / 2)));
    if (fb === 'sport') {
      for (const sx of [1, -1]) P.add('dark', box(0.2, 0.16, 0.04, sx * (hx + 0.02), by + 0.03, zAt(by) + 0.01, rakeAt(by - 0.08, by + 0.08), sx * 0.15));
      P.part('frontBumper', 'dark', box(halfW(zF + 0.1, yBF) * 2 * 0.95, 0.025, 0.2, 0, yBF + 0.0, zF + 0.12));
    }
  } else if (fb === 'chrome') {
    const bw = halfW(zF + 0.08, by) * 2 + 0.02;
    P.part('frontBumper', 'chrome', box(bw, 0.11, 0.12, 0, by, zAt(by) - 0.02));
    if (d.style === 'pickup' || d.style === 'offroad' || d.style === 'suv') P.part('frontBumper', 'chrome', box(bw * 0.98, 0.07, 0.06, 0, by - 0.08, zAt(by) + 0.02));
  } else if (fb === 'offroad') {
    const bw = halfW(zF + 0.08, by) * 2 + 0.04;
    P.part('frontBumper', 'trim', box(bw, 0.2, 0.16, 0, by + 0.02, zAt(by) - 0.03));
    P.part('frontBumper', 'dark', box(bw * 0.6, 0.04, 0.4, 0, yBF - 0.02, zAt(by) + 0.15, 0.2));
    for (const sx of [1, -1]) P.part('frontBumper', 'amber', box(0.05, 0.06, 0.05, sx * bw * 0.35, by + 0.02, zAt(by) - 0.11));
  }
  if (d.fogs) for (const sx of [1, -1]) c.P.lamp('head', `fog${sx < 0 ? 'L' : 'R'}`, translate(cyl(0.045, 0.045, 0.04, 10, 0, 0, 0, 'z'), sx * (hx + 0.02), by + 0.01, zAt(by) - 0.02), 'frontBumper');
  // indicators
  if (d.indicators !== false && style !== 'frog') {
    for (const sx of [1, -1]) {
      const y = d.head === 'round' || d.head === 'round4' ? headY - 0.13 : headY - hh / 2 - 0.035;
      const x = sx * (hx + hwl * 0.25);
      c.P.lamp('amber', `indF${sx < 0 ? 'L' : 'R'}`, box(0.1, 0.03, 0.03, x, y, zAt(y) - 0.004, rakeAt(y - 0.02, y + 0.02), cornerYaw(zAt(y) + 0.1, y, sx) * 0.5), 'frontBumper');
    }
  }
  // plate
  if (d.plate && fb !== 'offroad') P.part('frontBumper', 'plate', box(0.36, 0.1, 0.02, 0, by + (fb === 'chrome' ? -0.1 : 0.0) + 0.02, zAt(by + 0.02) - 0.018, rakeAt(by - 0.05, by + 0.05)));
  // bull bar / push bar
  if (d.bullbar) {
    const zb = zF - 0.12, y0 = yBF + 0.05, y1 = d.bullbar === 'push' ? nose + 0.04 : headY + 0.05;
    const m = d.bullbar === 'push' ? 'dark' : 'chrome';
    for (const sx of [1, -1]) P.part('frontBumper', m, box(0.06, y1 - y0, 0.06, sx * 0.38, (y0 + y1) / 2, zb));
    P.part('frontBumper', m, box(0.9, 0.06, 0.06, 0, y1, zb));
    P.part('frontBumper', m, box(0.9, 0.06, 0.06, 0, lerp(y0, y1, 0.45), zb));
    for (const sx of [1, -1]) P.part('frontBumper', m, box(0.05, 0.05, 0.16, sx * 0.38, lerp(y0, y1, 0.45), zb + 0.08));
  }
}

function rearEnd(c) {
  const { d, P, hi, zR, yBR, tailZ, halfW, rakeAt, cornerYaw, lamps, tailTop } = c;
  const top = tailTop;
  const ty = d.tailLampY ?? lerp(yBR, top, d.cab === 'pickup' ? 0.7 : 0.72);
  const edgeX = (y) => halfW(tailZ(y) - 0.05, y) - d.bevel * 0.9;
  const zAt = (y) => tailZ(y);
  const st = d.tail;
  const rk = rakeAt(ty - 0.06, ty + 0.06, false);
  const attachR = d.deck ? 'body' : 'body';
  if (st === 'block' || st === 'wrap' || st === 'slim' || st === 'louver') {
    const w = d.tailW ?? (st === 'slim' ? 0.42 : 0.34), h = st === 'slim' ? 0.06 : d.tailH ?? 0.12;
    for (const sx of [1, -1]) {
      const x = sx * (edgeX(ty) - w / 2 - 0.02);
      const ry = cornerYaw(zAt(ty) - 0.1, ty, sx) * (st === 'wrap' ? 0.9 : 0.4);
      c.P.lamp('tail', `tail${sx < 0 ? 'L' : 'R'}`, box(w, h, 0.05, x, ty, zAt(ty) + 0.004, rk, ry, 0), attachR);
      if (st === 'louver' && hi) for (let k = 1; k < 4; k++) P.add('dark', box(0.012, h, 0.02, x - w / 2 + (w * k) / 4, ty, zAt(ty) + 0.03, rk, ry, 0));
      c.P.lamp('reverse', `rev${sx < 0 ? 'L' : 'R'}`, box(0.09, 0.04, 0.045, x - sx * (w / 2 - 0.06), ty - h / 2 - 0.03, zAt(ty - h / 2 - 0.03) + 0.004, rk, ry, 0), attachR);
    }
  } else if (st === 'bar') {
    const w = halfW(zAt(ty) - 0.08, ty) * 2 - 0.12;
    c.P.lamp('tail', 'tailBar', box(w, 0.05, 0.05, 0, ty, zAt(ty) + 0.004, rk), attachR);
    for (const sx of [1, -1]) c.P.lamp('reverse', `rev${sx < 0 ? 'L' : 'R'}`, box(0.12, 0.04, 0.045, sx * 0.3, ty - 0.08, zAt(ty - 0.08) + 0.004, rk), attachR);
  } else if (st === 'round') {
    const n = d.tailRound4 ? 2 : 1;
    for (const sx of [1, -1]) {
      for (let k = 0; k < n; k++) {
        const x = sx * (edgeX(ty) - 0.09 - k * 0.2);
        c.P.lamp('tail', `tail${sx < 0 ? 'L' : 'R'}${k || ''}`, translate(rotate(cyl(0.07, 0.07, 0.04, hi ? 12 : 8, 0, 0, 0, 'z'), rk, 0, 0), x, ty, zAt(ty) + 0.004), attachR);
      }
      c.P.lamp('reverse', `rev${sx < 0 ? 'L' : 'R'}`, box(0.07, 0.04, 0.045, sx * 0.18, ty - 0.1, zAt(ty - 0.1) + 0.004, rk), attachR);
    }
  } else if (st === 'vertical') {
    const ly0 = lerp(yBR, top, 0.45), ly1 = d.tailTopY ?? Math.min(top + 0.45, c.roofY - 0.25);
    for (const sx of [1, -1]) {
      const zz = (y) => (y > top ? Math.max(tailZ(top - 0.02), c.roofLine?.rearAt(y) ?? tailZ(top - 0.02)) : tailZ(y));
      const x = sx * (halfW(zz(ly0) - 0.05, ly0) - 0.11);
      const g = bar([x, ly0, zz(ly0) + 0.01], [x * (1 - d.tumble * 0.6), ly1, zz(ly1) + 0.01], 0.12, 0.05);
      c.P.lamp('tail', `tail${sx < 0 ? 'L' : 'R'}`, g, attachR);
      c.P.lamp('reverse', `rev${sx < 0 ? 'L' : 'R'}`, box(0.1, 0.05, 0.045, x, ly0 - 0.06, zAt(ly0 - 0.06) + 0.004, rk), attachR);
    }
  }
  // indicators (amber) for classics / US style tails merge into tail lamps; add side markers
  // rear bumper
  const rb = d.rbumper;
  const by = lerp(yBR, top, 0.2);
  if (rb === 'body' || rb === 'sport') {
    P.add('dark', box(halfW(zAt(by) - 0.05, by) * 2 * 0.72, 0.05, 0.04, 0, yBR + 0.05, zAt(yBR + 0.05) + 0.004));
  } else if (rb === 'chrome') {
    P.part('rearBumper', 'chrome', box(halfW(zR - 0.08, by) * 2 + 0.02, 0.11, 0.12, 0, by, zAt(by) + 0.02));
  } else if (rb === 'offroad') {
    P.part('rearBumper', 'trim', box(halfW(zR - 0.08, by) * 2 + 0.03, 0.18, 0.16, 0, by + 0.02, zAt(by) + 0.03));
  }
  if (d.diffuser) {
    P.part('rearBumper', 'dark', box(halfW(zR, yBR) * 1.3, 0.1, 0.32, 0, yBR + 0.04, zR - 0.1));
    if (hi) for (let i = -2; i <= 2; i++) P.part('rearBumper', 'trim', box(0.025, 0.1, 0.3, i * 0.2, yBR + 0.02, zR - 0.08));
  }
  if (d.plate) P.part(d.deck ? 'trunk' : 'rearBumper', 'plate', box(0.36, 0.1, 0.02, 0, lerp(yBR, top, 0.45), zAt(lerp(yBR, top, 0.45)) + 0.016, rakeAt(by, by + 0.2, false)));
  // exhaust
  const ex = d.exhaust;
  const ey = yBR + 0.06;
  const ez = zAt(ey) + 0.02;
  const tips = [];
  if (ex === 'single') tips.push([0.45, 0.04]);
  else if (ex === 'twin') tips.push([0.42, 0.04], [0.52, 0.04]);
  else if (ex === 'dual') tips.push([0.5, 0.045], [-0.5, 0.045]);
  else if (ex === 'quad') tips.push([0.45, 0.045], [0.58, 0.045], [-0.45, 0.045], [-0.58, 0.045]);
  else if (ex === 'center') tips.push([0.07, 0.05], [-0.07, 0.05]);
  else if (ex === 'big') tips.push([0.55, 0.06], [-0.55, 0.06]);
  for (const [x, rr] of tips) P.part('rearBumper', 'chrome', cyl(rr, rr, 0.18, hi ? 10 : 6, x, ey, ez - 0.05, 'z'));
  for (const [x, rr] of tips) P.part('rearBumper', 'dark', cyl(rr * 0.75, rr * 0.75, 0.01, hi ? 10 : 6, x, ey, ez + 0.045, 'z'));
  c.exhaustPos = tips.length ? [tips[0][0], ey, ez + 0.05] : [0.4, ey, zR];
  // spare wheel on the tailgate
  if (d.spare) {
    const sy = lerp(yBR, top, 0.65) + 0.1;
    const sz = zAt(sy) + 0.12;
    const sr = c.r * 0.95;
    P.part('trunk', 'tire', cyl(sr, sr, 0.22, hi ? 14 : 8, 0, sy, sz, 'z'));
    P.part('trunk', d.spareCover ? 'paint' : 'rimDark', cyl(sr * 0.65, sr * 0.65, 0.24, hi ? 14 : 8, 0, sy, sz + 0.01, 'z'));
  }
  if (d.ladder) {
    for (const sx of [1, -1]) P.add('trim', box(0.03, 1.0, 0.03, sx * 0.18 + 0.4, top + 0.25, zR + 0.03));
  }
}

function sides(c) {
  const { d, P, hi, zA, zC, sill, halfW, beltAt, zf, zr, r } = c;
  // mirrors
  if (d.mirrors) {
    const mz = zA + d.mirrorsZ;
    const my = d.beltF + 0.09;
    for (const sx of [1, -1]) {
      const x = sx * (halfW(mz, d.beltF) - d.shoulder * 0.3 + 0.08);
      const mm = d.mirrors === 'truck' ? 'trim' : d.mirrors;
      if (d.mirrors === 'truck') {
        P.add('trim', box(0.06, 0.32, 0.12, x + sx * 0.12, my + 0.12, mz));
        P.add('trim', bar([x - sx * 0.05, my, mz], [x + sx * 0.12, my, mz], 0.025, 0.025));
      } else {
        P.add(mm, box(0.17, 0.1, 0.12, x, my, mz, 0, sx * 0.1, 0));
        P.add('trim', box(0.12, 0.03, 0.05, x - sx * 0.08, my - 0.02, mz + 0.02));
        if (hi) P.add('glass', box(0.012, 0.07, 0.09, x + sx * 0.02, my, mz + 0.062, Math.PI / 2, 0, 0).map((v, i) => v));
      }
    }
  }
  if (!hi) return;
  // door seams + handles
  const doors = c.zones?.doors;
  const cuts = [];
  if (d.cab !== 'open') {
    const z0 = zA + 0.04;
    cuts.push(z0);
  }
  for (const sx of [1, -1]) {
    // side rocker / skirt
    if (d.skirt) P.add(d.skirt === 'paint' ? 'paint' : 'dark', box(0.05, 0.08, zr - zf - 2 * (r + d.archGap) - 0.08, sx * (halfW(0, sill + 0.06) - 0.0), sill + 0.04, (zf + zr) / 2));
  }
  // side markers and handles are placed at door rear edges
  const doorsList = (() => {
    const z0 = zA + 0.04;
    const zArchR = zr - (r + d.archGap) - 0.02;
    if (d.cab === 'pickup') return d.cabLen > 1.9 ? [z0 + d.cabLen * 0.52, zC - 0.06] : [zC - 0.08];
    if (d.doors <= 2) return [Math.min(z0 + (d.cab === 'onebox' ? 0.95 : 1.2), zArchR - 0.1)];
    const zB = d.zB ?? lerp(z0, zArchR + 0.25, 0.5);
    return [zB - 0.03, Math.min(zArchR + 0.3, zC - 0.05)];
  })();
  for (const sx of [1, -1]) {
    const zPrev = [zA + 0.04, ...doorsList];
    for (let i = 0; i < doorsList.length; i++) {
      const z1 = doorsList[i];
      const yb = beltAt(z1);
      const x = sx * (halfW(z1 - 0.1, yb - 0.1) + 0.004);
      // seam lines (front and rear edge of each door)
      for (const zz of [zPrev[i], z1]) {
        const xs = sx * (halfW(zz, lerp(sill, yb, 0.5)) + 0.002);
        P.add('dark', box(0.006, yb - sill - 0.06, 0.012, xs, (yb + sill) / 2 - 0.0, zz));
      }
      if (d.handles && d.cab !== 'open') P.add(d.handleMat || 'trim', box(0.025, 0.03, 0.13, x, yb - 0.08, z1 - 0.17));
    }
    // side marker lights (US style) near the bumpers
    if (d.markers) {
      c.P.lamp('amber', `markF${sx < 0 ? 'L' : 'R'}`, box(0.01, 0.035, 0.08, sx * (halfW(c.zF + 0.25, d.noseY - 0.12) + 0.004), d.noseY - 0.12, c.zF + 0.25), 'frontBumper');
    }
    // side vents (sports)
    if (d.sideVent) {
      const vz = d.layout === 'mid' ? zr - r - d.archGap - 0.35 : zf + r + d.archGap + 0.18;
      const vy = lerp(sill, d.beltF, 0.55);
      P.add('dark', slab([[vz - 0.22, vy - 0.1], [vz + 0.18, vy - 0.12], [vz + 0.2, vy + 0.1], [vz - 0.12, vy + 0.12]], sx * halfW(vz, vy) - 0.03, sx * halfW(vz, vy) + 0.012).map((v, i) => v));
    }
  }
  if (d.snorkel) {
    const zs = zA - 0.35, x = halfW(zs, d.beltF) + 0.04;
    P.add('dark', bar([x, d.noseY - 0.1, zs], [x, d.beltF + 0.02, zs], 0.09, 0.09));
    P.add('dark', bar([x, d.beltF + 0.02, zs], [x - 0.05, c.roofY - 0.05, zA + 0.35], 0.08, 0.08));
    P.add('dark', box(0.11, 0.1, 0.16, x - 0.05, c.roofY + 0.0, zA + 0.32));
  }
  if (d.skirts) {
    const Rr = r + d.archGap;
    for (const sx of [1, -1]) P.add('paint', slab([[zr - Rr - 0.02, sill - 0.02], [zr - Rr * 0.7, r + Rr * 0.75], [zr + Rr * 0.7, r + Rr * 0.75], [zr + Rr + 0.02, sill - 0.02]], sx > 0 ? halfW(zr, r) - 0.03 : -halfW(zr, r) - 0.01, sx > 0 ? halfW(zr, r) + 0.01 : -halfW(zr, r) + 0.03));
  }
  if (d.ornament) P.add('chrome', box(0.03, 0.07, 0.08, 0, d.noseY + 0.03, c.zN + 0.08));
  // arch cladding (SUV / off-road)
  if (d.cladArch) {
    for (const zc of [zf, zr]) {
      const Ra = r + d.archGap;
      const n = 8;
      for (const sx of [1, -1]) {
        for (let i = 0; i < n; i++) {
          const t0 = Math.PI * (i / n), t1 = Math.PI * ((i + 1) / n);
          const p0 = [zc - Math.cos(t0) * (Ra + 0.035), r + Math.sin(t0) * (Ra + 0.035)];
          const p1 = [zc - Math.cos(t1) * (Ra + 0.035), r + Math.sin(t1) * (Ra + 0.035)];
          if (p0[1] < sill - 0.02 && p1[1] < sill - 0.02) continue;
          const x = sx * (halfW((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2) + 0.012);
          P.add('trim', bar([x, p0[1], p0[0]], [x, p1[1], p1[0]], 0.05, 0.07));
        }
      }
    }
  }
}

function pickupBed(c) {
  const { d, P, hi, zC, zR, hw, deckY } = c;
  const rail = d.railY;
  const z0 = zC + 0.06, z1 = zR - d.tailRake - 0.02;
  const len = z1 - z0;
  for (const sx of [1, -1]) {
    P.add('paint', box(0.07, rail - deckY + 0.02, len, sx * (hw - 0.035 - d.bevel * 0.3), (rail + deckY) / 2, (z0 + z1) / 2));
    P.add('trim', box(0.09, 0.03, len, sx * (hw - 0.045 - d.bevel * 0.3), rail + 0.01, (z0 + z1) / 2));
  }
  P.part('trunk', 'paint', box(hw * 2 - 0.1, rail - deckY + 0.02, 0.06, 0, (rail + deckY) / 2, z1 - 0.01));
  P.add('paint', box(hw * 2 - 0.1, rail - deckY, 0.06, 0, (rail + deckY) / 2, z0));
  P.add('dark', box(hw * 2 - 0.16, 0.02, len - 0.04, 0, deckY + 0.01, (z0 + z1) / 2));
  if (hi) for (let i = -3; i <= 3; i++) P.add('trim', box(0.04, 0.015, len - 0.1, i * 0.22, deckY + 0.025, (z0 + z1) / 2));
  if (d.rollbar) {
    for (const sx of [1, -1]) P.add('dark', box(0.06, 0.45, 0.06, sx * (hw - 0.15), rail + 0.2, z0 + 0.15));
    P.add('dark', box(hw * 2 - 0.28, 0.06, 0.06, 0, rail + 0.42, z0 + 0.15));
    for (const sx of [1, -1]) c.P.lamp('head', `roofLamp${sx < 0 ? 'L' : 'R'}`, box(0.16, 0.1, 0.06, sx * 0.35, rail + 0.48, z0 + 0.15), 'body');
  }
  if (d.cargo === 'crates') {
    P.add('trim', box(0.6, 0.35, 0.5, -0.3, deckY + 0.2, z0 + 0.5));
    P.add('paint2', box(0.5, 0.3, 0.45, 0.35, deckY + 0.17, z1 - 0.5));
  }
}

function openCockpit(c) {
  const { d, P, hi, zA, zC, hw, sill, W } = c;
  const belt = d.beltF;
  // windshield frame + glass
  const wsH = d.wsH ?? 0.34;
  const tilt = -0.55;
  const z0 = zA + 0.02;
  P.add('glass', box(W - 2 * d.shoulder - 0.08, wsH, 0.02, 0, belt + wsH / 2 * Math.cos(tilt) - 0.01, z0 + (wsH / 2) * Math.sin(-tilt), tilt));
  P.add(d.wsFrame || 'chrome', box(W - 2 * d.shoulder - 0.02, 0.035, 0.04, 0, belt + wsH * Math.cos(tilt), z0 + wsH * Math.sin(-tilt), tilt));
  for (const sx of [1, -1]) P.add(d.wsFrame || 'chrome', bar([sx * (hw - d.shoulder - 0.02), belt, z0], [sx * (hw - d.shoulder - 0.02), belt + wsH * Math.cos(tilt), z0 + wsH * Math.sin(-tilt)], 0.035, 0.035));
  // tub interior
  const iz0 = zA + 0.15, iz1 = zC - 0.1;
  P.add('interior', box(W - 2 * d.shoulder - 0.06, 0.04, iz1 - iz0, 0, belt - 0.02, (iz0 + iz1) / 2));
  for (const sx of [1, -1]) {
    const sxp = sx * Math.min(0.36, hw * 0.4);
    P.add('interior', box(0.44, 0.12, 0.48, sxp, belt - 0.1, iz0 + 0.75));
    P.add('interior', box(0.44, 0.55, 0.12, sxp, belt + 0.12, iz0 + 1.0, -0.2));
    if (d.rollHoops) P.add('chrome', box(0.05, 0.32, 0.05, sxp, belt + 0.3, iz0 + 1.15));
  }
  P.add('interior', box(W - 2 * d.shoulder - 0.06, 0.1, 0.25, 0, belt + 0.02, zA + 0.2));
  P.add('dark', translate(rotate(cyl(0.17, 0.17, 0.03, hi ? 14 : 8, 0, 0, 0, 'z'), -0.4, 0, 0), -Math.min(0.36, hw * 0.4), belt + 0.15, zA + 0.48));
  if (d.tonneau) P.add('dark', box(W - 2 * d.shoulder - 0.06, 0.05, 0.6, 0, belt + 0.02, iz1 - 0.3));
}

function roofExtras(c) {
  const { d, P, hi, zRoofF, zRoofR, roofY, hw, roofLine } = c;
  const rf = d.roof;
  const roofHalf = (hw - d.shoulder) * (1 - d.tumble) - 0.05;
  const zm = (zRoofF + zRoofR) / 2, len = zRoofR - zRoofF;
  if (rf === 'rails' || rf === 'rack') {
    for (const sx of [1, -1]) {
      P.add('trim', box(0.045, 0.045, len * 0.92, sx * roofHalf * 0.86, roofY + 0.07, zm));
      for (const z of [zRoofF + 0.1, zRoofR - 0.1]) P.add('trim', box(0.05, 0.07, 0.06, sx * roofHalf * 0.86, roofY + 0.03, z));
    }
    if (rf === 'rack') {
      for (let i = 0; i < 4; i++) P.add('trim', box(roofHalf * 1.72, 0.03, 0.04, 0, roofY + 0.1, zRoofF + 0.15 + ((len - 0.3) * i) / 3));
      if (d.roofLamps) for (let k = -1; k <= 1; k++) c.P.lamp('head', `roofLamp${k + 1}`, box(0.18, 0.11, 0.06, k * 0.36, roofY + 0.17, zRoofF + 0.12), 'body');
    }
  } else if (rf === 'sunroof' && hi) {
    P.add('glass', box(roofHalf * 1.1, 0.012, Math.min(0.75, len * 0.45), 0, roofY + d.crown + 0.002, zRoofF + len * 0.3));
  }
  if (d.lightbar) {
    const z = d.lightbarZ ?? zRoofF + Math.min(0.55, len * 0.4);
    const lw = Math.min(1.3, roofHalf * 2 - 0.05);
    P.add('dark', box(lw, 0.07, 0.28, 0, roofY + 0.05, z));
    if (d.lightbar === 'amber') {
      c.lightbar = { red: [box(lw * 0.45, 0.09, 0.22, -lw * 0.25, roofY + 0.125, z)], blue: [box(lw * 0.45, 0.09, 0.22, lw * 0.25, roofY + 0.125, z)], amber: true };
    } else if (d.lightbar === 'red') {
      c.lightbar = { red: [box(lw * 0.45, 0.09, 0.22, -lw * 0.25, roofY + 0.125, z)], blue: [box(lw * 0.45, 0.09, 0.22, lw * 0.25, roofY + 0.125, z)], allRed: true };
    } else {
      c.lightbar = { red: [box(lw * 0.45, 0.09, 0.22, -lw * 0.25, roofY + 0.125, z)], blue: [box(lw * 0.45, 0.09, 0.22, lw * 0.25, roofY + 0.125, z)] };
    }
  }
  if (d.taxiSign) {
    const z = zm + 0.05;
    P.add('plate', slab([[z - 0.2, roofY], [z - 0.16, roofY + 0.17], [z + 0.16, roofY + 0.17], [z + 0.2, roofY]], -0.28, 0.28));
    c.P.lamp('amber', 'taxiSign', box(0.5, 0.1, 0.015, 0, roofY + 0.09, z - 0.18, -0.2, 0, 0), 'body');
  }
  if (d.surfboard) {
    P.add('paint2', sphere(0.5, hi ? 10 : 6, 4, 0, roofY + 0.16, zm, 0.5, 0.06, 2.6));
  }
}

function hoodExtras(c) {
  const { d, P, zN, zA, topY } = c;
  const h = d.hood;
  if (h === 'scoop' || h === 'bulge' || h === 'power' || h === 'shaker') {
    const z0 = lerp(zN, zA, h === 'bulge' ? 0.15 : 0.32), z1 = lerp(zN, zA, 0.9);
    const ht = h === 'scoop' ? 0.09 : h === 'shaker' ? 0.13 : 0.06;
    const w = h === 'power' || h === 'bulge' ? 0.42 : 0.3;
    const pts = [[z0, topY(z0) - 0.02], [z0 + 0.12, topY(z0 + 0.12) + ht], [z1, topY(z1) + ht * 0.6], [z1 + 0.05, topY(z1 + 0.05) - 0.02]];
    if (h === 'shaker') {
      P.add('dark', box(0.34, 0.12, 0.42, 0, topY((z0 + z1) / 2) + 0.06, (z0 + z1) / 2));
      P.add('paint', box(0.36, 0.05, 0.44, 0, topY((z0 + z1) / 2) + 0.14, (z0 + z1) / 2));
      P.add('dark', box(0.3, 0.07, 0.02, 0, topY((z0 + z1) / 2) + 0.07, (z0 + z1) / 2 - 0.22));
    } else {
      P.part('hood', 'paint', slab(pts, -w / 2, w / 2, 0.02));
      if (h === 'scoop') P.part('hood', 'dark', box(w * 0.75, ht * 0.7, 0.02, 0, topY(z0 + 0.12) + ht * 0.45, z0 + 0.115));
    }
  } else if (h === 'vents') {
    for (const sx of [1, -1]) {
      const z = lerp(zN, zA, 0.55);
      for (let i = 0; i < 4; i++) P.part('hood', 'dark', box(0.2, 0.012, 0.035, sx * 0.3, topY(z + i * 0.06) + 0.004, z + i * 0.06));
    }
  }
}

function spoilers(c) {
  const { d, P, hi, zR, zC, tailTop, zRoofR, roofY, hw, topY } = c;
  const w = d.wing;
  if (w === 'none') return;
  const zt = zR - d.tailRake - d.tailRound - 0.02;
  if (w === 'lip') {
    P.part('trunk', 'paint', slab([[zt - 0.12, topY(zt - 0.12) - 0.01], [zt, tailTop + 0.06], [zt + 0.05, tailTop + 0.05], [zt + 0.04, tailTop - 0.02]], -hw * 0.8, hw * 0.8));
  } else if (w === 'duck') {
    P.part('trunk', 'paint', slab([[zt - 0.35, topY(zt - 0.35) - 0.01], [zt - 0.05, tailTop + 0.1], [zt + 0.06, tailTop + 0.12], [zt + 0.08, tailTop - 0.02]], -hw * 0.88, hw * 0.88, 0.02));
  } else if (w === 'wing' || w === 'gt' || w === 'whale') {
    const big = w === 'gt';
    const zw = zt - (big ? 0.18 : 0.12);
    const yw = tailTop + (big ? 0.34 : 0.2);
    const span = hw * (big ? 1.92 : 1.62);
    const chord = big ? 0.32 : 0.24;
    if (w === 'whale') {
      P.part('trunk', 'paint', slab([[zt - 0.55, topY(zt - 0.55)], [zt - 0.3, tailTop + 0.13], [zt + 0.08, tailTop + 0.14], [zt + 0.1, tailTop + 0.06], [zt - 0.05, tailTop - 0.02]], -hw * 0.9, hw * 0.9, 0.02));
      P.part('trunk', 'dark', box(hw * 1.7, 0.012, 0.3, 0, tailTop + 0.145, zt - 0.08));
      return;
    }
    P.part('trunk', d.wingMat || 'paint2', box(span, 0.035, chord, 0, yw, zw, -0.08));
    if (big || hi) for (const sx of [1, -1]) P.part('trunk', d.wingMat || 'paint2', box(0.03, 0.16, chord + 0.08, (sx * span) / 2, yw - 0.02, zw));
    for (const sx of [1, -1]) P.part('trunk', 'trim', box(0.035, yw - tailTop + 0.02, 0.07, sx * span * 0.3, (yw + tailTop) / 2 - 0.01, zw + 0.02));
  } else if (w === 'roof') {
    P.add('paint', slab([[zRoofR - 0.08, roofY - 0.02], [zRoofR + 0.1, roofY + 0.025], [zRoofR + 0.16, roofY - 0.01], [zRoofR + 0.05, roofY - 0.05]], -(hw - d.shoulder) * 0.82, (hw - d.shoulder) * 0.82));
  }
}

function stripes(c) {
  const { d, P, zN, zA, zC, zR, zRoofF, zRoofR, roofY, roofLine, prof, hw } = c;
  if (!d.stripe) return;
  const mat = d.stripeMat || 'paint2';
  if (d.stripe === 'rally' || d.stripe === 'center') {
    const xs = d.stripe === 'rally' ? [[0.1, 0.24], [-0.24, -0.1]] : [[-0.12, 0.12]];
    const segs = [[zN + 0.06, zA - 0.08, (z) => prof.topAt(z)], [zRoofF + 0.05, zRoofR - 0.05, (z) => roofLine?.topAt(z)], [zC + 0.05, zR - d.tailRake - d.tailRound - 0.02, (z) => prof.topAt(z)]];
    for (const [z0, z1, f] of segs) {
      if (z1 - z0 < 0.1) continue;
      const pts = [];
      const n = 6;
      for (let i = 0; i <= n; i++) {
        const z = lerp(z0, z1, i / n);
        const y = f(z);
        if (y == null) continue;
        pts.push([z, y + 0.008]);
      }
      if (pts.length < 2) continue;
      const poly = [...pts, ...pts.slice().reverse().map(([z, y]) => [z, y - 0.02])];
      for (const [x0, x1] of xs) P.add(mat, slab(poly, x0, x1));
    }
  } else if (d.stripe === 'side') {
    const y = lerp(d.sill, d.beltF, 0.68);
    for (const sx of [1, -1]) P.add(mat, box(0.006, 0.07, (zR - zN) * 0.82, sx * (hw * 1.0 + 0.003), y, (zN + zR) / 2 + 0.05));
  }
}
