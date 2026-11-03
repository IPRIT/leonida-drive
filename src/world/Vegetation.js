import * as THREE from 'three';
import { Scatter, swayMaterial } from './Scatter.js';
import { palmGeometry, treeGeometry, pineGeometry, bushGeometry, cypressGeometry, reedGeometry, lampGeometry } from './models.js';

// veg.bin record: f32 x, f32 z, u8 type, u8 scale, u8 rot, u8 pad (12 bytes)
const TYPES = ['palm', 'tree', 'pine', 'bush', 'cypress', 'reed'];
const SOLID = { palm: 0.32, tree: 0.38, pine: 0.3, cypress: 0.5 };
// contact force (N) needed to snap a trunk
export const BREAK_FORCE = { palm: 160000, tree: 90000, pine: 110000, cypress: 140000 };

export class Vegetation {
  constructor(data, terrain, scene, quality = 1) {
    this.uniforms = { uTime: { value: 0 } };
    const geos = { palm: palmGeometry(), tree: treeGeometry(), pine: pineGeometry(), bush: bushGeometry(), cypress: cypressGeometry(), reed: reedGeometry() };
    const mats = {
      palm: swayMaterial(this.uniforms, { amp: 0.25, side: THREE.DoubleSide }),
      tree: swayMaterial(this.uniforms, { amp: 0.06 }),
      pine: swayMaterial(this.uniforms, { amp: 0.04 }),
      bush: swayMaterial(this.uniforms, { amp: 0.0 }),
      cypress: swayMaterial(this.uniforms, { amp: 0.05 }),
      reed: swayMaterial(this.uniforms, { amp: 1.6, side: THREE.DoubleSide }),
    };
    const R = 1700 * quality;
    const cfg = {
      palm: { capacity: 30000, radius: R * 1.1 }, tree: { capacity: 40000, radius: R },
      pine: { capacity: 40000, radius: R }, bush: { capacity: 25000, radius: R * 0.5, castShadow: false },
      cypress: { capacity: 12000, radius: R }, reed: { capacity: 12000, radius: R * 0.35, castShadow: false },
    };
    this.scatters = {};
    for (const t of TYPES) this.scatters[t] = new Scatter(scene, geos[t], mats[t], cfg[t]);
    const dv = new DataView(data.veg);
    const n = data.veg.byteLength / 12;
    const tint = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const o = i * 12;
      const x = dv.getFloat32(o, true), z = dv.getFloat32(o + 4, true);
      const type = TYPES[dv.getUint8(o + 8)];
      const s = dv.getUint8(o + 9) / 255, r = (dv.getUint8(o + 10) / 255) * Math.PI * 2;
      const y = terrain.heightAt(x, z);
      if (y < 0.15 && type !== 'reed' && type !== 'cypress') continue;
      let sc = 0.75 + s * 0.6;
      if (type === 'palm') sc = 0.85 + s * 0.45;
      if (type === 'bush') sc = 0.6 + s * 0.9;
      const hue = 0.92 + ((i * 7919) % 100) / 100 * 0.18;
      tint.setRGB(hue, 0.95 + ((i * 104729) % 100) / 1000, hue * 0.95);
      this.scatters[type].add(x, y - 0.1, z, r, sc, tint.getHex());
    }
    for (const t of TYPES) this.scatters[t].finalize();
    this.colliders = new Map();
    this.fallen = [];
    this.bakeCanopy(terrain);
  }

  // Far forests (Terrain uCanopy): crown cover per 16 m cell from every instance, softened over 3x3 cells. Trees are
  // drawn one by one up to ~1.7 km; past that the ground takes their colour instead of turning bald.
  bakeCanopy(terrain) {
    if (!terrain?.setCanopy) return;
    const CELL = 16;
    const w = Math.ceil((terrain.x1 - terrain.x0) / CELL), h = Math.ceil((terrain.z1 - terrain.z0) / CELL);
    const acc = new Float32Array(w * h);
    const crown = { palm: 22, tree: 34, pine: 26, bush: 7, cypress: 12, reed: 2 }; // m² of cover
    for (const t of TYPES) {
      const sc = this.scatters[t], r = sc.raw, a = crown[t] / (CELL * CELL);
      for (let i = 0; i < sc.count; i++) {
        if (sc.hidden.has(i)) continue;
        const cx = Math.floor((r[i * 6] - terrain.x0) / CELL), cz = Math.floor((r[i * 6 + 2] - terrain.z0) / CELL);
        if (cx >= 0 && cz >= 0 && cx < w && cz < h) acc[cz * w + cx] += a * r[i * 6 + 4] * r[i * 6 + 4];
      }
    }
    const out = new Uint8Array(w * h);
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, zz = z + dz;
          if (xx < 0 || zz < 0 || xx >= w || zz >= h) continue;
          const k = dx === 0 && dz === 0 ? 2 : 1;
          s += acc[zz * w + xx] * k; n += k;
        }
        out[z * w + x] = Math.round(255 * (1 - Math.exp(-1.6 * s / n)));
      }
    }
    terrain.setCanopy(out, w, h, CELL);
  }

  update(camera, dt) {
    this.uniforms.uTime.value += dt;
    for (const t of TYPES) this.scatters[t].update(camera, dt);
    this.syncFallen(dt);
  }

  // static trunk colliders near a point (streamed); they report contact forces so impacts can snap them
  updateColliders(RAPIER, world, x, z, radius, groups) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.groupsProp = groups;
    const need = new Set();
    for (const t of Object.keys(SOLID)) {
      const sc = this.scatters[t];
      for (const id of sc.near(x, z, radius)) {
        if (sc.hidden.has(id)) continue;
        const key = t + id;
        need.add(key);
        if (this.colliders.has(key)) continue;
        const r = sc.raw;
        const s = r[id * 6 + 4];
        const h = (t === 'palm' ? 9 : 4) * s;
        const desc = RAPIER.ColliderDesc.cylinder(h / 2, SOLID[t] * s)
          .setTranslation(r[id * 6], r[id * 6 + 1] + h / 2, r[id * 6 + 2]).setFriction(0.5)
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(5000); // the damage system accumulates impulses
        if (groups !== undefined) desc.setCollisionGroups(groups);
        const c = world.createCollider(desc);
        c.userData = { tree: t, id };
        this.colliders.set(key, c);
      }
    }
    for (const [key, c] of this.colliders) if (!need.has(key)) { world.removeCollider(c, false); this.colliders.delete(key); }
  }

  query(x, z, r) {
    const out = [];
    for (const t of TYPES) for (const id of this.scatters[t].near(x, z, r)) if (!this.scatters[t].hidden.has(id)) out.push({ type: t, id });
    return out;
  }

  // snap a tree at the base: hide the instance, drop a dynamic trunk that falls in `dir`
  breakTree(type, id, dir = { x: 1, z: 0 }, strength = 1) {
    const sc = this.scatters[type];
    if (!sc || sc.hidden.has(id) || !this.world) return false;
    const { RAPIER, world } = this;
    const key = type + id;
    const c = this.colliders.get(key);
    if (c) { world.removeCollider(c, false); this.colliders.delete(key); }
    sc.hidden.add(id);
    sc._timer = 0; // force refresh
    const r = sc.raw;
    const x = r[id * 6], y = r[id * 6 + 1], z = r[id * 6 + 2], rot = r[id * 6 + 3], s = r[id * 6 + 4];
    const tall = (type === 'palm' ? 9 : type === 'pine' ? 10 : type === 'cypress' ? 11 : 5) * s;
    if (type === 'bush' || type === 'reed') return true; // just flattened
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y + tall / 2, z)
      .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot))
      .setLinearDamping(0.2).setAngularDamping(0.4));
    const cd = RAPIER.ColliderDesc.cuboid(SOLID[type] * s, tall / 2, SOLID[type] * s).setDensity(type === 'palm' ? 260 : 420).setFriction(0.8);
    if (this.groupsProp !== undefined) cd.setCollisionGroups(this.groupsProp);
    world.createCollider(cd, body);
    const k = Math.min(3, 0.6 + strength);
    body.applyImpulse({ x: dir.x * 1400 * k, y: 200, z: dir.z * 1400 * k }, true);
    body.applyImpulseAtPoint({ x: dir.x * 900 * k, y: 0, z: dir.z * 900 * k }, { x, y: y + tall * 0.8, z }, true);
    const mesh = new THREE.Mesh(sc.geometry, sc.mesh.material);
    mesh.castShadow = true;
    mesh.scale.setScalar(s);
    mesh.position.y = -tall / 2;
    const holder = new THREE.Group();
    holder.add(mesh);
    sc.mesh.parent.add(holder);
    this.fallen.push({ body, holder, t: 0, type });
    while (this.fallen.length > 24) this.removeFallen(this.fallen[0]);
    return true;
  }

  removeFallen(f) {
    this.world.removeRigidBody(f.body);
    f.holder.parent?.remove(f.holder);
    this.fallen.splice(this.fallen.indexOf(f), 1);
  }

  syncFallen(dt) {
    for (const f of [...this.fallen]) {
      const t = f.body.translation(), q = f.body.rotation();
      f.holder.position.set(t.x, t.y, t.z);
      f.holder.quaternion.set(q.x, q.y, q.z, q.w);
      f.t += dt;
      if (f.t > 40) this.removeFallen(f);
    }
  }
}

// Street lamps: instanced poles + additive glow points at night; poles are breakable.
export class Lamps {
  constructor(roads, scene) {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.6, metalness: 0.3 });
    this.uniforms = { uNight: { value: 0 } };
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uNight = this.uniforms.uNight;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vHead;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHead = step(8.25, position.y) * step(1.55, position.z);');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight; varying float vHead;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.7, 0.35) * vHead * (0.15 + 4.0 * uNight);');
    };
    mat.customProgramCacheKey = () => 'lamp';
    this.scatter = new Scatter(scene, lampGeometry(), mat, { capacity: 9000, radius: 1400, shadowRadius: 120 });
    const L = roads.lamps;
    const pos = [];
    for (let i = 0; i < L.length; i += 4) {
      const sy = roads.lampScale?.[i / 4] ?? 1; // shorter pedestrian lamps (src/world/Parks.js) scale the pole
      this.scatter.add(L[i], L[i + 1], L[i + 2], L[i + 3], 1, 0xffffff, sy);
      // head position in world (arm points along local +z rotated by yaw)
      pos.push(L[i] + Math.sin(L[i + 3]) * 2.0, L[i + 1] + 8.2 * sy, L[i + 2] + Math.cos(L[i + 3]) * 2.0);
    }
    this.scatter.finalize();
    this.count = L.length / 4;
    // glow sprites
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.glowMat = new THREE.PointsMaterial({
      size: 9, sizeAttenuation: true, map: glowTexture(), color: 0xffb066, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
    });
    // far away a 9 m glow shrinks below a pixel and the lit streets vanished at night: keep every glow at least
    // ~3 px wide (a bright dot per lamp, the street grid stays readable from the air), a bit brighter when that small
    this.glowMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vFarGlow;')
        .replace('#include <fog_vertex>', `#include <fog_vertex>
          vFarGlow = clamp(3.0 / max(gl_PointSize, 0.01), 1.0, 2.2);
          gl_PointSize = max(gl_PointSize, 3.0);`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFarGlow;')
        .replace('#include <premultiplied_alpha_fragment>', `#include <premultiplied_alpha_fragment>
          gl_FragColor.rgb *= vFarGlow;`);
    };
    this.glowMat.customProgramCacheKey = () => 'lamp-glow-far';
    this.glow = new THREE.Points(g, this.glowMat);
    this.glow.frustumCulled = false;
    scene.add(this.glow);
    this.colliders = new Map();
    this.broken = new Map(); // id -> rigid body
  }

  update(camera, dt, night) {
    this.uniforms.uNight.value = night;
    this.glowMat.opacity = night * 0.9;
    this.glow.visible = night > 0.02;
    this.scatter.update(camera, dt);
  }

  updateColliders(RAPIER, world, x, z, radius, groups) {
    const need = new Set();
    const sc = this.scatter;
    for (const id of sc.near(x, z, radius)) {
      if (this.broken.has(id)) continue;
      need.add(id);
      if (this.colliders.has(id)) continue;
      const r = sc.raw, sy = r[id * 6 + 5] || 1;
      const desc = RAPIER.ColliderDesc.cylinder(4.25 * sy, 0.16).setTranslation(r[id * 6], r[id * 6 + 1] + 4.25 * sy, r[id * 6 + 2])
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(2500);
      if (groups !== undefined) desc.setCollisionGroups(groups);
      const c = world.createCollider(desc);
      c.userData = { lamp: id };
      this.colliders.set(id, c);
    }
    for (const [id, c] of this.colliders) if (!need.has(id)) { world.removeCollider(c, false); this.colliders.delete(id); }
  }

  // knock a lamp over: hide instance, spawn a dynamic pole
  breakLamp(RAPIER, world, scene, id, impulseDir, groups) {
    if (this.broken.has(id)) return;
    const c = this.colliders.get(id);
    if (c) { world.removeCollider(c, false); this.colliders.delete(id); }
    const sc = this.scatter;
    sc.hidden.add(id);
    sc.update({ position: new THREE.Vector3(1e9, 0, 0), getWorldDirection: (v) => v.set(0, 0, 1), projectionMatrix: new THREE.Matrix4(), matrixWorldInverse: new THREE.Matrix4() }, 0, true);
    const r = sc.raw, sy = r[id * 6 + 5] || 1;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(r[id * 6], r[id * 6 + 1] + 4.3 * sy, r[id * 6 + 2])
      .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r[id * 6 + 3])));
    const cd = RAPIER.ColliderDesc.cuboid(0.14, 4.25 * sy, 0.14).setDensity(180);
    if (groups !== undefined) cd.setCollisionGroups(groups);
    world.createCollider(cd, body);
    body.applyImpulse({ x: impulseDir.x * 900, y: 300, z: impulseDir.z * 900 }, true);
    body.applyTorqueImpulse({ x: impulseDir.z * 1500, y: 0, z: -impulseDir.x * 1500 }, true);
    // fallen pole: dark material (no glowing head) + its glow sprite and road light pool go out
    const mesh = new THREE.Mesh(sc.geometry, this.deadMat || sc.mesh.material);
    mesh.castShadow = true;
    const gp = this.glow.geometry.attributes.position;
    gp.setXYZ(id, 0, -1e5, 0);
    gp.needsUpdate = true;
    this.onBreak?.(r[id * 6] + Math.sin(r[id * 6 + 3]) * 2.0, r[id * 6 + 2] + Math.cos(r[id * 6 + 3]) * 2.0);
    const holder = new THREE.Group();
    mesh.position.y = -4.3 * sy;
    mesh.scale.y = sy;
    holder.add(mesh);
    scene.add(holder);
    this.broken.set(id, { body, holder, t: 0 });
    this._needForce = true;
  }

  syncBroken(dt, world, scene) {
    for (const [id, b] of this.broken) {
      if (!b.body) continue;
      const t = b.body.translation(), q = b.body.rotation();
      b.holder.position.set(t.x, t.y, t.z);
      b.holder.quaternion.set(q.x, q.y, q.z, q.w);
      b.t += dt;
      if (b.t > 25) { world.removeRigidBody(b.body); scene.remove(b.holder); b.body = null; }
    }
  }
}

let _glow;
function glowTexture() {
  if (_glow) return _glow;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.2, 'rgba(255,220,170,0.75)');
  gr.addColorStop(0.5, 'rgba(255,160,80,0.18)');
  gr.addColorStop(1, 'rgba(255,140,60,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  _glow = new THREE.CanvasTexture(c);
  return _glow;
}
export { glowTexture };
