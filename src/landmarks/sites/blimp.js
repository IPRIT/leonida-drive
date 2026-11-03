import * as THREE from 'three';
import { Builder, K, LOD, obb } from '../kit.js';
import { L } from '../lights.js';
import { signQuad, tank } from '../parts.js';
import { FONT } from '../atlas.js';
import { opsBuilding } from './airport.js';
import { terrainMax } from './runways.js';

// Blimp base on a key (source-map marker "Blimp"): a clean round concrete landing pad with a painted ring, a
// lattice mooring mast in its centre and a full-size low-poly airship (fictional "SKYCAST" livery) moored by the
// nose, swaying gently about the mast (own mesh, matrix updated per frame near it). The support buildings around
// the pad are rebuilt as airfield service buildings (shed, ops block with a tank); generic footprints the source
// drawing left on the pad are removed and the ragged paved blob is trimmed to the circle.

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _e = new THREE.Euler();

export function blimpBase(ctx, def) {
  const { b, lights, sign, atlas, game } = ctx;
  const T = ctx.terrain, G = T.G;
  // ---------- the pad: the round paved patch around the marker ----------
  let cx = def.x, cz = def.z, r = def.r || 70;
  if (T.ground && G) {
    const ts = T.ts, seen = new Set(), queue = [];
    const key = (i, j) => j * T.tw + i;
    const i0 = Math.floor((def.x - T.x0) / ts), j0 = Math.floor((def.z - T.z0) / ts);
    // start at the nearest paved texel within 40 m of the marker
    let start = null;
    for (let d = 0; d <= 10 && !start; d++) for (let dj = -d; dj <= d && !start; dj++) for (let di = -d; di <= d; di++) {
      if (T.ground[key(i0 + di, j0 + dj)] === G.paved) { start = [i0 + di, j0 + dj]; break; }
    }
    if (start) {
      queue.push(start); seen.add(key(...start));
      let sx = 0, sz = 0;
      while (queue.length && seen.size < 6000) {
        const [i, j] = queue.pop();
        sx += i; sz += j;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const k = key(i + di, j + dj);
          if (seen.has(k) || T.ground[k] !== G.paved) continue;
          const x = T.x0 + (i + di + 0.5) * ts, z = T.z0 + (j + dj + 0.5) * ts;
          if (Math.hypot(x - def.x, z - def.z) > 130) continue;
          seen.add(k); queue.push([i + di, j + dj]);
        }
      }
      const n = seen.size;
      if (n > 200) {
        cx = T.x0 + (sx / n + 0.5) * ts; cz = T.z0 + (sz / n + 0.5) * ts;
        r = Math.min(95, Math.max(45, Math.sqrt((n * ts * ts) / Math.PI)));
      }
    }
    // trim the ragged blob to the circle: paved texels outside the pad become grass, inside stay paved
    const R = Math.ceil((r + 40) / ts);
    const ic = Math.floor((cx - T.x0) / ts), jc = Math.floor((cz - T.z0) / ts);
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
      const k = key(ic + di, jc + dj), d = Math.hypot(di, dj) * ts;
      if (d > r + 2 && T.ground[k] === G.paved) T.ground[k] = G.grass;
      else if (d <= r - 1 && T.ground[k] !== G.water) T.ground[k] = G.paved;
    }
    ctx.L.groundDirty = true;
  }
  ctx.remove({ circle: [cx, cz, r + 3] });
  ctx.hideTrees({ circle: [cx, cz, r + 6] });
  // flat pad on top of the terrain (every grid vertex under it below the surface)
  let top = -Infinity;
  for (let a = 0; a < 12; a++) for (const f of [0, 0.5, 1]) top = Math.max(top, terrainMax(T, cx + Math.cos(a * 0.524) * r * f, cz + Math.sin(a * 0.524) * r * f, 6));
  const g = top + 0.08;
  const seg = 48, circle = (rr) => Array.from({ length: seg }, (_, i) => [cx + Math.cos((i / seg) * Math.PI * 2) * rr, cz + Math.sin((i / seg) * Math.PI * 2) * rr]);
  b.paint(0xc9c6bf, K.PLAIN);
  b.prism(circle(r), g - 0.6, g, { topPaint: [0xd6d3cc, K.PLAIN] });
  // painted marks: outer white ring, yellow inner ring, the mooring circle
  b.lod = LOD.NEAR;
  b.orient = [cx, g - 50, cz]; // faces up
  for (const [rr, w, col] of [[r - 3, 0.6, 0xf2f2ee], [r * 0.62, 0.45, 0xf2c200], [8, 0.4, 0xf2c200]]) {
    b.paint(col, K.PAINT);
    const o = circle(rr + w / 2), i = circle(rr - w / 2);
    for (let k = 0; k < seg; k++) {
      const k1 = (k + 1) % seg;
      b.quad([o[k][0], g + 0.02, o[k][1]], [o[k1][0], g + 0.02, o[k1][1]], [i[k1][0], g + 0.02, i[k1][1]], [i[k][0], g + 0.02, i[k][1]]);
    }
  }
  b.orient = null;
  b.lod = LOD.BOTH;
  ctx.colliders.cyl(cx, g - 0.6, cz, r, 0.6, def.id);
  // edge lights
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    lights.add(cx + Math.cos(a) * (r - 1), g + 0.3, cz + Math.sin(a) * (r - 1), k % 2 ? 0xffc040 : 0xffffff, 0.6, L.STEADY, 0, 2500);
  }

  // ---------- mooring mast at the centre, airship heading ESE (source drawing) ----------
  const yaw0 = def.yaw ?? Math.atan2(-0.92, 0.38); // forward (-Z) towards east-south-east
  const LEN = 62, RAD = 8.6, cy = g + RAD + 6.8; // envelope centre height (gondola ~4 m above the pad)
  const mastH = cy - g + 1.2;
  b.paint(0xd23a2a, K.METAL);
  const w0 = 2.2, w1 = 0.9;
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) b.beam(cx + sx * w0, g, cz + sz * w0, cx + sx * w1, g + mastH, cz + sz * w1, 0.3, 0.3, 0b1111);
  b.lod = LOD.NEAR;
  b.paint(0xeeeeea, K.METAL);
  for (let y = 3; y < mastH - 1; y += 3) {
    const t = y / mastH, w = w0 + (w1 - w0) * t;
    for (const [ax, az, bx, bz] of [[w, w, w, -w], [w, -w, -w, -w], [-w, -w, -w, w], [-w, w, w, w]]) b.beam(cx + ax, g + y, cz + az, cx + bx, g + y, cz + bz, 0.15, 0.15, 0b1111);
  }
  b.lod = LOD.BOTH;
  b.paint(0x5a5f64, K.METAL);
  b.box(cx - 1.4, g + mastH, cz - 1.4, cx + 1.4, g + mastH + 0.5, cz + 1.4);
  b.colBox(cx - w0, g, cz - w0, cx + w0, g + mastH, cz + w0);
  lights.obstacle(cx, g + mastH + 1.2, cz, 1.2);
  // the mast holds the nose: the envelope centre is half a length behind it
  const fx = -Math.sin(yaw0), fz = -Math.cos(yaw0);
  const bx = cx - fx * (LEN / 2 + 1.2), bz = cz - fz * (LEN / 2 + 1.2);

  // ---------- the airship (own mesh, local frame: nose -Z, centre at the origin) ----------
  const s = new Builder({ far: false });
  const prof = (t) => { // radius along the hull, t = 0 nose .. 1 tail
    const u = t < 0.35 ? 1 - ((0.35 - t) / 0.35) ** 2 : 1 - ((t - 0.35) / 0.65) ** 2.2;
    return RAD * Math.sqrt(Math.max(0.0025, u));
  };
  const NS = 18, ringN = 16;
  const ringAt = (t) => {
    const z = -LEN / 2 + t * LEN, rr = prof(t), out = [];
    for (let i = 0; i < ringN; i++) { const a = -(i / ringN) * Math.PI * 2 + Math.PI / 2; out.push([Math.cos(a) * rr, Math.sin(a) * rr, z]); }
    return out;
  };
  const ts = Array.from({ length: NS + 1 }, (_, i) => i / NS);
  // white envelope with a teal band around the middle
  const band = [0.44, 0.5];
  s.paint(0xf3f2ee, K.PLAIN);
  s.loft(ts.filter((t) => t <= band[0]).map(ringAt), { capStart: true });
  s.paint(0x14a39a, K.PLAIN);
  s.loft([ringAt(band[0]), ringAt(band[1])]);
  s.paint(0xf3f2ee, K.PLAIN);
  s.loft([band[1], ...ts.filter((t) => t > band[1])].map(ringAt), { capEnd: true });
  // nose cap (mooring cone)
  s.paint(0x3a3d41, K.METAL);
  s.loft([ringAt(0.004).map(([x, y, z]) => [x * 1.4, y * 1.4, z]), ringAt(0.0).map(([x, y]) => [x * 0.2, y * 0.2, -LEN / 2 - 0.9])], { capEnd: true });
  // three tail fins (inverted Y): slabs in the radial / z plane
  s.paint(0xf3f2ee, K.PLAIN);
  for (const a of [0, (2 * Math.PI) / 3, (-2 * Math.PI) / 3]) {
    s.push(); s.rotZ(a); s.rotZ(Math.PI / 2);
    const zt = LEN / 2;
    s.prism([[prof(0.82) * 0.92, zt - 15], [prof(0.82) + 7.5, zt - 7], [prof(0.95) + 7, zt - 1], [prof(0.97) * 0.9, zt - 2]], -0.3, 0.3);
    s.paint(0x14a39a, K.PLAIN);
    s.prism([[prof(0.95) + 4.5, zt - 4], [prof(0.95) + 7, zt - 1.2], [prof(0.95) + 7, zt - 0.6], [prof(0.95) + 4.5, zt - 2.5]], -0.32, 0.32);
    s.paint(0xf3f2ee, K.PLAIN);
    s.pop();
  }
  // gondola with windows, two ducted engines
  const gy = -RAD - 0.2;
  s.paint(0xe6e6e2, K.PLAIN);
  s.box(-1.5, gy - 2.6, -LEN * 0.18, 1.5, gy, -LEN * 0.18 + 9);
  s.paint(0x24323e, K.GLASS, 1);
  s.box(-1.52, gy - 1.9, -LEN * 0.18 + 0.4, 1.52, gy - 0.9, -LEN * 0.18 + 6.5, 0b110011);
  s.paint(0x2a2c30, K.METAL);
  for (const sx of [-1, 1]) {
    s.beam(sx * 1.5, gy - 1.3, -LEN * 0.18 + 6.6, sx * 3.8, gy - 1.3, -LEN * 0.18 + 6.6, 0.25, 0.25, 0b1111);
    s.push(); s.translate(sx * 4.4, gy - 1.3, -LEN * 0.18 + 6.6); s.rotX(Math.PI / 2);
    s.cyl(0, 0, -0.9, 0.9, 1.0, 1.0, 10, { top: true, bottom: true });
    s.pop();
  }
  // name on both flanks (fictional)
  const nameCell = atlas.text('blimp-name', def.sign || 'SKYCAST', { w: 512, h: 96, font: FONT.block, fg: '#14a39a', bg: '#f3f2ee' });
  const blimpSign = new Builder({ uv: true, far: false });
  for (const sx of [1, -1]) {
    blimpSign.push(); blimpSign.rotY(sx > 0 ? Math.PI / 2 : -Math.PI / 2);
    signQuad(blimpSign, nameCell, -LEN * 0.22, -1.6, LEN * 0.22, 2.6, RAD * 0.985, { lit: 1 });
    blimpSign.pop();
  }
  const geo = s.near.geometry(), signGeo = blimpSign.near.geometry();
  // static envelope collider at the rest heading (the sway is a few metres at the tail)
  ctx.colliders.box(bx, cy, bz, RAD * 0.8, RAD * 0.8, LEN * 0.42, yaw0, def.id);
  const time = game.uniforms.uTime;
  ctx.dynamic({
    draws: 2,
    init(Lm, root) {
      this.mesh = new THREE.Mesh(geo, Lm.mat.solid);
      this.sign = signGeo ? new THREE.Mesh(signGeo, Lm.mat.sign) : null;
      for (const m of [this.mesh, this.sign]) {
        if (!m) continue;
        m.matrixAutoUpdate = false; m.castShadow = true; m.receiveShadow = true; m.name = 'lmk-blimp';
        root.add(m);
      }
      this.set();
    },
    // gentle weathervane sway about the mast, a slow pitch breathing
    set() {
      const t = time.value;
      const yaw = yaw0 + 0.07 * Math.sin(t * 0.17) + 0.03 * Math.sin(t * 0.43 + 1.3);
      const fxx = -Math.sin(yaw), fzz = -Math.cos(yaw);
      _p.set(cx - fxx * (LEN / 2 + 1.2), cy + 0.25 * Math.sin(t * 0.31), cz - fzz * (LEN / 2 + 1.2));
      _q.setFromEuler(_e.set(0.012 * Math.sin(t * 0.29), yaw, 0.01 * Math.sin(t * 0.23), 'YXZ'));
      _m.compose(_p, _q, _s);
      this.mesh.matrix.copy(_m); this.mesh.matrixWorldNeedsUpdate = true;
      if (this.sign) { this.sign.matrix.copy(_m); this.sign.matrixWorldNeedsUpdate = true; }
    },
    update(dt, cam) {
      const d = Math.hypot(cam.position.x - cx, cam.position.z - cz);
      const vis = d < 6000;
      this.mesh.visible = vis;
      if (this.sign) this.sign.visible = vis && d < 1500;
      if (vis && d < 2500) this.set();
    },
  });

  // ---------- support buildings around the pad: rebuilt as service buildings ----------
  let k = 0;
  for (const f of ctx.footprints(cx, cz, r + 140, 15)) {
    const ob = obb(f.poly);
    if (!ob || Math.hypot(ob.cx - cx, ob.cz - cz) < r + 2) continue;
    ctx.remove({ ids: [f.id] });
    opsBuilding(ctx, f.poly, ob.len > 40 ? 9 : 6, ob.len > 40);
    if (k++ === 0 && ob.len > 14) {
      // the round tank at the ops block's corner (source drawing)
      const c = Math.cos(ob.yaw), sn = Math.sin(ob.yaw);
      const tx = ob.cx + c * (ob.len / 2 + 4.5) + sn * 0, tz = ob.cz - sn * (ob.len / 2 + 4.5);
      if (ctx.dryDisc(tx, tz, 4)) tank(b, tx, tz, ctx.groundY(tx, tz) - 0.3, 3.4, 7, { band: 0x14a39a });
    }
  }
  ctx.L.mapExtras.push({ kind: 'blimp-pad', center: [cx, cz], radius: r }, { kind: 'blimp', x: bx, z: bz, yaw: yaw0, length: LEN, diameter: RAD * 2, mast: [cx, cz] });
  ctx.view([cx + 150, g + 60, cz + 110], [cx, g + 12, cz], 'blimp base');
  ctx.view([cx - fx * 20 + 60, g + 14, cz - fz * 20 - 40], [bx, cy - 4, bz], 'blimp');
  return { pad: [cx, cz, r] };
}
