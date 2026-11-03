// Vehicle obstacles for characters: oriented boxes of player/spawned vehicles, AI traffic and remote players'
// vehicles near the focus. Boxes are pooled and refreshed every frame from their sources; a spatial hash is rebuilt
// every 0.2 s with each box inserted into the cells its (inflated + look-ahead + motion) footprint covers, so a
// single-cell lookup returns everything a pedestrian may need to avoid. No allocations in steady state.
import { vehicleBox, agentBox } from './util.js';

const CELL = 8;
const RANGE = 140; // collect vehicles within this distance of the focus
export const INFLATE = 0.5; // avoidance / hard-guarantee margin around the car body
const LOOK = 4.5; // pedestrian look-ahead included in the hash footprint

// remote players' vehicles (workstream J): game.net.remoteVehicles() -> [{ x, y, z, yaw, hw, hl, vx?, vz?, speed? }]
// (yaw = three.js rotation.y, 0 faces -Z; hw/hl = half width/length in metres)
function remoteBox(r, out) {
  out.x = r.x; out.y = r.y ?? 0; out.z = r.z;
  out.yaw = r.yaw ?? 0;
  out.hw = r.hw ?? 0.95; out.hl = r.hl ?? 2.3;
  out.vx = r.vx ?? 0; out.vy = 0; out.vz = r.vz ?? 0;
  out.speed = r.speed ?? Math.hypot(out.vx, out.vz);
  out.ref = null;
  return out;
}

// fallback until remoteVehicles() exists: the net store's interpolated entities (model 255 = on foot)
function storeBox(e, dims, out) {
  out.x = e.x; out.y = (e.y ?? 0) + 0.7; out.z = e.z;
  out.yaw = e.yaw ?? 0;
  out.hw = (dims?.width ?? 1.9) / 2; out.hl = (dims?.length ?? 4.6) / 2;
  out.vx = e.vx ?? 0; out.vy = 0; out.vz = e.vz ?? 0;
  out.speed = Math.hypot(out.vx, out.vz);
  out.ref = null;
  return out;
}

export class VehicleObstacles {
  constructor(game) {
    this.game = game;
    this.boxes = []; // pooled box objects, first n are live
    this.n = 0;
    this.cells = new Map(); // cell key -> array of box indices (arrays reused)
    this.timer = 0;
    this.order = 12;
  }

  _fill(b) {
    const s = b.src;
    try {
      if (b.kind === 0) {
        if (!s.body?.translation || (s.body.isValid && !s.body.isValid())) return false;
        vehicleBox(s, b);
      } else if (b.kind === 1) {
        if (!s.cur || !s.cq) return false;
        agentBox(s, b);
        b.traffic = !s.crashed;
      } else if (b.kind === 2) remoteBox(s, b);
      else {
        if (!s.model || s.model === 255 || s.state === 'out' || !(s.alpha >= 0.5)) return false;
        storeBox(s, this.game.net?.vehicles?.dims?.(s.model), b);
      }
    } catch { return false; }
    b.c = Math.cos(b.yaw);
    b.s = Math.sin(b.yaw);
    return Number.isFinite(b.x) && Number.isFinite(b.z);
  }

  _add(src, kind, focus) {
    const n = this.n;
    const b = this.boxes[n] || (this.boxes[n] = { src: null, kind: 0, traffic: false });
    b.src = src; b.kind = kind; b.traffic = false;
    if (!this._fill(b)) return;
    if (Math.abs(b.x - focus.x) > RANGE || Math.abs(b.z - focus.z) > RANGE) return;
    this.n = n + 1;
  }

  collect(focus) {
    const g = this.game;
    this.n = 0;
    for (const v of g.vehicles?.active || []) if (v && !v.disposed) this._add(v, 0, focus);
    for (const a of g.traffic?.agents || []) if (a) this._add(a, 1, focus);
    const net = g.net;
    if (net?.remoteVehicles) {
      const rv = net.remoteVehicles();
      if (rv) for (const r of rv) if (r) this._add(r, 2, focus);
    } else {
      const list = net?.store?.list;
      if (Array.isArray(list)) for (const e of list) if (e) this._add(e, 3, focus);
    }
    this._hash();
  }

  refresh() {
    for (let i = 0; i < this.n; i++) {
      const b = this.boxes[i];
      if (!this._fill(b)) { b.hw = b.hl = -1; } // gone: becomes an empty box until the next collect
    }
  }

  _hash() {
    const cells = this.cells;
    if (cells.size > 6000) cells.clear();
    for (const l of cells.values()) l.length = 0;
    for (let i = 0; i < this.n; i++) {
      const b = this.boxes[i];
      const r = Math.hypot(b.hw, b.hl) + INFLATE + LOOK + b.speed * 0.25;
      const i0 = Math.floor((b.x - r) / CELL), i1 = Math.floor((b.x + r) / CELL);
      const j0 = Math.floor((b.z - r) / CELL), j1 = Math.floor((b.z + r) / CELL);
      for (let ci = i0; ci <= i1; ci++) {
        for (let cj = j0; cj <= j1; cj++) {
          const key = ci * 100003 + cj;
          let l = cells.get(key);
          if (!l) cells.set(key, (l = []));
          l.push(i);
        }
      }
    }
  }

  /** Box indices that may matter at (x, z) (shared array: read before the next call). */
  at(x, z) {
    return this.cells.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL)) || EMPTY;
  }

  update(dt, game) {
    this.timer -= dt;
    const f = game.player?.focus;
    if (this.timer <= 0 && f) { this.timer = 0.2; this.collect(f); } else this.refresh();
  }
}
const EMPTY = [];

export function getObstacles(game) {
  if (!game.vehicleObstacles) {
    game.vehicleObstacles = new VehicleObstacles(game);
    game.register?.(game.vehicleObstacles, 12);
  }
  return game.vehicleObstacles;
}

// ---- box helpers (b from VehicleObstacles; local frame: x right, z back, front at -hl) ----

/** Local coordinates of a world point: writes out.lx/out.lz. */
export function toLocal(b, x, z, out) {
  const dx = x - b.x, dz = z - b.z;
  out.lx = dx * b.c - dz * b.s;
  out.lz = dx * b.s + dz * b.c;
  return out;
}

/** World point from local coordinates: writes out.x/out.z. */
export function toWorld(b, lx, lz, out) {
  out.x = b.x + lx * b.c + lz * b.s;
  out.z = b.z - lx * b.s + lz * b.c;
  return out;
}

/** Does the segment (x0,z0)-(x1,z1) (local coords) cross the box [-ax,ax]x[-az,az]? (slab test, no allocation) */
export function segHitsBox(x0, z0, x1, z1, ax, az) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dz = z1 - z0;
  if (Math.abs(dx) < 1e-9) { if (x0 < -ax || x0 > ax) return false; } else {
    let a = (-ax - x0) / dx, b = (ax - x0) / dx;
    if (a > b) { const t = a; a = b; b = t; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return false;
  }
  if (Math.abs(dz) < 1e-9) { if (z0 < -az || z0 > az) return false; } else {
    let a = (-az - z0) / dz, b = (az - z0) / dz;
    if (a > b) { const t = a; a = b; b = t; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return false;
  }
  return true;
}
