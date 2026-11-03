// Remote players on foot. Uses workstream D's createRemoteAvatars (seeded looks, procedural animation, instancing)
// when available; otherwise a cheap instanced capsule person with swinging legs. Positions come already
// interpolated from the RemoteStore, so D's own smoothing is bypassed (no double lag).
import * as THREE from 'three';
import { ANIM, F_ANIM, F_ANIM_SHIFT, PLAYER_COLORS } from '../shared/constants.js';
import { seatFor } from '../../characters/util.js';
import { quatToMat } from '../../characters/rig.js';

const _e = new THREE.Euler(), _qv = new THREE.Quaternion(), _hp = new THREE.Vector3();
const DEFAULT_DIMS = { h: 1.8 };

const STATE = ['idle', 'walk', 'run', 'run', 'jump', 'swim', 'ragdoll', 'drive'];

const _st = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, state: 'idle' }; // reused: no per-frame allocations
const _st0 = { outfit: null };
const _sts = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, state: 'seat', seat: null }; // { slot: itemId, colors: { itemId: hex } } — same shape as game.economy.outfit

export class Avatars {
  constructor(game, { max = 200, factory = null, client = null } = {}) {
    this.client = client;
    this.game = game;
    this.max = max;
    this.impl = null;
    this.handles = new Map(); // netId → handle
    this.seen = new Set();
    if (factory) {
      try { this.impl = factory(game, { max, colliders: false }); } catch (e) { console.warn('[net] remote avatars unavailable', e); }
    }
    if (!this.impl) this.fallback = new CapsulePeople(game, max);
    this.visible = true;
  }

  update(entities, dt) {
    const seen = this.seen;
    seen.clear();
    if (this.visible) {
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (e.alpha <= 0.02 || !e.hasCurve) continue;
        // in a vehicle: seated like the local player (bikes, golf carts, open cars; closed glass hides the rest)
        const seat = e.model !== 0 ? this._seat(e) : null;
        if (e.model !== 0 && (!seat || !this.impl || e.wreckH)) continue;
        if (!e.hasInfo && performance.now() - e.recvAt < 600) continue; // wait briefly for the look seed (nickname)
        seen.add(e.id);
        const anim = (e.flags & F_ANIM) >> F_ANIM_SHIFT;
        if (this.impl) {
          let h = this.handles.get(e.id);
          if (!h) {
            const outfit = this.client?.outfitOf(e) || null;
            h = this.impl.add(e.id, { seed: e.hasInfo ? e.nickCode * 2654435761 >>> 0 : e.id, outfit });
            if (!h) continue;
            h.netInfoAt = e.infoAt;
            this.handles.set(e.id, h);
          }
          // outfit (wardrobe items, replicated through INFO): applied once per change, never per frame
          if (h.netInfoAt !== e.infoAt) { h.netInfoAt = e.infoAt; _st0.outfit = this.client?.outfitOf(e) || null; h.set(_st0); }
          h.fresh = true; // positions are already smooth: take them as-is
          if (seat) {
            const ns = h.netSeat || (h.netSeat = { M: new Float32Array(12), pos: null, pose: 'car', recline: 0.2, legDrop: 0.4, steer: 0, pedal: 0 });
            _qv.setFromEuler(_e.set(e.pitch || 0, e.yaw, e.roll || 0, 'YXZ'));
            quatToMat(ns.M, 0, e.x, e.y, e.z, _qv.x, _qv.y, _qv.z, _qv.w);
            ns.pos = seat.pos; ns.pose = seat.pose; ns.recline = seat.recline; ns.legDrop = seat.legDrop;
            ns.steer = Math.max(-1, Math.min(1, (e.steer || 0) * 2));
            ns.pedal += dt * Math.min(12, Math.abs(e.speed || 0) / 0.45);
            _hp.copy(seat.pos).applyQuaternion(_qv);
            _sts.x = e.x + _hp.x; _sts.y = e.y + _hp.y; _sts.z = e.z + _hp.z; _sts.yaw = e.yaw; _sts.seat = ns;
            h.set(_sts);
            h.visible = e.alpha > 0.35;
            continue;
          }
          let st = STATE[anim] || 'idle';
          if (anim === ANIM.AIR) st = e.vy > 0.5 ? 'jump' : 'fall';
          _st.x = e.x; _st.y = e.y; _st.z = e.z; _st.yaw = e.yaw; _st.speed = e.speed; _st.state = st;
          h.set(_st);
          h.visible = e.alpha > 0.35;
        } else this.fallback.add(e, anim, dt);
      }
    }
    if (this.impl) {
      for (const [id] of this.handles) if (!seen.has(id)) { this.impl.remove(id); this.handles.delete(id); }
      this.impl.update(dt);
    } else this.fallback.flush();
  }

  // driver seat of a remote vehicle model (vehicle frame), from its bake: the same seatFor() as the local player
  _seat(e) {
    const cache = this.seats || (this.seats = new Map());
    const dims = this.handles.get(e.id)?.dims || DEFAULT_DIMS;
    const key = `${e.model}:${dims.h}`;
    const b = this.vehicles?.dims?.(e.model);
    if (!b || b.id?.startsWith('proxy:')) return null; // wait for the actual cabin, not the temporary proxy
    const cached = cache.get(key);
    if (cached?.baked === b) return cached.seat;
    let seat = null;
    try {
      const r = b.spec?.wheelRadius ?? b.radius ?? 0.33;
      const bb = b.geo?.boundingBox;
      const pv = { kind: b.kind || 'car', spec: b.spec, seats: b.spec?.seats || b.seats };
      if (bb) pv.__lbox = bb.clone().translate(new THREE.Vector3(0, -r, 0)); // model origin is the ground; vehicle frame is r up
      if (bb && !b.spec?.collider?.cabin) pv.dims = { height: bb.max.y }; // roof height → seatFor fits the head under it (no head through the roof)
      seat = seatFor(pv, dims);
    } catch { seat = null; }
    if (cache.size >= 512) cache.clear();
    cache.set(key, { baked: b, seat });
    return seat;
  }

  setVisible(v) { this.visible = v; }

  dispose() {
    if (this.impl) { this.impl.dispose?.(); this.handles.clear(); }
    this.fallback?.dispose();
  }
}

// ---------------- fallback: instanced low-poly people ----------------
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _l = new THREE.Vector3();
const _qa = new THREE.Quaternion(), AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
const _c = new THREE.Color();

class CapsulePeople {
  constructor(game, max) {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0, flatShading: true });
    const body = new THREE.CapsuleGeometry(0.22, 0.55, 3, 8).translate(0, 1.18, 0);
    const head = new THREE.SphereGeometry(0.15, 10, 8).translate(0, 1.72, 0);
    const torso = mergeTwo(body, head);
    const limb = new THREE.CapsuleGeometry(0.075, 0.62, 2, 6).translate(0, -0.38, 0); // pivot at the top
    const arm = new THREE.CapsuleGeometry(0.06, 0.5, 2, 6).translate(0, -0.3, 0);
    this.body = new THREE.InstancedMesh(torso, mat, max);
    this.legs = new THREE.InstancedMesh(limb, mat, max * 2);
    this.arms = new THREE.InstancedMesh(arm, mat, max * 2);
    for (const m of [this.body, this.legs, this.arms]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = true;
      game.scene.add(m);
    }
    this.body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.legs.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 6), 3).setUsage(THREE.DynamicDrawUsage);
    this.arms.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 6), 3).setUsage(THREE.DynamicDrawUsage);
    this.max = max;
    this.n = 0;
  }

  add(e, anim, dt) {
    if (this.n >= this.max) return;
    const i = this.n++;
    const sc = e.alpha < 1 ? e.alpha : 1;
    const lying = anim === ANIM.RAGDOLL;
    _q.setFromAxisAngle(AY, e.yaw);
    if (lying) _q.multiply(_qa.setFromAxisAngle(AX, -Math.PI / 2));
    _p.set(e.x, e.y + (lying ? 0.25 : 0), e.z);
    _m.compose(_p, _q, _s.set(sc, sc, sc));
    this.body.setMatrixAt(i, _m);
    _c.set(PLAYER_COLORS[(e.hasInfo ? e.color : e.id) % PLAYER_COLORS.length]);
    this.body.setColorAt(i, _c);
    // gait
    const moving = anim >= ANIM.WALK && anim <= ANIM.SPRINT;
    if (moving) e.animPhase += dt * (2.2 + e.speed * 1.6);
    const swing = moving ? Math.sin(e.animPhase) * Math.min(0.9, 0.35 + e.speed * 0.12) : anim === ANIM.SWIM ? Math.sin(e.animPhase += dt * 3) * 0.5 : 0;
    for (let k = 0; k < 2; k++) {
      const side = k ? 1 : -1;
      // legs from the hips
      _l.set(side * 0.11 * sc, 0.86 * sc, 0).applyQuaternion(_q).add(_p);
      _qa.copy(_q).multiply(_tmpQ.setFromAxisAngle(AX, swing * side));
      _m.compose(_l, _qa, _s.set(sc, sc, sc));
      this.legs.setMatrixAt(i * 2 + k, _m);
      this.legs.setColorAt(i * 2 + k, _c2.setHex(0x2b2f3a));
      // arms from the shoulders, opposite phase
      _l.set(side * 0.3 * sc, 1.5 * sc, 0).applyQuaternion(_q).add(_p);
      _qa.copy(_q).multiply(_tmpQ.setFromAxisAngle(AX, -swing * side * 0.8)).multiply(_tmpQ2.setFromAxisAngle(AZ, side * 0.12));
      _m.compose(_l, _qa, _s.set(sc, sc, sc));
      this.arms.setMatrixAt(i * 2 + k, _m);
      this.arms.setColorAt(i * 2 + k, _c3.setHex(0xd9a77f));
    }
  }

  flush() {
    const n = this.n;
    this.body.count = n; this.legs.count = n * 2; this.arms.count = n * 2;
    for (const m of [this.body, this.legs, this.arms]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.n = 0;
  }

  dispose() {
    for (const m of [this.body, this.legs, this.arms]) { m.removeFromParent(); m.geometry.dispose(); m.dispose(); }
    this.body.material.dispose();
  }
}
const _tmpQ = new THREE.Quaternion(), _tmpQ2 = new THREE.Quaternion(), _c2 = new THREE.Color(), _c3 = new THREE.Color();

function mergeTwo(a, b) {
  const ia = a.toNonIndexed(), ib = b.toNonIndexed();
  const pos = new Float32Array(ia.attributes.position.array.length + ib.attributes.position.array.length);
  pos.set(ia.attributes.position.array);
  pos.set(ib.attributes.position.array, ia.attributes.position.array.length);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
