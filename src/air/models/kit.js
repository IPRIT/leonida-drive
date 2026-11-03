// Low-poly modelling kit for aircraft & boats: per-material geometry builder (merged meshes), lofted hulls,
// shared materials, rotor/prop blur discs, nav lights. Model space: x right, y up, -z forward (physics frame).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _m = new THREE.Matrix4();
const _e = new THREE.Euler();

function flat(g) {
  const geo = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'uv') geo.deleteAttribute(k);
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((geo.attributes.position.count) * 2), 2));
  geo.computeVertexNormals();
  return geo;
}

/** Collects geometry per material key; build() returns a Group with one merged mesh per material. */
export class Builder {
  constructor() { this.parts = new Map(); }

  add(mat, geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
    if (rx || ry || rz) geo.applyMatrix4(_m.makeRotationFromEuler(_e.set(rx, ry, rz)));
    if (x || y || z) geo.translate(x, y, z);
    let l = this.parts.get(mat);
    if (!l) this.parts.set(mat, (l = []));
    l.push(flat(geo));
    return this;
  }

  box(mat, w, h, d, x, y, z, rx, ry, rz) { return this.add(mat, new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz); }

  /** Cylinder along an axis ('x' | 'y' | 'z'). */
  cyl(mat, r1, r2, h, seg, x, y, z, axis = 'y', rx = 0, ry = 0, rz = 0) {
    const g = new THREE.CylinderGeometry(r1, r2, h, seg, 1);
    if (axis === 'x') g.rotateZ(-Math.PI / 2);
    else if (axis === 'z') g.rotateX(-Math.PI / 2); // +y end → -z (forward)
    return this.add(mat, g, x, y, z, rx, ry, rz);
  }

  sphere(mat, r, x, y, z, sx = 1, sy = 1, sz = 1, ws = 8, hs = 5) {
    const g = new THREE.SphereGeometry(r, ws, hs);
    g.scale(sx, sy, sz);
    return this.add(mat, g, x, y, z);
  }

  /** Extrude a side profile [[z, y], ...] across width (centred on x). */
  profile(mat, pts, width, x = 0, bevel = 0.04) {
    const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
    const depth = Math.max(0.01, width - 2 * bevel);
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 1, curveSegments: 1 });
    g.rotateY(-Math.PI / 2);
    g.translate(depth / 2 + x, 0, 0);
    return this.add(mat, g);
  }

  /** Flat plan-form plate (wing, stabiliser) from [[x, z], ...] outline, thickness t, at height y. */
  plate(mat, pts, t, y = 0, rz = 0) {
    const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 1 });
    g.rotateX(-Math.PI / 2);
    g.translate(0, -t / 2, 0);
    if (rz) g.rotateZ(rz); // dihedral about the root (x = 0)
    g.translate(0, y, 0);
    return this.add(mat, g);
  }

  /** Mirrored pair of plates (left = mirrored x). */
  plates(mat, pts, t, y = 0, dihedral = 0) {
    this.plate(mat, pts, t, y, dihedral);
    this.plate(mat, pts.map(([x, z]) => [-x, z]).reverse(), t, y, -dihedral);
    return this;
  }

  /**
   * Loft a closed tube through cross sections { z, y, w (half width), h (half height), b (bottom half height, optional),
   * k (corner chamfer 0..1) }. Octagonal sections give the flat-shaded low-poly look.
   */
  loft(mat, secs, { capStart = true, capEnd = true, n = 8 } = {}) {
    const ring = (s) => {
      const out = [];
      const k = s.k ?? 0.42;
      const b = s.b ?? s.h;
      // octagon (chamfered rectangle), starting at the top centre, clockwise seen from the front
      const pts = [[0, 1], [1 - k, 1], [1, 1 - k], [1, -(1 - k)], [1 - k, -1], [0, -1], [-(1 - k), -1], [-1, -(1 - k)], [-1, 1 - k], [-(1 - k), 1]];
      const use = n === 8 ? [pts[1], pts[2], pts[3], pts[4], pts[6], pts[7], pts[8], pts[9]] : pts.slice(1).concat([pts[0]]);
      for (const [px, py] of use) out.push([px * s.w, s.y + (py >= 0 ? py * s.h : py * b), s.z]);
      return out;
    };
    const rings = secs.map(ring);
    const pos = [];
    const tri = (a, b, c) => pos.push(...a, ...b, ...c);
    for (let i = 0; i < rings.length - 1; i++) {
      const A = rings[i], B = rings[i + 1];
      const m = A.length;
      for (let j = 0; j < m; j++) {
        const j1 = (j + 1) % m;
        // sections run from nose (-z) to tail (+z)
        tri(A[j], A[j1], B[j]);
        tri(A[j1], B[j1], B[j]);
      }
    }
    const cap = (R, flip) => {
      const c = R.reduce((s, p) => [s[0] + p[0] / R.length, s[1] + p[1] / R.length, s[2] + p[2] / R.length], [0, 0, 0]);
      for (let j = 0; j < R.length; j++) {
        const j1 = (j + 1) % R.length;
        if (flip) tri(c, R[j1], R[j]); else tri(c, R[j], R[j1]);
      }
    };
    if (capStart) cap(rings[0], true);
    if (capEnd) cap(rings[rings.length - 1], false);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    // fix winding if the loft came out inside-out (normals pointing to the axis)
    g.computeVertexNormals();
    const p = g.attributes.position, nrm = g.attributes.normal;
    let out = 0;
    for (let i = 0; i < p.count; i += 3) out += (p.getX(i) * nrm.getX(i) + (p.getY(i) - secs[0].y) * nrm.getY(i)) > 0 ? 1 : -1;
    if (out < 0) {
      const a = p.array;
      for (let i = 0; i < a.length; i += 9) for (let k = 0; k < 3; k++) { const t = a[i + 3 + k]; a[i + 3 + k] = a[i + 6 + k]; a[i + 6 + k] = t; }
    }
    return this.add(mat, g);
  }

  build(mats, { castShadow = true, receiveShadow = false } = {}) {
    const group = new THREE.Group();
    for (const [key, list] of this.parts) {
      const geo = mergeGeometries(list, false);
      const mat = typeof key === 'string' ? mats[key] : key;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = castShadow && !mat.transparent;
      mesh.receiveShadow = receiveShadow;
      mesh.name = typeof key === 'string' ? key : mat.name;
      group.add(mesh);
    }
    return group;
  }
}

// ---------------- materials ----------------
export function makeMaterials(color = 0xffffff, color2 = 0x1d2433) {
  const std = (o) => new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.6, metalness: 0.05, ...o });
  return {
    paint: std({ color, roughness: 0.42, metalness: 0.15, name: 'paint' }),
    paint2: std({ color: color2, roughness: 0.45, metalness: 0.12, name: 'paint2' }),
    white: std({ color: 0xf1f1ee, roughness: 0.5, name: 'white' }),
    dark: std({ color: 0x1b1d22, roughness: 0.8, name: 'dark' }),
    rubber: std({ color: 0x111215, roughness: 0.95, name: 'rubber' }),
    metal: std({ color: 0x9aa1aa, roughness: 0.35, metalness: 0.7, name: 'metal' }),
    chrome: std({ color: 0xd8dde3, roughness: 0.18, metalness: 0.95, name: 'chrome' }),
    glass: std({ color: 0x1b2c3c, roughness: 0.08, metalness: 0.4, emissive: 0x0a1018, name: 'glass' }),
    seat: std({ color: 0x3a2d28, roughness: 0.9, name: 'seat' }),
    wood: std({ color: 0xa8784a, roughness: 0.75, name: 'wood' }),
    canvas: std({ color: 0xe8e2d0, roughness: 0.9, name: 'canvas' }),
    navRed: std({ color: 0x400000, emissive: 0xff1a1a, emissiveIntensity: 2, name: 'navRed' }),
    navGreen: std({ color: 0x003000, emissive: 0x19ff4a, emissiveIntensity: 2, name: 'navGreen' }),
    strobe: std({ color: 0x777777, emissive: 0xffffff, emissiveIntensity: 0, name: 'strobe' }),
    beacon: std({ color: 0x400000, emissive: 0xff2200, emissiveIntensity: 0, name: 'beacon' }),
    lamp: std({ color: 0xccccbb, emissive: 0xfff4d8, emissiveIntensity: 0.2, name: 'lamp' }),
    sirenRed: std({ color: 0x500000, emissive: 0xff0022, emissiveIntensity: 0.05, name: 'sirenRed' }),
    sirenBlue: std({ color: 0x000050, emissive: 0x1a4dff, emissiveIntensity: 0.05, name: 'sirenBlue' }),
  };
}

// ---------------- blur disc (rotor / propeller) ----------------
let _discTex = null;
function discTexture() {
  if (_discTex) return _discTex;
  const N = 128;
  const data = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) / N * 2 - 1, y = (j + 0.5) / N * 2 - 1;
      const r = Math.hypot(x, y);
      const a = Math.atan2(y, x);
      let al = 0;
      if (r < 1) {
        const tip = r > 0.92 ? 1.25 : 1;
        const streak = 0.8 + 0.2 * Math.cos(a * 2) ** 8;
        al = (0.2 + 0.55 * r) * tip * streak * (r < 0.12 ? 0.3 : 1);
        if (r > 0.97) al *= (1 - r) / 0.03;
      }
      const k = (j * N + i) * 4;
      data[k] = data[k + 1] = data[k + 2] = r > 0.92 ? 200 : 90;
      data[k + 3] = Math.min(255, al * 200);
    }
  }
  _discTex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  _discTex.needsUpdate = true;
  _discTex.magFilter = THREE.LinearFilter;
  _discTex.minFilter = THREE.LinearMipmapLinearFilter;
  _discTex.generateMipmaps = true;
  return _discTex;
}

/** Translucent motion-blur disc in the XZ plane (rotor) or XY plane (prop, axis 'z'). */
export function blurDisc(radius, axis = 'y', tint = 0x8a9098) {
  const mat = new THREE.MeshBasicMaterial({ map: discTexture(), color: tint, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  mat.userData.tint = new THREE.Color(tint);
  const g = new THREE.CircleGeometry(radius, 28);
  if (axis === 'y') g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.renderOrder = 2;
  m.castShadow = false;
  m.name = 'blurDisc';
  return m;
}

/** Unlit blur discs must follow the ambient light level (dark at night). */
export function shadeDisc(disc, night) {
  disc.material.color.copy(disc.material.userData.tint).multiplyScalar(1 - night * 0.82);
}

/** Simple rotor: n blades of length r (in the XZ plane), chord c. Returns { group, blades }. */
export function rotorBlades(mats, r, n, chord, { hubR = 0.18, droop = 0.04, mat = 'dark' } = {}) {
  const b = new Builder();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const g = new THREE.BoxGeometry(r - hubR, 0.04, chord);
    g.translate((r + hubR) / 2, 0, 0);
    g.applyMatrix4(_m.makeRotationZ(-droop));
    g.applyMatrix4(_m.makeRotationY(a));
    b.add(mat, g);
  }
  b.cyl('metal', hubR, hubR * 1.2, 0.25, 8, 0, 0, 0);
  const group = b.build(mats);
  return group;
}

/** Propeller in the XY plane (spins about z). */
export function propBlades(mats, r, n, chord, mat = 'dark') {
  const b = new Builder();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const g = new THREE.BoxGeometry(chord, r * 0.92, 0.035);
    g.translate(0, r * 0.5, 0);
    g.applyMatrix4(_m.makeRotationY(0.35));
    g.applyMatrix4(_m.makeRotationZ(a));
    b.add(mat, g);
  }
  b.cyl('metal', r * 0.14, r * 0.07, r * 0.32, 8, 0, 0, -r * 0.1, 'z');
  return b.build(mats);
}

/** Small emissive light marker. */
export function navLight(mat, x, y, z, s = 0.09) {
  const m = new THREE.Mesh(new THREE.OctahedronGeometry(s, 0), mat);
  m.position.set(x, y, z);
  m.castShadow = false;
  return m;
}

/** Wheel (axis x) with a tyre and hub, returned as a Group centred at the axle. */
export function wheelMesh(mats, r, w) {
  const b = new Builder();
  b.cyl('rubber', r, r, w, 12, 0, 0, 0, 'x');
  b.cyl('metal', r * 0.55, r * 0.55, w * 1.05, 8, 0, 0, 0, 'x');
  return b.build(mats);
}

/** Additive light-cone mesh pointing down -z from its origin (for searchlights / landing lights). */
export function lightCone(length, radius, color = 0xfff2cc) {
  const g = new THREE.ConeGeometry(radius, length, 20, 1, true);
  g.translate(0, -length / 2, 0);
  g.rotateX(Math.PI / 2); // tip at origin, opening towards -z
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(color) }, uStrength: { value: 0 }, uLen: { value: length } },
    vertexShader: 'varying float vD; varying vec3 vN; varying vec3 vV; void main(){ vD = -position.z; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform vec3 uColor; uniform float uStrength; uniform float uLen; varying float vD; varying vec3 vN; varying vec3 vV; void main(){ float f = 1.0 - clamp(vD / uLen, 0.0, 1.0); float edge = pow(abs(dot(vN, vV)), 1.5); gl_FragColor = vec4(uColor * uStrength * f * f * (0.25 + 0.75 * edge), 1.0); }',
  });
  const m = new THREE.Mesh(g, mat);
  m.renderOrder = 3;
  m.castShadow = false;
  m.frustumCulled = false;
  return m;
}
