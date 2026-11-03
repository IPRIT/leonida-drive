// Open small vehicles: golf cart and three-wheeled auto-rickshaw (tuk-tuk).
import { Parts, box, cyl, tube, bar, slab, extrudeSide, rotate, translate } from './geom.js';

const lerp = (a, b, t) => a + (b - a) * t;

function stationsSmall(spec, D) {
  const r = spec.wheelRadius, wb = spec.wheelbase;
  const L = spec.size.length, W = spec.size.width, H = spec.size.height;
  const over = Math.max(0.3, L - wb);
  const ohF = over * (D.ohFrac ?? 0.5);
  return { r, wb, L, W, H, hw: W / 2, zf: -wb / 2, zr: wb / 2, zF: -wb / 2 - ohF, zR: wb / 2 + over - ohF };
}

export function designGolfCart(spec, D = {}, lod = 'high') {
  const s = stationsSmall(spec, D);
  const { r, zf, zr, zF, zR, hw, H } = s;
  const hi = lod !== 'low';
  const P = new Parts();
  const floor = r + 0.12;
  // front cowl
  P.add('paint', extrudeSide([[zF + 0.05, floor - 0.08], [zF, floor + 0.25], [zF + 0.12, floor + 0.42], [zF + 0.5, floor + 0.48], [zF + 0.62, floor + 0.3], [zF + 0.62, floor - 0.08]], hw * 2 - 0.06, 0.09, 0.08));
  P.add('dark', box(hw * 2 - 0.1, 0.05, zR - zF - 0.4, 0, floor - 0.05, (zF + zR) / 2 + 0.1));
  // rear body + seat
  const seatZ = zr - 0.45;
  P.add('paint', extrudeSide([[seatZ - 0.3, floor - 0.08], [seatZ - 0.3, floor + 0.3], [zR - 0.05, floor + 0.32], [zR, floor + 0.1], [zR - 0.1, floor - 0.08]], hw * 2 - 0.04, 0.07));
  P.add('interior', box(hw * 2 - 0.16, 0.12, 0.48, 0, floor + 0.38, seatZ));
  P.add('interior', box(hw * 2 - 0.16, 0.42, 0.1, 0, floor + 0.68, seatZ + 0.27, -0.12, 0, 0));
  // canopy
  const roofY = H - 0.04;
  P.add(D.canopy || 'paint2', box(hw * 2 + 0.04, 0.05, zR - zF - 0.25, 0, roofY, (zF + zR) / 2 + 0.05));
  for (const sx of [1, -1]) {
    P.add('trim', tube([sx * (hw - 0.06), floor + 0.42, zF + 0.55], [sx * (hw - 0.06), roofY, zF + 0.35], 0.022, 0.022, 6));
    P.add('trim', tube([sx * (hw - 0.06), floor + 0.32, seatZ + 0.32], [sx * (hw - 0.06), roofY, seatZ + 0.36], 0.022, 0.022, 6));
  }
  P.add('glass', box(hw * 2 - 0.16, roofY - floor - 0.55, 0.012, 0, (roofY + floor + 0.48) / 2, zF + 0.46, -0.18, 0, 0));
  // steering + dash
  P.add('dark', tube([-0.25, floor + 0.3, zF + 0.6], [-0.25, floor + 0.72, zF + 0.85], 0.02, 0.02, 6));
  P.add('dark', translate(rotate(cyl(0.15, 0.15, 0.025, hi ? 12 : 8, 0, 0, 0, 'z'), -0.55, 0, 0), -0.25, floor + 0.74, zF + 0.86));
  // golf bags on the back
  if (hi) for (const sx of [1, -1]) {
    P.add('paint2', cyl(0.11, 0.11, 0.85, 8, sx * 0.2, floor + 0.65, zR - 0.18, 'y'));
    for (let k = 0; k < 3; k++) P.add('chrome', cyl(0.018, 0.018, 0.25, 4, sx * 0.2 + (k - 1) * 0.05, floor + 1.15, zR - 0.18));
  }
  for (const sx of [1, -1]) {
    P.lamp('head', `head${sx < 0 ? 'L' : 'R'}`, cyl(0.045, 0.045, 0.04, 10, sx * 0.32, floor + 0.3, zF + 0.04, 'z'), 'body');
    P.lamp('tail', `tail${sx < 0 ? 'L' : 'R'}`, box(0.1, 0.06, 0.03, sx * (hw - 0.12), floor + 0.2, zR + 0.005), 'body');
  }
  P.part('frontBumper', 'trim', box(hw * 2 - 0.1, 0.08, 0.08, 0, floor - 0.02, zF - 0.02));
  const wheels = [];
  for (let i = 0; i < 4; i++) {
    const front = i < 2, left = i % 2 === 0;
    wheels.push({ phys: i, x: (left ? -1 : 1) * spec.track[front ? 0 : 1] / 2, z: front ? zf : zr, r, w: spec.tireWidth[front ? 0 : 1], left, steer: front, style: 'steel' });
  }
  return {
    parts: P, zones: null, lamps: { head: [[0.32, floor + 0.3, zF], [-0.32, floor + 0.3, zF]], tail: [[0, floor + 0.2, zR]] }, wheels,
    seats: [{ x: -0.25, y: floor + 0.5, z: seatZ }, { x: 0.25, y: floor + 0.5, z: seatZ }],
    doors: [{ z: seatZ, y: floor + 0.4 }],
    enginePos: [0, floor + 0.1, seatZ + 0.1], exhaustPos: [0, floor, zR],
    rim: 'silver', rimStyle: 'steel', spokes: 5,
    dims: { length: s.L, width: s.W, height: H },
    seatPose: 'car', open: true,
  };
}

export function designTukTuk(spec, D = {}, lod = 'high') {
  const s = stationsSmall(spec, D);
  const { r, zf, zr, zF, zR, hw, H } = s;
  const hi = lod !== 'low';
  const P = new Parts();
  const floor = r + 0.18;
  const nw = 0.62; // nose width
  // front nose / cowl around the single front wheel
  P.add('paint', extrudeSide([[zF + 0.02, floor + 0.05], [zF, floor + 0.55], [zF + 0.1, floor + 0.78], [zF + 0.4, floor + 0.85], [zF + 0.55, floor + 0.2], [zF + 0.3, floor - 0.02]], nw, 0.08, 0.07));
  P.add('paint', box(nw + 0.04, 0.05, 0.3, 0, r + 0.3, zf, 0, 0, 0));
  // floor + rear tub
  P.add('trim', box(hw * 2 - 0.2, 0.06, zR - zF - 0.3, 0, floor, (zF + zR) / 2 + 0.1));
  P.add('paint', extrudeSide([[zr - 0.55, floor - 0.1], [zr - 0.55, floor + 0.45], [zR - 0.05, floor + 0.48], [zR, floor + 0.15], [zR - 0.2, floor - 0.12]], hw * 2, 0.08));
  // side skirts with arches over the rear wheels
  P.add('dark', box(hw * 2 - 0.04, 0.1, 0.9, 0, floor + 0.05, zf + 0.75));
  // passenger bench + driver seat
  P.add('interior', box(hw * 2 - 0.2, 0.14, 0.45, 0, floor + 0.58, zr - 0.25));
  P.add('interior', box(hw * 2 - 0.2, 0.5, 0.1, 0, floor + 0.9, zr + 0.02, -0.12, 0, 0));
  P.add('interior', box(0.42, 0.12, 0.38, 0, floor + 0.42, zf + 0.62));
  // canopy (soft top) on a frame
  const roofY = H - 0.02;
  const canopy = D.canopy || 'paint2';
  P.add(canopy, extrudeSide([[zF + 0.22, roofY - 0.1], [zF + 0.35, roofY], [zR - 0.15, roofY], [zR, roofY - 0.12], [zR - 0.05, roofY - 0.5], [zR - 0.15, roofY - 0.5], [zR - 0.2, roofY - 0.08], [zF + 0.35, roofY - 0.08]], hw * 2 + 0.06, 0.06));
  P.add('glass', box(nw + 0.2, 0.55, 0.015, 0, roofY - 0.38, zF + 0.3, -0.2, 0, 0));
  P.add('trim', box(nw + 0.24, 0.04, 0.04, 0, roofY - 0.1, zF + 0.25));
  for (const sx of [1, -1]) {
    P.add('chrome', tube([sx * (hw - 0.04), floor + 0.05, zf + 0.3], [sx * (hw - 0.04), roofY - 0.05, zf + 0.25], 0.02, 0.02, 6));
    P.add('chrome', tube([sx * (hw - 0.04), floor + 0.45, zR - 0.12], [sx * (hw - 0.04), roofY - 0.05, zR - 0.15], 0.02, 0.02, 6));
    P.add('chrome', tube([sx * (hw - 0.03), floor + 0.65, zf + 0.3], [sx * (hw - 0.03), floor + 0.65, zR - 0.15], 0.016, 0.016, 6));
    P.add(canopy, box(0.03, 0.42, zR - zf - 0.55, sx * (hw + 0.0), roofY - 0.3, (zf + 0.35 + zR - 0.2) / 2));
  }
  // handlebar + lamps
  P.group('steer', 'trim', tube([0, floor + 0.7, zF + 0.5], [0, floor + 0.95, zF + 0.62], 0.025, 0.025, 6), [0, floor + 0.7, zF + 0.5]);
  P.group('steer', 'trim', tube([-0.3, floor + 0.95, zF + 0.68], [0.3, floor + 0.95, zF + 0.68], 0.016, 0.016, 6));
  P.group('steer', 'paint', extrudeSide([[zf - 0.25, r + 0.08], [zf - 0.1, r + 0.28], [zf + 0.12, r + 0.26], [zf + 0.2, r + 0.1], [zf + 0.1, r + 0.24], [zf - 0.1, r + 0.22], [zf - 0.2, r + 0.06]], 0.16, 0));
  P.lamp('head', 'head', cyl(0.075, 0.075, 0.05, hi ? 12 : 8, 0, floor + 0.62, zF - 0.01, 'z'), 'body');
  P.add('chrome', cyl(0.09, 0.09, 0.04, hi ? 12 : 8, 0, floor + 0.62, zF + 0.005, 'z'));
  for (const sx of [1, -1]) {
    P.lamp('amber', `indF${sx < 0 ? 'L' : 'R'}`, box(0.06, 0.04, 0.03, sx * 0.24, floor + 0.62, zF + 0.04), 'body');
    P.lamp('tail', `tail${sx < 0 ? 'L' : 'R'}`, box(0.12, 0.08, 0.03, sx * (hw - 0.15), floor + 0.3, zR + 0.005), 'body');
  }
  P.add('chrome', tube([0.3, floor - 0.05, zR - 0.3], [0.35, floor - 0.02, zR + 0.12], 0.035, 0.035, 6));
  const wheels = [
    { phys: 0, x: 0, z: zf, r, w: spec.tireWidth[0], steer: true, style: 'steel' },
    { phys: 2, x: -spec.track[1] / 2, z: zr, r, w: spec.tireWidth[1], left: true, steer: false, style: 'steel' },
    { phys: 3, x: spec.track[1] / 2, z: zr, r, w: spec.tireWidth[1], left: false, steer: false, style: 'steel' },
  ];
  return {
    parts: P, zones: null, lamps: { head: [[0, floor + 0.62, zF - 0.05]], tail: [[0, floor + 0.3, zR]] }, wheels,
    seats: [{ x: 0, y: floor + 0.55, z: zf + 0.62 }, { x: -0.3, y: floor + 0.7, z: zr - 0.25 }, { x: 0.3, y: floor + 0.7, z: zr - 0.25 }],
    doors: [{ z: zf + 0.6, y: floor + 0.4 }],
    enginePos: [0, floor + 0.2, zr], exhaustPos: [0.35, floor, zR + 0.12],
    rim: 'silver', rimStyle: 'steel', spokes: 5,
    dims: { length: s.L, width: s.W, height: H },
    seatPose: 'bike', open: true,
  };
}
