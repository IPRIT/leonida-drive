import { K, LOD, rng } from '../kit.js';
import { mooredBoats } from './parking.js';

// Watson Island's north-facing beach, opposite the arena and Bayfront marina.
// The source map marks this strip as beach/park, not a residential subdivision.
// Original procedural props; all roots are checked against the live coast and roads.
function palm(b, x, y, z, h, phase) {
  const dx = Math.cos(phase) * h * 0.16, dz = Math.sin(phase) * h * 0.16;
  b.paint(0x8c7351, K.PLAIN);
  for (let k = 0; k < 3; k++) {
    const a = k / 3, c = (k + 1) / 3;
    b.beam(x + dx * a * a, y + h * a, z + dz * a * a, x + dx * c * c, y + h * c, z + dz * c * c, 0.48 - k * 0.07, 0.48 - k * 0.07);
  }
  const cx = x + dx, cz = z + dz;
  for (let f = 0; f < 8; f++) {
    const a = phase + f * Math.PI / 4, ux = Math.cos(a), uz = Math.sin(a), px = -uz, pz = ux;
    b.paint(f % 2 ? 0x426e35 : 0x557c3b, K.PLAIN);
    for (let k = 0; k < 3; k++) {
      const t = k / 3, u = (k + 1) / 3;
      const point = (s, side) => [cx + ux * s * 5.8 + px * Math.sin(s * Math.PI) * side * 0.75,
        y + h + Math.sin(s * Math.PI) * 1.1 - s * s * 2.3, cz + uz * s * 5.8 + pz * Math.sin(s * Math.PI) * side * 0.75];
      const p = [point(t, -1), point(u, -1), point(u, 1), point(t, 1)];
      b.quad(...p); b.quad(p[3], p[2], p[1], p[0]);
    }
  }
  b.colCyl(x, z, y, y + h * 0.7, 0.3);
}

function cabana(b, x, y, z, yaw) {
  b.push(); b.translate(x, y, z).rotY(yaw);
  b.paint(0x957b56, K.PLAIN);
  b.box(-4.6, 0, -3.2, 4.6, 0.22, 3.2);
  for (const sx of [-4, 4]) for (const sz of [-2.6, 2.6]) b.box(sx - 0.12, 0.2, sz - 0.12, sx + 0.12, 3.8, sz + 0.12);
  b.paint(0xf7f0db, K.PLAIN);
  b.box(-4.7, 3.78, -3.4, 4.7, 3.9, 3.4);
  b.colBox(-4.7, 3.78, -3.4, 4.7, 3.9, 3.4);
  b.colBox(-4.6, 0, -3.2, 4.6, 0.22, 3.2);
  for (const side of [-1, 1]) {
    const p = [[-4.7, 3.8, side * 3.4], [4.7, 3.8, side * 3.4], [4.7, 4.7, 0], [-4.7, 4.7, 0]];
    b.quad(...p); b.quad(p[3], p[2], p[1], p[0]);
    b.box(-4.1, 0.45, side * 2 - 0.5, 4.1, 0.95, side * 2 + 0.5);
  }
  b.lod = LOD.NEAR;
  b.paint(0x6c5946, K.PLAIN); b.box(-1.5, 0.3, -0.8, 1.5, 0.65, 0.8);
  b.lod = LOD.BOTH;
  b.pop();
}

export function watsonWaterfront(ctx) {
  const { b } = ctx, random = rng(4041977);
  ctx.remove({ poly: [[35, -660], [430, -660], [430, -505], [245, -490], [155, -340], [50, -340]], filter: (r) => r.procedural });
  ctx.remove({ poly: [[95, -635], [210, -600], [400, -570], [400, -535], [200, -553], [95, -550]] });
  for (let i = 0; i < 160; i++) {
    const x = 95 + random() * 295, z = -620 + random() * 100;
    if (!ctx.dryDisc(x, z, 3) || !ctx.clearOfRoads(x, z, 6)) continue;
    palm(b, x, ctx.groundY(x, z), z, 10 + random() * 7, random() * Math.PI * 2);
  }
  for (const [x, z] of [[130, -592], [170, -584], [215, -568], [260, -558], [310, -552], [357, -541]]) {
    if (!ctx.dryRect(x, z, 0.16, 5, 4) || !ctx.clearOfRoads(x, z, 7)) continue;
    cabana(b, x, ctx.groundY(x, z) + 0.1, z, 0.16);
  }
  for (let i = 0; i < 22; i++) {
    const x = 110 + random() * 260, z = -615 + random() * 70;
    if (!ctx.dryDisc(x, z, 2.7) || !ctx.clearOfRoads(x, z, 4)) continue;
    const y = ctx.groundY(x, z);
    b.paint(0x927654, K.PLAIN); b.cyl(x, z, y, y + 2.6, 0.06, 0.06, 5);
    b.paint(i % 3 ? 0xe5d5ae : 0xeae7dc, K.PLAIN); b.cyl(x, z, y + 2.3, y + 3, 2.3, 0.15, 8);
    b.paint(0xe9e3d4, K.PLAIN);
    for (const dx of [-1.2, 1.2]) b.box(x + dx - 0.4, y + 0.25, z - 1, x + dx + 0.4, y + 0.55, z + 1);
  }
  ctx.view([320, 45, -715], [-450, 50, -20], 'Watson Island beach / Bayfront reference');
  const boats = mooredBoats(ctx, { x: 245, z: -615, ux: 1, uz: 0, vx: -0.65, vz: 0.76,
    n: 1, keys: ['boat:boat_speed'], seed: 404, colors: [0x398eb0] });
  return { boats };
}
