// Shadow proxy: the rigid, shadow-casting parts of a vehicle merged into ONE shadow-only mesh.
//
// A player-class car is ~30 shadow casters (body panels split per damage part × material), drawn once per sun cascade:
// ~60 depth draw calls for one car, ~100 for an aircraft. While those parts sit exactly where they were when the proxy
// was built, a single merged mesh casts the very same shadow (same triangles, same transforms, same cull side) for 1-2
// draws per cascade. The proxy lives on SHADOW_LAYER: the sun's shadow cameras render it, the main camera never does.
//
// Exactness: before every frame is drawn (Renderer.beforeRender) each proxied part's transform chain (position,
// rotation, scale, visibility up to the root) and its vertex buffer version are compared with the values the proxy was
// built from. Any difference (a door opening, a dent, a panel coming loose, a part detached) switches the proxy off
// and the original parts cast again in that same frame; when everything is back (door closed), the proxy returns.
// Parts that keep changing (propellers, rotors, gear, dented panels) are dropped from the proxy and cast by themselves.
import * as THREE from 'three';

export const SHADOW_LAYER = 30;

const _inv = new THREE.Matrix4();
const _rel = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const OBSERVE = 12; // frames of observation before the first build (animated parts show up as moving)
const REBUILD_OFF = 120; // frames the proxy has been off because of moving parts → rebuild without them
const DYNAMIC_CHANGES = 6; // a node that changed this many times since the last build counts as animated

/** Let the sun's shadow cameras see SHADOW_LAYER (on top of the default layer). */
export function enableShadowLayer(lights) {
  for (const l of lights) l?.shadow?.camera?.layers?.enable(SHADOW_LAYER);
}

function snap(o, out) {
  out[0] = o.position.x; out[1] = o.position.y; out[2] = o.position.z;
  out[3] = o.quaternion.x; out[4] = o.quaternion.y; out[5] = o.quaternion.z; out[6] = o.quaternion.w;
  out[7] = o.scale.x; out[8] = o.scale.y; out[9] = o.scale.z; out[10] = o.visible ? 1 : 0;
  return out;
}

function same(o, s) {
  return o.position.x === s[0] && o.position.y === s[1] && o.position.z === s[2]
    && o.quaternion.x === s[3] && o.quaternion.y === s[4] && o.quaternion.z === s[5] && o.quaternion.w === s[6]
    && o.scale.x === s[7] && o.scale.y === s[8] && o.scale.z === s[9] && (o.visible ? 1 : 0) === s[10];
}

function proxyable(m) {
  if (!m.isMesh || m.isInstancedMesh || m.isSkinnedMesh || !m.castShadow || m.customDepthMaterial || m.customDistanceMaterial) return false;
  const mat = m.material;
  if (!mat || Array.isArray(mat) || mat.visible === false) return false;
  if (mat.alphaTest > 0 || mat.alphaMap || mat.displacementMap || mat.alphaToCoverage || mat.clippingPlanes?.length) return false;
  const geo = m.geometry;
  if (!geo?.attributes?.position || geo.morphAttributes?.position?.length) return false;
  return true;
}

export class ShadowProxy {
  /**
   * @param {THREE.Object3D} root rigid frame the proxy is attached to (car body, aircraft root)
   * @param {{exclude?: THREE.Object3D[], ready?: () => boolean}} [o] exclude: subtrees animated by design (pop-up
   *   lamps, mixer drum…); ready: wait until the model is final (the damage system refines car meshes after spawn)
   */
  constructor(root, o = {}) {
    this.root = root;
    this.ready = o.ready || null;
    this.started = false;
    this.exclude = new Set(o.exclude || []);
    this.frame = 0;
    this.nodes = new Map(); // node -> { s: snapshot, changes, lastChange }
    this.cands = []; // { mesh, geo, ver, chain: node[], cast }
    this.items = []; // proxied candidates
    this.meshes = []; // proxy meshes (one per shadow side)
    this.on = false;
    this.offFrames = 0;
    this.dead = new Set(); // meshes never proxied again (deformed, re-parented, swapped geometry)
  }

  _collect() {
    const walk = (o, chain) => {
      if (this.exclude.has(o)) return;
      const c = o === this.root ? chain : [...chain, o];
      if (o !== this.root && proxyable(o)) this.cands.push({ mesh: o, geo: o.geometry, ver: o.geometry.attributes.position.version, chain: c, cast: true });
      for (const ch of o.children) walk(ch, c);
    };
    walk(this.root, []);
    for (const cd of this.cands) for (const n of cd.chain) if (!this.nodes.has(n)) this.nodes.set(n, { s: snap(n, new Array(11)), b: new Array(11), changes: 0, last: -1e9 });
  }

  // a proxied part still sits exactly as built: same parent chain, same local transforms, same vertex data
  _valid(cd) {
    const m = cd.mesh;
    if (m.geometry !== cd.geo || cd.geo.attributes.position.version !== cd.ver) { this.dead.add(m); return false; }
    for (let i = 0; i < cd.chain.length; i++) {
      const n = cd.chain[i];
      if (n.parent !== (i === 0 ? this.root : cd.chain[i - 1])) { this.dead.add(m); return false; }
      if (!same(n, this.nodes.get(n).b)) return false;
    }
    return true;
  }

  // per node: count changes (rolling snapshot), so parts that keep moving are left out of the next build
  _scan() {
    for (const [n, rec] of this.nodes) {
      if (same(n, rec.s)) continue;
      snap(n, rec.s);
      rec.changes++;
      rec.last = this.frame;
    }
  }

  _setCasting(on) {
    if (on === this.on) return;
    this.on = on;
    for (const cd of this.items) cd.mesh.castShadow = on ? false : cd.cast;
    for (const pm of this.meshes) pm.visible = on;
  }

  _dispose() {
    for (const pm of this.meshes) { pm.removeFromParent(); pm.geometry.dispose(); pm.material.dispose(); }
    this.meshes.length = 0;
  }

  _build() {
    this._setCasting(false);
    this._dispose();
    this.items.length = 0;
    this.root.updateMatrixWorld(true);
    _inv.copy(this.root.matrixWorld).invert();
    const bySide = new Map();
    for (const cd of this.cands) {
      const m = cd.mesh;
      if (m.geometry !== cd.geo || cd.geo.attributes.position.version !== cd.ver) this.dead.add(m);
      if (this.dead.has(m) || !m.castShadow) continue;
      if (cd.chain.some((n) => { const r = this.nodes.get(n); return r.changes >= DYNAMIC_CHANGES || this.frame - r.last < 2 || !n.visible; })) continue;
      if (cd.chain.some((n, i) => n.parent !== (i === 0 ? this.root : cd.chain[i - 1]))) { this.dead.add(m); continue; }
      const mat = m.material;
      const side = mat.shadowSide ?? mat.side;
      let l = bySide.get(side);
      if (!l) bySide.set(side, (l = []));
      l.push(cd);
    }
    for (const [side, list] of bySide) {
      if (list.length < 2) continue; // nothing to merge
      let n = 0;
      for (const cd of list) n += cd.geo.index ? cd.geo.index.count : cd.geo.attributes.position.count;
      const pos = new Float32Array(n * 3);
      // normals: the depth pass does not read them, but their presence is part of the shader program key
      // (vertexNormals); without them the proxy would compile a depth program of its own mid-game
      const nrm = new Float32Array(n * 3);
      let k = 0;
      for (const cd of list) {
        _rel.multiplyMatrices(_inv, cd.mesh.matrixWorld);
        _nm.getNormalMatrix(_rel);
        const p = cd.geo.attributes.position, pn = cd.geo.attributes.normal, idx = cd.geo.index;
        const cnt = idx ? idx.count : p.count;
        for (let i = 0; i < cnt; i++) {
          const vi = idx ? idx.getX(i) : i;
          _v.fromBufferAttribute(p, vi).applyMatrix4(_rel);
          if (pn) { _n.fromBufferAttribute(pn, vi).applyMatrix3(_nm).normalize(); nrm[k] = _n.x; nrm[k + 1] = _n.y; nrm[k + 2] = _n.z; }
          pos[k++] = _v.x; pos[k++] = _v.y; pos[k++] = _v.z;
        }
        cd.cast = true;
        this.items.push(cd);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      g.computeBoundingSphere();
      const pm = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side, colorWrite: false, depthWrite: false }));
      pm.name = 'shadowProxy';
      pm.layers.set(SHADOW_LAYER);
      pm.castShadow = true;
      pm.receiveShadow = false;
      pm.visible = false;
      pm.userData.shadowProxy = true;
      this.root.add(pm);
      pm.updateMatrixWorld(true);
      this.meshes.push(pm);
    }
    for (const [n, r] of this.nodes) { r.changes = 0; snap(n, r.b); }
    this.offFrames = 0;
  }

  /** Call right before the frame is drawn. */
  update() {
    if (!this.started) {
      if (this.ready && !this.ready()) return;
      this.started = true;
      this._collect();
    }
    this.frame++;
    this._scan();
    if (this.frame === OBSERVE) this._build();
    if (this.frame < OBSERVE || !this.meshes.length) {
      // nothing merged (yet): retry now and then, parts may have settled (a craft landed, a door closed)
      if (this.frame > OBSERVE && this.frame % 240 === 0 && this.cands.length > 2) this._build();
      return;
    }
    let ok = true;
    for (const cd of this.items) if (!this._valid(cd)) { ok = false; break; }
    if (ok) { this._setCasting(true); this.offFrames = 0; return; }
    this._setCasting(false);
    if (++this.offFrames >= REBUILD_OFF) this._build();
  }

  dispose() {
    this._setCasting(false);
    this._dispose();
    this.items.length = 0;
    this.cands.length = 0;
    this.nodes.clear();
  }
}
