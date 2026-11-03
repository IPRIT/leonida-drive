import * as THREE from 'three';

// Light kinds for LightList.add (see lightsMaterial in materials.js)
export const L = { STEADY: 0, OBSTACLE: 1, STROBE: 2, BEACON: 3, ALWAYS: 4, SLOW: 5 };
const _c = new THREE.Color();

// Collects light points (one THREE.Points draw call for every landmark light in the world).
export class LightList {
  constructor() { this.p = []; this.c = []; this.d = []; }
  get count() { return this.p.length / 3; }
  // size = apparent diameter in metres, maxDist = fade-out distance
  add(x, y, z, hex, size = 1, kind = L.STEADY, phase = 0, maxDist = 6000) {
    _c.setHex(hex);
    this.p.push(x, y, z);
    this.c.push(_c.r, _c.g, _c.b);
    this.d.push(size, kind, phase, maxDist);
    return this;
  }
  // red obstacle light(s) on top of a structure
  obstacle(x, y, z, size = 1.6) { return this.add(x, y, z, 0xff2a1a, size, L.OBSTACLE, ((x * 0.013 + z * 0.007) % 1 + 1) % 1, 9000); }
  mesh(material) {
    if (!this.count) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aL', new THREE.Float32BufferAttribute(this.d, 4));
    g.computeBoundingSphere();
    const m = new THREE.Points(g, material);
    m.frustumCulled = false;
    m.renderOrder = 5;
    m.name = 'landmark-lights';
    return m;
  }
}

// Rotating / sweeping beams: open cones along +x from a pivot, rotated in the vertex shader.
export class BeamList {
  constructor() { this.pos = []; this.piv = []; this.bm = []; this.idx = []; this.n = 0; }
  // pivot (x,y,z), beam length, end radius, speed rad/s, phase, mode 0 rotate / 1 sweep, start radius,
  // pitch (radians, negative = aims down; searchlights), twin = also emit the opposite beam
  add(x, y, z, { length = 300, radius = 18, speed = 0.8, phase = 0, mode = 0, r0 = 0.6, pitch = 0, twin = false, seg = 6 } = {}) {
    const dirs = twin ? [0, Math.PI] : [0];
    for (const a0 of dirs) {
      const base = this.n;
      const ca = Math.cos(a0), sa = Math.sin(a0), cp = Math.cos(pitch), sp = Math.sin(pitch);
      for (let ring = 0; ring < 2; ring++) {
        const along = ring ? length : 0, r = ring ? radius : r0;
        for (let i = 0; i < seg; i++) {
          const t = (i / seg) * Math.PI * 2;
          // local frame: axis +x (pitched), circle in the y/z plane
          const ly = Math.cos(t) * r, lz = Math.sin(t) * r;
          const ax = along * cp - ly * sp, ay = along * sp + ly * cp;
          const wx = ax * ca - lz * sa, wz = ax * sa + lz * ca;
          this.pos.push(x + wx, y + ay, z + wz);
          this.piv.push(x, y, z, speed);
          this.bm.push(phase, mode, length, 0);
          this.n++;
        }
      }
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        this.idx.push(base + i, base + seg + i, base + seg + j, base + i, base + seg + j, base + j);
      }
    }
    return this;
  }
  mesh(material) {
    if (!this.n) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aPivot', new THREE.Float32BufferAttribute(this.piv, 4));
    g.setAttribute('aBeam', new THREE.Float32BufferAttribute(this.bm, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, material);
    m.frustumCulled = false;
    m.renderOrder = 6;
    m.name = 'landmark-beams';
    return m;
  }
}
