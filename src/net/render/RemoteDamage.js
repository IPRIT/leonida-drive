// Dents, missing panels, broken lamps and glass on remote players' cars, from the compact state they replicate
// (src/net/shared/damage-codec.js, served in INFO on change). A damaged car near the camera is drawn by its own
// dentable copy, made with workstream E's traffic wreck machinery (src/damage/TrafficWreck.js: the same template and
// the same body shader as AI traffic), while RemoteVehicles keeps drawing its wheels. Budget: 6 cars within 120 m;
// farther ones fall back to the clean instanced body. Everything degrades to "no dents" if E's module is absent.
import * as THREE from 'three';
import { decodeDamage, lampBit } from '../shared/damage-codec.js';
import { VCLASS } from '../shared/constants.js';

const MAX_VIEWS = 6;
const NEAR_M = 120, FAR_M = 160;
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _o = new THREE.Vector3(), _p = new THREE.Vector3();
const _paint = new THREE.Color();

export class RemoteDamage {
  constructor(game, vehicles) {
    this.game = game;
    this.vehicles = vehicles; // RemoteVehicles (bakes, body material)
    this.views = new Map(); // netId → view
    this.mods = null;
    this.loading = null;
    this.types = new Map(); // model id → pseudo traffic type { name, baked }
  }

  _load() {
    if (this.loading) return;
    this.loading = Promise.all([import('../../damage/TrafficWreck.js'), import('../../vehicle/bake.js')])
      .then(([tw, bk]) => { this.mods = { TrafficWreckDamage: tw.TrafficWreckDamage, bakeVehicle: bk.bakeVehicle }; })
      .catch(() => { this.mods = false; });
  }

  /** Per frame, after RemoteVehicles.update: entities = RemoteStore.list, client for model ids. */
  update(entities, client) {
    const sys = this.game.damage;
    const cam = this.game.camera?.position;
    if (!sys?.templates || !cam) return;
    const seen = this._seen || (this._seen = new Set());
    seen.clear();
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      let view = this.views.get(e.id);
      const d = Math.hypot(e.x - cam.x, e.z - cam.z);
      const want = e.damage && e.model && e.model !== 255 && e.vclass === VCLASS.CAR && e.alpha > 0.5 && e.state !== 'out' && !e.wreckH;
      if (view && (!want || view.model !== e.model || d > FAR_M)) { this._drop(e.id); view = null; }
      if (!want) { e.dmgView = null; continue; }
      seen.add(e.id);
      if (!view) {
        if (d > NEAR_M || this.views.size >= MAX_VIEWS) { e.dmgView = null; continue; }
        if (this.mods === null) this._load();
        if (!this.mods) { e.dmgView = null; continue; }
        view = this._make(e, client, sys);
        if (!view) { e.dmgView = null; continue; }
      }
      if (view.st && view.ver !== e.damage.ver) this._apply(view, e);
      if (view.st) this._sync(view, e);
      e.dmgView = view.st ? view : null;
    }
    for (const id of this.views.keys()) if (!seen.has(id)) this._drop(id);
  }

  _make(e, client, sys) {
    const id = client.welcome?.models?.[e.model - 1]?.id || client.lastWelcome?.models?.[e.model - 1]?.id;
    if (!id) return null;
    let T = this.types.get(id);
    if (!T) {
      const baked = this.vehicles.types.get(e.model)?.baked;
      if (!baked?.geo || !baked.groups) return null; // no damage partition for this model
      T = { name: id, baked };
      this.types.set(id, T);
    }
    const tpl = sys.templates.get(T);
    if (!tpl) { sys.templates.want(T, true); return null; } // built in the background (time-sliced), next frames
    const b = T.baked;
    const view = { id: e.id, model: e.model, ver: -1, st: null, impacts: new Set(), panels: new Set(), lamps: 0, glass: 0, r: b.spec?.wheelRadius ?? b.radius ?? 0.33 };
    const halfH = (b.height || 1.4) * 0.32, lift = 0.32;
    const agent = {
      lift, halfH, paint: new THREE.Color(e.paint || 0xb3202e), cur: new THREE.Vector3(e.x, e.y, e.z), cq: new THREE.Quaternion(), wreck: null,
      body: { linvel: () => ({ x: e.vx || 0, y: 0, z: e.vz || 0 }) }, // panels thrown off inherit the car's motion
    };
    const tr = { material: this.vehicles.bodyMat, scene: this.game.scene };
    try { view.st = this.mods.TrafficWreckDamage.create(sys, tr, agent, tpl); } catch (err) { console.warn('[net] remote damage', err); return null; }
    const geo = view.st.mesh.geometry, glass = new Float32Array(geo.attributes.position.count);
    for (const v of tpl.glass) glass[v] = 1;
    geo.setAttribute('aGlass', new THREE.BufferAttribute(glass, 1));
    view.cosmetic = new THREE.InstancedBufferAttribute(new Float32Array([e.tint ? 1 : 0, e.finish || 0]), 2);
    geo.setAttribute('aCosmetic', view.cosmetic);
    view.agent = agent;
    this.views.set(e.id, view);
    this._apply(view, e);
    return view;
  }

  // apply what is new since the last version: dents are cumulative, panels / lamps / glass only ever break
  _apply(view, e) {
    view.ver = e.damage.ver;
    const s = decodeDamage(e.damage.data);
    const st = view.st;
    if (!s) return;
    try {
      const impacts = s.impacts.filter((m) => !view.impacts.has(m.key));
      for (const m of impacts) view.impacts.add(m.key);
      const lamps = [];
      if (s.lamps & ~view.lamps) {
        for (const l of st.lamps) if (!l.broken && (s.lamps & ~view.lamps & (1 << lampBit(l.kind, l.cg.x)))) lamps.push({ kind: l.kind, c: [l.cg.x, l.cg.y, l.cg.z] });
        view.lamps |= s.lamps;
      }
      const glass = s.glass > view.glass ? s.glass : 0;
      if (glass) view.glass = glass;
      st.restore({ impacts, lamps, glass, parts: [] }, st.lift);
      for (const key of s.panels) {
        if (view.panels.has(key)) continue;
        view.panels.add(key);
        const p = st.parts.find((q) => q.key === key);
        if (p) st.detach(p, null, 0.6);
      }
    } catch (err) { console.warn('[net] remote damage apply', err); }
  }

  // pose: the dentable copy's root is the body centre (traffic convention), RemoteVehicles' origin is the ground
  _sync(view, e) {
    _q.setFromEuler(_e.set(e.pitch || 0, e.yaw, e.roll || 0, 'YXZ'));
    const up = view.st.lift - view.r; // ground (r below the transmitted pose) + lift
    _o.set(0, up, 0).applyQuaternion(_q);
    _p.set(e.x + _o.x, e.y + _o.y, e.z + _o.z);
    _paint.setHex(Number.isInteger(e.paint) ? e.paint : 0xb3202e);
    view.cosmetic.setXY(0, e.tint ? 1 : 0, e.finish || 0); view.cosmetic.needsUpdate = true;
    view.st.sync(_p, _q, _paint, e.flags & 0x100 ? 1 : 0);
  }

  _drop(id) {
    const v = this.views.get(id);
    this.views.delete(id);
    try { v?.st?.dispose(false); } catch { /* gone */ }
  }

  dispose() { for (const id of [...this.views.keys()]) this._drop(id); }
}
