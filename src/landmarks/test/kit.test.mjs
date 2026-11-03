// node src/landmarks/test/kit.test.mjs — checks that every primitive's faces point away from its centre
import { Builder, superellipse } from '../kit.js';

function check(name, fn, centre, opts = {}) {
  const b = new Builder({ far: false });
  fn(b);
  const M = b.near, P = M.pos.a, I = M.idx.a;
  let bad = 0, n = 0;
  for (let t = 0; t < M.idx.n; t += 3) {
    const a = I[t] * 3, bb = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[bb] - P[a], uy = P[bb + 1] - P[a + 1], uz = P[bb + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const mx = (P[a] + P[bb] + P[c]) / 3 - centre[0], my = (P[a + 1] + P[bb + 1] + P[c + 1]) / 3 - centre[1], mz = (P[a + 2] + P[bb + 2] + P[c + 2]) / 3 - centre[2];
    const dot = nx * mx + ny * my + nz * mz;
    // also compare with stored normal
    const N = M.nrm.a; const sn = N[I[t] * 3] * nx + N[I[t] * 3 + 1] * ny + N[I[t] * 3 + 2] * nz;
    if (dot < -1e-6 || sn < 0) bad++;
    n++;
  }
  console.log(`${bad ? 'FAIL' : 'ok  '} ${name}: ${n} tris, ${bad} inward`);
  return bad;
}
let fails = 0;
fails += check('box', (b) => b.box(-1, -1, -2, 1, 1, 2, 0b111111), [0, 0, 0]);
fails += check('box rotated', (b) => { b.translate(5, 0, 3); b.rotY(0.7); b.box(-1, -1, -2, 1, 1, 2, 0b111111); }, [5, 0, 3]);
fails += check('prism ccw', (b) => b.prism([[0, 0], [4, 0], [4, 3], [0, 3]].map(([x, z]) => [x - 2, z - 1.5]), -1, 1, { bottom: true }), [0, 0, 0]);
fails += check('prism cw', (b) => b.prism([[0, 0], [0, 3], [4, 3], [4, 0]].map(([x, z]) => [x - 2, z - 1.5]), -1, 1, { bottom: true }), [0, 0, 0]);
fails += check('prism superellipse', (b) => b.prism(superellipse(10, 6, 24), -1, 1, { bottom: true }), [0, 0, 0]);
fails += check('cyl', (b) => b.cyl(0, 0, -1, 1, 2, 1.5, 9, { bottom: true }), [0, 0, 0]);
fails += check('cone', (b) => b.cyl(0, 0, -1, 1, 2, 0, 9, { bottom: true }), [0, 0, 0]);
fails += check('sphere', (b) => b.sphere(0, 0, 0, 2, 10, 6), [0, 0, 0]);
fails += check('dome', (b) => b.dome(0, 0, 0, 3, 10, 4), [0, 0.1, 0]);
fails += check('lathe', (b) => b.lathe(0, 0, [[0, -2], [2, -1], [2, 1], [1, 2]], 8), [0, 0, 0]);
fails += check('beam x', (b) => b.beam(-3, 0, 0, 3, 0, 0, 1, 1), [0, 0, 0]);
fails += check('beam diag', (b) => b.beam(-3, -2, 1, 3, 2, -1, 1, 0.5), [0, 0, 0]);
fails += check('beam vertical', (b) => b.beam(0, -3, 0, 0, 3, 0, 1, 1), [0, 0, 0]);
fails += check('vault', (b) => b.vault(-5, 5, -8, 8, 0, 4, 8, { walls: 2 }), [0, 0.5, 0]);
fails += check('cap up', (b) => b.cap([[0, 0], [4, 0], [4, 3]], 1), [1, 0, 1]);
fails += check('ribbon', (b) => b.ribbon([[0, 0], [10, 0], [10, 10]], 1, () => 0, 0.1), [5, -1, 5]);
if (fails) process.exit(1);
// loft: rings around -z axis (CCW in x-right/y-up), progressing towards -z
const ring = (z, r, sign = 1) => Array.from({ length: 8 }, (_, i) => { const t = sign * (i / 8) * Math.PI * 2; return [Math.cos(t) * r, Math.sin(t) * r, z]; });
let lf = check('loft -z', (b) => b.loft([ring(2, 1), ring(0, 1.2), ring(-2, 0.8)], { capStart: true, capEnd: true }), [0, 0, 0]);
lf += check('loft +z (cw rings)', (b) => b.loft([ring(-2, 1, -1), ring(0, 1.2, -1), ring(2, 0.8, -1)], { capStart: true, capEnd: true }), [0, 0, 0]);
if (lf) process.exit(1);
