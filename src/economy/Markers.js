// World markers for economy places: a glowing ring on the ground (short gradient wall + floor annulus) and an optional
// tall beacon beam. Two InstancedMeshes, two materials created once (additive, unlit, no real lights), per-instance
// colour; per frame only the visible instances' matrices are rewritten (≈ 0.01 ms for a dozen markers).
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _c = new THREE.Color();

// ring: open cylinder r = 1, h = 1 (bright at the bottom, fading up) + floor annulus 0.86..1
function ringGeometry(seg = 40) {
  const pos = [], col = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    pos.push(c, 0, s, c, 1, s); // wall bottom, top
    col.push(1, 1, 1, 0, 0, 0);
  }
  for (let i = 0; i < seg; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const base = pos.length / 3;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    pos.push(c, 0.02, s, c * 0.86, 0.02, s * 0.86);
    col.push(0.9, 0.9, 0.9, 0.25, 0.25, 0.25);
  }
  for (let i = 0; i < seg; i++) { const a = base + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// beam: open cylinder r = 1, h = 1, fading out towards the top
function beamGeometry(seg = 10) {
  const pos = [], col = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    pos.push(c, 0, s, c * 0.6, 1, s * 0.6);
    col.push(0.55, 0.55, 0.55, 0, 0, 0);
  }
  for (let i = 0; i < seg; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export class Markers {
  constructor(scene, max = 24) {
    this.max = max;
    this.items = [];
    const common = { vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false };
    this.ringMat = new THREE.MeshBasicMaterial({ ...common, fog: true });
    this.beamMat = new THREE.MeshBasicMaterial({ ...common, fog: false, opacity: 0.55 });
    this.ring = new THREE.InstancedMesh(ringGeometry(), this.ringMat, max);
    this.beam = new THREE.InstancedMesh(beamGeometry(), this.beamMat, max);
    for (const m of [this.ring, this.beam]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.renderOrder = 5;
      m.count = 0;
      m.name = 'economy-markers';
      // allocate instanceColor once
      for (let i = 0; i < max; i++) m.setColorAt(i, _c.setRGB(0, 0, 0));
      scene.add(m);
    }
    this.scene = scene;
  }

  /** Add a marker → index. o: { x, y, z, r = 6, color = 0xf5c84c, beam = true, height = 1.3, visible = true } */
  add(o) {
    if (this.items.length >= this.max) return -1;
    const i = this.items.length;
    this.items.push({ x: 0, y: 0, z: 0, r: 6, height: 1.3, beam: true, visible: true, phase: i * 1.7, color: 0xf5c84c, intensity: 1 });
    this.set(i, o);
    this.ring.count = this.beam.count = this.items.length;
    return i;
  }

  /** Update marker fields (position, colour, beam, visibility, intensity 0..1). */
  set(i, o) {
    const it = this.items[i];
    if (!it) return;
    Object.assign(it, o);
    _c.set(it.color).multiplyScalar(it.intensity ?? 1);
    this.ring.setColorAt(i, _c);
    this.beam.setColorAt(i, _c);
    this.ring.instanceColor.needsUpdate = true;
    this.beam.instanceColor.needsUpdate = true;
  }

  show(i, on) { const it = this.items[i]; if (it && it.visible !== on) it.visible = on; }

  /** Per frame: gentle pulse. t = game time (s). */
  update(t) {
    const n = this.items.length;
    for (let i = 0; i < n; i++) {
      const it = this.items[i];
      if (!it.visible) {
        _m.makeScale(0, 0, 0);
        this.ring.setMatrixAt(i, _m);
        this.beam.setMatrixAt(i, _m);
        continue;
      }
      const k = 1 + Math.sin(t * 2.6 + it.phase) * 0.035;
      _m.makeScale(it.r * k, it.height * (0.85 + 0.15 * k), it.r * k).setPosition(it.x, it.y + 0.03, it.z);
      this.ring.setMatrixAt(i, _m);
      if (it.beam) _m.makeScale(1.1, 150, 1.1).setPosition(it.x, it.y, it.z);
      else _m.makeScale(0, 0, 0);
      this.beam.setMatrixAt(i, _m);
    }
    this.ring.instanceMatrix.needsUpdate = true;
    this.beam.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const m of [this.ring, this.beam]) { this.scene.remove(m); m.geometry.dispose(); m.dispose?.(); }
    this.ringMat.dispose();
    this.beamMat.dispose();
  }
}
