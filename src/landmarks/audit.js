import { AIRCRAFT_SIZE } from './sites/aircraft.js';

// Placement audit, run in Landmarks.finalize() before the instanced / batched meshes are built. Every parked
// aircraft (landmark airliners, turboprops, freighters), catalog vehicle, plane, helicopter and boat is tested
// against: the remaining generic building footprints, the other placed objects, the visible road ribbons and
// the water. fix = true resolves each hit: a generic building under an aircraft is removed (aircraft stands are
// airport ground), a vehicle / boat in conflict is dropped, an aircraft on a road or in the water is dropped.
// Returns { buildings, objects, roads, water, total } hit counts (before the fixes).

const SAMPLES = [[0, 0], [1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1], [0.5, 0.5], [-0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]];

function objects(L) {
  const list = [];
  for (const t of L.instTypes.values()) {
    const size = AIRCRAFT_SIZE[t.type.key];
    if (!size) continue;
    t.list.forEach((e, i) => {
      const [x, y, z, yaw, , sc = 1] = e;
      // fuselage along local z; full span for buildings / other aircraft, fuselage + engines for vehicles
      list.push({ kind: 'aircraft', x, y, z, c: Math.cos(yaw), s: Math.sin(yaw), hx: (size[1] / 2) * sc, hz: (size[0] / 2) * sc, body: Math.max(2.2, size[1] * 0.1) * sc, t, e, i, prio: 2 });
    });
  }
  for (const v of L.vehicles) {
    const m = v.m, c = Math.cos(v.yaw), s = Math.sin(v.yaw);
    const air = m.kind === 'plane' || m.kind === 'heli';
    list.push({ kind: m.kind === 'boat' ? 'boat' : air ? 'aircraft' : 'vehicle', x: v.x + c * m.cx + s * m.cz, y: v.y, z: v.z - s * m.cx + c * m.cz, c, s, hx: m.wid / 2, hz: m.len / 2, body: air ? Math.min(1.3, m.wid / 2) : m.wid / 2, v, prio: air ? 2 : 1 });
  }
  return list;
}

const pts = (o, hx = o.hx, hz = o.hz) => SAMPLES.map(([a, b]) => [o.x + o.c * a * hx + o.s * b * hz, o.z - o.s * a * hx + o.c * b * hz]);
const inObb = (o, x, z, hx = o.hx, hz = o.hz) => { const dx = x - o.x, dz = z - o.z; return Math.abs(o.c * dx - o.s * dz) <= hx && Math.abs(o.s * dx + o.c * dz) <= hz; };
function inPoly(p, x, z) {
  let c = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i], zi = p[i + 1], xj = p[j], zj = p[j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
// separating-axis test of two oriented rectangles (2D)
function obbOverlap(a, ah, b, bh) {
  const axes = [[a.c, -a.s], [a.s, a.c], [b.c, -b.s], [b.s, b.c]];
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const [ux, uz] of axes) {
    const ra = ah[0] * Math.abs(a.c * ux - a.s * uz) + ah[1] * Math.abs(a.s * ux + a.c * uz);
    const rb = bh[0] * Math.abs(b.c * ux - b.s * uz) + bh[1] * Math.abs(b.s * ux + b.c * uz);
    if (Math.abs(dx * ux + dz * uz) > ra + rb) return false;
  }
  return true;
}

export function auditPlacements(L, { fix = false } = {}) {
  const B = L.game.buildings, T = L.game.terrain;
  const list = objects(L);
  const hits = { buildings: 0, objects: 0, roads: 0, water: 0 };
  const drop = new Set(), removeB = new Set();
  // generic buildings
  if (B?.query) {
    for (const o of list) {
      if (o.kind === 'boat') continue;
      const ids = B.query(o.x, o.z, Math.hypot(o.hx, o.hz) + 25);
      for (const id of ids) {
        if (B.recs[id].removed || removeB.has(id)) continue;
        const p = B.list[id].p;
        // roof props (helicopters on a landmark roof) stand on landmark structures, not on generic ones
        let hit = pts(o).some(([x, z]) => inPoly(p, x, z));
        for (let i = 0; !hit && i < p.length; i += 2) hit = inObb(o, p[i], p[i + 1]);
        if (!hit) continue;
        hits.buildings++;
        if (o.kind === 'aircraft' && o.t) removeB.add(id); else drop.add(o);
      }
    }
  }
  // other objects (vehicles only conflict with an aircraft's fuselage: ground equipment stands under wings);
  // candidate pairs from a 64 m grid
  const grid = new Map();
  list.forEach((o, i) => {
    const r = Math.hypot(o.hx, o.hz);
    for (let gx = Math.floor((o.x - r) / 64); gx <= Math.floor((o.x + r) / 64); gx++) {
      for (let gz = Math.floor((o.z - r) / 64); gz <= Math.floor((o.z + r) / 64); gz++) {
        const k = gx * 65536 + gz;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    }
  });
  hits.pairs = {};
  const seen = new Set();
  for (const cell of grid.values()) for (let p = 0; p < cell.length; p++) for (let q = p + 1; q < cell.length; q++) {
    const i = Math.min(cell[p], cell[q]), j = Math.max(cell[p], cell[q]);
    const key = i * 100000 + j;
    if (seen.has(key)) continue;
    seen.add(key);
    {
      const a = list[i], b = list[j];
      const rr = Math.hypot(a.hx, a.hz) + Math.hypot(b.hx, b.hz);
      if ((a.x - b.x) ** 2 + (a.z - b.z) ** 2 > rr * rr) continue;
      if (Math.abs(a.y - b.y) > 3) continue; // different levels (roof decks)
      const both = a.kind === 'aircraft' && b.kind === 'aircraft';
      const ah = both || a.kind !== 'aircraft' ? [a.hx * (both ? 0.92 : 1), a.hz] : [a.body, a.hz];
      const bh = both || b.kind !== 'aircraft' ? [b.hx * (both ? 0.92 : 1), b.hz] : [b.body, b.hz];
      if (!obbOverlap(a, ah, b, bh)) continue;
      hits.objects++;
      const pk = [a.kind, b.kind].sort().join('-');
      hits.pairs[pk] = (hits.pairs[pk] || 0) + 1;
      drop.add(a.prio < b.prio ? a : a.prio > b.prio ? b : b);
    }
  }
  // roads (vehicles: whole footprint; aircraft: along the fuselage) and water
  for (const o of list) {
    const ground = T.heightAt(o.x, o.z);
    if (o.kind === 'boat') {
      if (ground > -0.4) { hits.water++; drop.add(o); }
      continue;
    }
    const raised = o.y > ground + 1.5; // roof / deck
    if (!raised) {
      const sample = o.kind === 'aircraft' ? pts(o, Math.min(o.body, 1.5), o.hz * 0.85) : pts(o, o.hx * 0.9, o.hz * 0.9);
      if (sample.some(([x, z]) => L.roadHit(x, z, 0) >= 0)) { hits.roads++; drop.add(o); }
      if (ground < 0.15 && T.heightAt(o.x + o.s * o.hz * 0.5, o.z + o.c * o.hz * 0.5) < 0.15) { hits.water++; drop.add(o); }
    }
  }
  // landmark structures (their collider boxes) against generic footprints: a clash means the generic building goes
  hits.props = 0;
  if (B?.query) {
    for (const it of L.colliders.items) {
      if (it.off || it.shape !== 0 || it.vehicle || Math.min(it.a, it.c) < 1.5 || it.b < 1.5) continue;
      if (typeof it.tag === 'string' && it.tag.endsWith(':runway')) continue;
      const yaw = 2 * Math.atan2(it.q.y, it.q.w);
      const o = { x: it.x, z: it.z, c: Math.cos(yaw), s: Math.sin(yaw), hx: it.a - 0.5, hz: it.c - 0.5 };
      for (const id of B.query(it.x, it.z, it.reach + 45)) {
        if (B.recs[id].removed || removeB.has(id)) continue;
        const p = B.list[id].p;
        let hit = pts(o).some(([x, z]) => inPoly(p, x, z));
        for (let i = 0; !hit && i < p.length; i += 2) hit = inObb(o, p[i], p[i + 1]);
        if (!hit) continue;
        hits.props++;
        removeB.add(id);
      }
    }
  }
  hits.total = hits.buildings + hits.objects + hits.roads + hits.water + hits.props;
  if (fix) {
    if (removeB.size) L.removeBuildings({ ids: [...removeB] });
    const dropInst = new Map();
    for (const o of drop) {
      if (o.v) { o.v.dropped = true; L.disableColliders(o.v.cols); }
      else if (o.t) { if (!dropInst.has(o.t)) dropInst.set(o.t, new Set()); dropInst.get(o.t).add(o.e); L.disableColliders(o.e.cols); }
    }
    L.vehicles = L.vehicles.filter((v) => !v.dropped);
    for (const [t, set] of dropInst) t.list = t.list.filter((e) => !set.has(e));
    hits.fixed = { buildingsRemoved: removeB.size, objectsDropped: drop.size };
  }
  return hits;
}
