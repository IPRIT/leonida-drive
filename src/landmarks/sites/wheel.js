import * as THREE from 'three';
import { Builder, K, LOD } from '../kit.js';
import { L } from '../lights.js';
import { signQuad } from '../parts.js';
import { FONT } from '../atlas.js';

// Observation wheel on the bay front: A-frame legs, spinning rim/spokes (solid material spinner, no extra
// draw call) with rainbow LED rim lights, gondolas as one InstancedMesh that stays upright (updated per frame
// only while the wheel is within 2 km and visible).

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1);

export function wheel(ctx, def) {
  const { b, lights, sign, atlas, game } = ctx;
  const [x, z] = ctx.spot(def.x, def.z, 10, { maxR: 160, dryR: 24 });
  ctx.remove({ circle: [x, z, 34] });
  ctx.hideTrees({ circle: [x, z, 30] });
  const g = ctx.groundY(x, z) - 0.4;
  // axis points towards open water (wheel face visible from the bay and from the shore)
  let best = 0, bestH = Infinity;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    let h = 0;
    for (const r of [40, 80, 120]) h += ctx.groundY(x + Math.cos(a) * r, z + Math.sin(a) * r);
    if (h < bestH) { bestH = h; best = a; }
  }
  const ax = Math.cos(best), az = Math.sin(best);
  const R = def.r || 29, hubY = g + R + 5, N = 24, speed = def.speed || 0.035;
  const yaw = Math.atan2(-az, ax); // local +x = axis
  // legs: A-frames on both sides of the wheel
  b.push(); b.translate(x, 0, z).rotY(yaw);
  b.paint(0xeef1f3, K.METAL);
  for (const s of [-1, 1]) {
    const px = s * 4.2;
    for (const d of [-1, 1]) b.beam(px * 1.6, g, d * R * 0.62, px, hubY, 0, 1.2, 1.2, 0b1111);
    b.beam(px * 1.4, g + R * 0.4, -R * 0.38, px * 1.4, g + R * 0.4, R * 0.38, 0.6, 0.6, 0b1111);
  }
  b.paint(0x9aa3aa, K.METAL);
  b.push(); b.rotZ(Math.PI / 2); b.cyl(hubY, 0, -5, 5, 1.1, 1.1, 10, { bottom: true }); b.pop();
  // boarding platform + ticket kiosk
  b.paint(0xe9e2d4, K.PLAIN);
  b.box(-10, g, -6, 10, g + 1.2, 6);
  b.paint(0x2f6f9f, K.WIN, 3);
  b.box(8, g + 1.2, -12, 16, g + 4.4, -4);
  b.colBox(-10, g, -6, 10, g + 1.2, 6);
  b.colBox(-6.5, g, -R * 0.65, 6.5, hubY, R * 0.65);
  b.pop();
  // spinning wheel: two rims, spokes, cross bars, LED rim lights
  const si = ctx.spinner(x, hubY, z, [ax, 0, az], speed, 0);
  b.push(); b.translate(x, hubY, z).rotY(yaw);
  b.spinIdx = si;
  const seg = 32;
  const P = (s, i, r = R) => { const a = (i / seg) * Math.PI * 2; return [s, Math.sin(a) * r, Math.cos(a) * r]; };
  b.paint(0xf4f6f8, K.METAL);
  for (const s of [-1.6, 1.6]) for (let i = 0; i < seg; i++) { const p0 = P(s, i), p1 = P(s, i + 1); b.beam(...p0, ...p1, 0.7, 0.9, 0b1111); }
  b.lod = LOD.NEAR;
  for (let i = 0; i < seg; i += 2) { const p0 = P(-1.6, i), p1 = P(1.6, i); b.beam(...p0, ...p1, 0.35, 0.35, 0b1111); }
  b.paint(0xd0d6db, K.METAL);
  for (const s of [-1.6, 1.6]) for (let i = 0; i < 16; i++) { const p = P(s, i * 2); b.beam(s * 2.6, 0, 0, p[0], p[1], p[2], 0.22, 0.22, 0b1111); }
  b.lod = LOD.BOTH;
  b.paint(0xffffff, K.LED, 0);
  for (const s of [-2.1, 2.1]) for (let i = 0; i < seg; i++) { const [px, py, pz] = P(s, i + 0.5, R + 0.55); b.box(px - 0.25, py - 0.25, pz - 0.25, px + 0.25, py + 0.25, pz + 0.25); }
  b.spinIdx = -1;
  b.pop();
  lights.obstacle(x, hubY + R + 1.4, z, 1.4);
  const cell = atlas.text('wheel', 'BAYSIDE SKYWHEEL', { w: 768, h: 96, font: FONT.block, fg: '#ffffff', bg: '#d6336c' });
  sign.push(); sign.translate(x, g, z).rotY(yaw);
  signQuad(sign, cell, -8, 5, 8, 7, 6.3, { lit: 1 });
  sign.pop();
  // gondolas: instanced, upright, orbiting with the rim
  const gond = new Builder({ far: false });
  gond.paint(0xf2f2f2, K.PLAIN);
  gond.box(-1.4, -3.4, -1.4, 1.4, -0.9, 1.4, 0b111111);
  gond.paint(0x6aa6c8, K.GLASS, 1);
  gond.box(-1.45, -2.9, -1.45, 1.45, -1.4, 1.45, 0b110011);
  gond.paint(0xd6336c, K.PLAIN);
  gond.box(-1.5, -0.9, -1.5, 1.5, -0.6, 1.5, 0b111111);
  gond.paint(0x9aa3aa, K.METAL);
  gond.box(-0.1, -0.6, -0.1, 0.1, 0.2, 0.1);
  const geo = gond.near.geometry();
  const time = game.uniforms.uTime;
  ctx.dynamic({
    draws: 1,
    init(Lm, root) {
      this.mesh = new THREE.InstancedMesh(geo, Lm.mat.solid, N);
      this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.mesh.frustumCulled = false;
      this.mesh.castShadow = true;
      this.mesh.name = 'lmk-wheel-gondolas';
      root.add(this.mesh);
      this.set();
    },
    // the spinner rotates by θ = uTime * speed about the axis; in the wheel plane (up, e) with e = axis × up
    // that maps a rim angle a to a - θ, so the gondolas follow the rim exactly
    set() {
      const th = time.value * speed;
      for (let i = 0; i < N; i++) {
        const ph = (i / N) * Math.PI * 2 - th;
        const c = Math.cos(ph) * (R + 0.2), s = Math.sin(ph) * (R + 0.2);
        _p.set(x - az * c, hubY + s, z + ax * c);
        _m.compose(_p, _q.identity(), _s);
        this.mesh.setMatrixAt(i, _m);
      }
      this.mesh.instanceMatrix.needsUpdate = true;
    },
    update(dt, cam) {
      const d = Math.hypot(cam.position.x - x, cam.position.z - z);
      this.mesh.visible = d < 2500;
      if (this.mesh.visible) this.set();
    },
  });
  ctx.view([x + ax * 75 - az * 30, g + 26, z + az * 75 + ax * 30], [x, hubY, z], 'wheel');
  ctx.view([x - ax * 120, g + 12, z - az * 120], [x, hubY - 4, z], 'wheel from shore');
}
