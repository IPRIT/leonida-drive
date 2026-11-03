// Static colliders of landmark models (boxes, vertical cylinders, convex hulls), streamed around the player like
// src/world/Streaming.js does for buildings: created within `radius`, removed beyond it, a budget per tick.
// Collision group STATIC; userData = { landmark: siteId } (the building damage system ignores them).
const CELL = 64;

export class ColliderField {
  constructor(game, { radius = 320, budget = 60, interval = 0.3 } = {}) {
    this.game = game;
    this.radius = radius;
    this.budget = budget;
    this.interval = interval;
    this.items = [];
    this.cells = new Map();
    this.live = new Map();
    this.timer = 0;
    const G = game.groups?.GROUPS;
    this.group = G ? game.groups.groups(G.STATIC, 0xffff) : undefined;
    this._need = new Set();
  }

  _add(it) {
    const i = this.items.length;
    this.items.push(it);
    // index by the cells the item's footprint touches (long boxes such as concourses span many cells)
    const r = it.reach;
    for (let cx = Math.floor((it.x - r) / CELL); cx <= Math.floor((it.x + r) / CELL); cx++) {
      for (let cz = Math.floor((it.z - r) / CELL); cz <= Math.floor((it.z + r) / CELL); cz++) {
        const key = cx * 65536 + cz;
        let l = this.cells.get(key);
        if (!l) this.cells.set(key, (l = []));
        l.push(i);
      }
    }
    return i;
  }

  // oriented box: centre, half extents, yaw about +Y (three.js convention)
  box(x, y, z, hx, hy, hz, yaw = 0, tag = null) {
    if (hx < 0.05 || hy < 0.05 || hz < 0.05) return -1;
    const h = yaw / 2;
    return this._add({ shape: 0, x, y, z, a: hx, b: hy, c: hz, q: { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) }, tag, reach: Math.hypot(hx, hz) });
  }

  cyl(x, y, z, r, hy, tag = null) { return this._add({ shape: 1, x, y, z, a: r, b: hy, tag, reach: r }); }

  // convex hull of world points [x,y,z, ...]
  hull(pts, tag = null) {
    let x = 0, y = 0, z = 0;
    const n = pts.length / 3;
    for (let i = 0; i < pts.length; i += 3) { x += pts[i]; y += pts[i + 1]; z += pts[i + 2]; }
    x /= n; y /= n; z /= n;
    let reach = 0;
    const local = new Float32Array(pts.length);
    for (let i = 0; i < pts.length; i += 3) {
      local[i] = pts[i] - x; local[i + 1] = pts[i + 1] - y; local[i + 2] = pts[i + 2] - z;
      reach = Math.max(reach, Math.hypot(local[i], local[i + 2]));
    }
    return this._add({ shape: 2, x, y, z, pts: local, tag, reach });
  }

  // is ground point (x, z) inside a landmark collider footprint (+pad)? Used to place parked vehicles clear of
  // structures and of each other (vehicles add their own box). Hulls count by their footprint radius.
  blocked(x, z, pad = 0, skipTag = null) {
    const l = this.cells.get(Math.floor(x / CELL) * 65536 + Math.floor(z / CELL));
    if (!l) return false;
    for (let k = 0; k < l.length; k++) {
      const it = this.items[l[k]];
      if (it.off || (skipTag && typeof it.tag === 'string' && it.tag.endsWith(skipTag))) continue;
      const dx = x - it.x, dz = z - it.z;
      if (dx * dx + dz * dz > (it.reach + pad) ** 2) continue;
      if (it.shape === 0) {
        const yaw = 2 * Math.atan2(it.q.y, it.q.w), c = Math.cos(yaw), s = Math.sin(yaw);
        if (Math.abs(c * dx - s * dz) <= it.a + pad && Math.abs(s * dx + c * dz) <= it.c + pad) return true;
      } else if (it.shape === 1) return true;
      else if (dx * dx + dz * dz < (it.reach * 0.8 + pad) ** 2) return true;
    }
    return false;
  }

  update(dt, force = false) {
    const g = this.game;
    if (!g.world || !g.RAPIER || !g.player?.focus) return;
    this.timer -= dt;
    if (!force && this.timer > 0) return;
    this.timer = this.interval;
    const { RAPIER, world } = g;
    // stream around where the player will be ~1.5 s from now (fast cars, planes)
    const f0 = g.player.focus;
    const body = g.player.mode === 'vehicle' ? g.player.controllable?.body : null;
    const v = body ? body.linvel() : null;
    const fx = v ? f0.x + v.x * 1.5 : f0.x, fz = v ? f0.z + v.z * 1.5 : f0.z;
    const R = this.radius;
    const need = this._need;
    need.clear();
    let made = 0;
    for (let i = Math.floor((fx - R) / CELL); i <= Math.floor((fx + R) / CELL); i++) {
      for (let j = Math.floor((fz - R) / CELL); j <= Math.floor((fz + R) / CELL); j++) {
        const l = this.cells.get(i * 65536 + j);
        if (!l) continue;
        for (let k = 0; k < l.length; k++) {
          const id = l[k];
          if (need.has(id)) continue;
          const it = this.items[id];
          if (it.off) continue;
          const dx = it.x - fx, dz = it.z - fz, rr = R + it.reach;
          if (dx * dx + dz * dz > rr * rr) continue;
          need.add(id);
          if (this.live.has(id) || (made >= this.budget && !force)) continue;
          let desc;
          if (it.shape === 0) desc = RAPIER.ColliderDesc.cuboid(it.a, it.b, it.c).setRotation(it.q);
          else if (it.shape === 1) desc = RAPIER.ColliderDesc.cylinder(it.b, it.a);
          else desc = RAPIER.ColliderDesc.convexHull(it.pts);
          if (!desc) continue;
          desc.setTranslation(it.x, it.y, it.z).setFriction(0.7).setRestitution(0.05);
          if (this.group !== undefined) desc.setCollisionGroups(this.group);
          const c = world.createCollider(desc);
          c.userData = { landmark: it.tag };
          this.live.set(id, c);
          made++;
        }
      }
    }
    for (const [id, c] of this.live) {
      if (need.has(id)) continue;
      world.removeCollider(c, false);
      this.live.delete(id);
    }
  }

  dispose() {
    const w = this.game.world;
    if (w) for (const c of this.live.values()) w.removeCollider(c, false);
    this.live.clear();
  }
}
