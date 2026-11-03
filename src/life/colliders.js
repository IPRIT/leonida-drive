import * as THREE from 'three';

const CELL = 64;
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

// Static colliders of big props (towers, kiosks, piers, yachts, billboard poles), streamed around the player like
// src/world/Streaming.js does for trees and lamps: created within `radius`, removed beyond it, a few per tick.
export class ColliderField {
  constructor(game, { radius = 170, budget = 40, interval = 0.35, maxDrop = 1e9 } = {}) {
    this.maxDrop = maxDrop;
    this._dropped = 0;
    this.game = game;
    this.radius = radius;
    this.budget = budget;
    this.interval = interval;
    this.items = [];
    this.cells = new Map();
    this.live = new Map(); // item index -> collider
    this.timer = 0;
    const G = game.groups?.GROUPS;
    this.G = G ? {
      static: game.groups.groups(G.STATIC, 0xffff),
      ground: game.groups.groups(G.GROUND, 0xffff),
    } : null;
    this._need = new Set();
  }

  _add(it) {
    const i = this.items.length;
    this.items.push(it);
    const key = Math.floor(it.x / CELL) * 65536 + Math.floor(it.z / CELL);
    let l = this.cells.get(key);
    if (!l) this.cells.set(key, (l = []));
    l.push(i);
    return i;
  }

  // oriented box: centre, half extents, yaw (about +Y), pitch (about the local X after yaw)
  // opts: { tag (collider.userData), ev (contact-force event threshold, N) }
  box(x, y, z, hx, hy, hz, yaw = 0, pitch = 0, group = 'static', opts = null) {
    _e.set(pitch, yaw, 0, 'YXZ');
    _q.setFromEuler(_e);
    return this._add({ shape: 0, x, y, z, a: hx, b: hy, c: hz, q: { x: _q.x, y: _q.y, z: _q.z, w: _q.w }, group, tag: opts?.tag, ev: opts?.ev, off: false });
  }

  // vertical cylinder: centre, radius, half height
  cyl(x, y, z, r, hy, group = 'static', opts = null) {
    return this._add({ shape: 1, x, y, z, a: r, b: hy, c: 0, q: null, group, tag: opts?.tag, ev: opts?.ev, off: false });
  }

  // take an item out of the world (broken prop) / put it back
  disable(id) {
    const it = this.items[id];
    if (!it || it.off) return;
    it.off = true;
    const c = this.live.get(id);
    if (c) { this.game.world.removeCollider(c, false); this.live.delete(id); }
  }

  enable(id) { const it = this.items[id]; if (it) it.off = false; }

  update(dt, force = false) {
    const g = this.game;
    if (!g.world || !g.RAPIER || !g.player?.focus) return;
    this.timer -= dt;
    if (!force && this.timer > 0) return;
    this.timer = this.interval;
    const { RAPIER, world } = g;
    const f = g.player.focus, R = this.radius, R2 = R * R;
    const need = this._need;
    need.clear();
    let made = 0;
    for (let i = Math.floor((f.x - R) / CELL); i <= Math.floor((f.x + R) / CELL); i++) {
      for (let j = Math.floor((f.z - R) / CELL); j <= Math.floor((f.z + R) / CELL); j++) {
        const l = this.cells.get(i * 65536 + j);
        if (!l) continue;
        for (let k = 0; k < l.length; k++) {
          const id = l[k], it = this.items[id];
          const dx = it.x - f.x, dz = it.z - f.z;
          if (dx * dx + dz * dz > R2) continue;
          if (it.off) continue;
          need.add(id);
          if (this.live.has(id) || (made >= this.budget && !force)) continue;
          const desc = it.shape === 0 ? RAPIER.ColliderDesc.cuboid(it.a, it.b, it.c) : RAPIER.ColliderDesc.cylinder(it.b, it.a);
          desc.setTranslation(it.x, it.y, it.z).setFriction(0.8);
          if (it.q) desc.setRotation(it.q);
          if (this.G) desc.setCollisionGroups(this.G[it.group] ?? this.G.static);
          if (it.ev) desc.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(it.ev);
          const c = world.createCollider(desc);
          c.userData = it.tag || { life: id };
          this.live.set(id, c);
          made++;
        }
      }
    }
    this._dropped = 0;
    this.live.forEach(this._drop);
  }

  _drop = (c, id) => {
    if (this._need.has(id) || this._dropped >= this.maxDrop) return;
    this._dropped++;
    this.game.world.removeCollider(c, false);
    this.live.delete(id);
  }

  dispose() {
    const w = this.game.world;
    if (w) for (const c of this.live.values()) w.removeCollider(c, false);
    this.live.clear();
  }
}
