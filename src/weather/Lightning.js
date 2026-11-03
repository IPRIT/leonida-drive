import * as THREE from 'three';

// Branching lightning bolts: midpoint-displaced polylines expanded into camera-facing ribbons on the GPU.
// HDR colour so the bloom pass turns them into glowing channels.

const VERT = /* glsl */`
  attribute vec3 aDir;
  attribute float aSide, aWidth;
  varying float vSide;
  void main() {
    vec3 toCam = normalize(cameraPosition - position);
    vec3 side = normalize(cross(aDir, toCam) + 1e-5);
    float dist = length(cameraPosition - position);
    float w = max(aWidth, dist * 0.0016);
    vSide = aSide;
    gl_Position = projectionMatrix * viewMatrix * vec4(position + side * aSide * w, 1.0);
  }
`;
const FRAG = /* glsl */`
  uniform float uAlpha;
  varying float vSide;
  void main() {
    float x = abs(vSide);
    float core = smoothstep(0.35, 0.0, x);
    float glow = (1.0 - x) * (1.0 - x);
    vec3 c = vec3(0.75, 0.82, 1.0) * glow * 6.0 + vec3(1.0) * core * 30.0;
    gl_FragColor = vec4(c * uAlpha, 0.0);
  }
`;

function displace(a, b, depth, rough, out, rnd) {
  if (depth === 0) { out.push(a, b); return; }
  const len = a.distanceTo(b);
  const m = a.clone().lerp(b, 0.4 + rnd() * 0.2);
  m.x += (rnd() - 0.5) * len * rough;
  m.z += (rnd() - 0.5) * len * rough;
  m.y += (rnd() - 0.5) * len * rough * 0.3;
  displace(a, m, depth - 1, rough, out, rnd);
  displace(m, b, depth - 1, rough, out, rnd);
}

export class Lightning {
  constructor(scene) {
    this.scene = scene;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uAlpha: { value: 0 } }, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, fog: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    // one persistent mesh (hidden until a strike) so its program is compiled by render.prewarm()
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.t = 1e9;
    this.pulses = [];
  }

  // top/ground: THREE.Vector3. Returns the flash pulse list [{t, a}] shared with the sky flash.
  strike(top, ground, rnd = Math.random) {
    const segs = [];
    displace(top, ground, 7, 0.42, segs, rnd);
    const nb = 3 + Math.floor(rnd() * 4);
    const branches = [];
    for (let i = 0; i < nb; i++) {
      const k = Math.floor(segs.length * (0.1 + rnd() * 0.55) / 2) * 2;
      const a = segs[k];
      const len = top.distanceTo(ground) * (0.15 + rnd() * 0.25);
      const b = a.clone().add(new THREE.Vector3((rnd() - 0.5) * len, -len * (0.5 + rnd() * 0.5), (rnd() - 0.5) * len));
      const s = [];
      displace(a, b, 5, 0.5, s, rnd);
      branches.push(s);
    }
    const pos = [], dir = [], side = [], width = [], idx = [];
    const add = (list, w) => {
      for (let i = 0; i < list.length; i += 2) {
        const a = list[i], b = list[i + 1];
        const d = b.clone().sub(a).normalize();
        const base = pos.length / 3;
        for (const [p, s] of [[a, -1], [a, 1], [b, 1], [b, -1]]) { pos.push(p.x, p.y, p.z); dir.push(d.x, d.y, d.z); side.push(s); width.push(w); }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    };
    add(segs, 3.2);
    for (const b of branches) add(b, 1.4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aDir', new THREE.Float32BufferAttribute(dir, 3));
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
    g.setAttribute('aWidth', new THREE.Float32BufferAttribute(width, 1));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(top.clone().lerp(ground, 0.5), 5000);
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    this.mesh.visible = true;
    this.t = 0;
    this.pulses = flashPulses(rnd);
    return this.pulses;
  }

  update(dt) {
    if (!this.mesh.visible) return;
    this.t += dt;
    this.mat.uniforms.uAlpha.value = pulseValue(this.pulses, this.t);
    if (this.t > 1.2) this.mesh.visible = false;
  }

  dispose() { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); }
}

// 2–4 quick return strokes
export function flashPulses(rnd = Math.random) {
  const n = 2 + Math.floor(rnd() * 3);
  const p = [];
  let t = 0;
  for (let i = 0; i < n; i++) { p.push({ t, a: i === 0 ? 1 : 0.5 + rnd() * 0.5 }); t += 0.05 + rnd() * 0.12; }
  return p;
}

export function pulseValue(pulses, t) {
  let v = 0;
  for (const p of pulses) {
    const d = t - p.t;
    if (d < 0) continue;
    v = Math.max(v, p.a * (d < 0.02 ? d / 0.02 : Math.exp(-(d - 0.02) * 14)));
  }
  return v;
}
