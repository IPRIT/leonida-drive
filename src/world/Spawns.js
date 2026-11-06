// Spawn points (docs/ECONOMY.md → Spawning). Everyone starts in Ocean Beach, but at a random kerb slot instead of one
// point: ~120 parking positions along urban (kind-0) roads within 600 m of the district centre, generated
// deterministically from the road graph (same list on every client and on the server). After "wasted" the player
// respawns at a random slot around the nearest of six hospitals. A slot is skipped while another player or car is
// within 25 m of it.
//
// The slot generator is pure (no three.js, no DOM): `buildKerbSlots(edges, …)` works on the runtime `game.roads.edges`
// and on raw `public/data/roads.json` edges converted with `edgesFromJSON`, so the server and node tools can use it.

export const START_AREA = Object.freeze({ name: 'Ocean Beach', x: 1728, z: -733, r: 600, slots: 120 });

// Six hospitals near district centres across the map (anchor points; slots snap to kind-0 roads within `r`).
export const HOSPITALS = Object.freeze([
  { id: 'vicebeach', name: 'Vice Beach Medical Center', area: 'Vice Beach', x: 1735, z: -1430, r: 240 },
  { id: 'downtown', name: 'Vice City General', area: 'Downtown', x: -560, z: 40, r: 240 },
  { id: 'gellhorn', name: 'Port Gellhorn Regional', area: 'Port Gellhorn', x: -6785, z: -3817, r: 260 },
  { id: 'ambrosia', name: 'Ambrosia Community Hospital', area: 'Ambrosia', x: -3150, z: -4000, r: 260 },
  { id: 'kalaga', name: 'Kalaga Ranger Clinic', area: 'Mt. Kalaga National Park', x: -3160, z: -7090, r: 600 },
  { id: 'keys', name: 'Key Lento Medical', area: 'Leonida Keys', x: -2182, z: 5572, r: 260 },
]);

const KIND_ROAD = 0;
const CLEAR_PLAYERS = 25; // m: other players / their cars
const CLEAR_TRAFFIC = 7; // m: AI cars (parked ones sit at the kerb)

// raw roads.json edge → the subset of the runtime Roads edge shape used here
export function edgesFromJSON(roads) {
  const KIND = { road: 0, highway: 1, dirt: 2 };
  return roads.edges.map((e, i) => {
    const n = e.p.length / 2;
    const cum = new Float32Array(n);
    for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(e.p[2 * k] - e.p[2 * k - 2], e.p[2 * k + 1] - e.p[2 * k - 1]);
    return { i, a: e.a, b: e.b, kind: KIND[e.k], w: e.w, pts: e.p, y: e.y, br: e.br || null, n, cum, len: cum[n - 1] };
  });
}

// deterministic 32-bit hash (same as economy/rules.js hash32)
function hash32(x) {
  let h = (x | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Kerb parking slots along kind-0 roads around (x, z).
 * @param edges road edges ({kind, w, pts, y, br, n, cum, len})
 * @param o { x, z, r, max, step = 16 m, spacing = 13 m, endGap = 16 m (keep out of junctions), heightAt?(x,z) }
 * @returns [{ x, y, z, yaw }] — yaw faces the direction of travel of that kerb (right-hand traffic)
 */
export function buildKerbSlots(edges, o) {
  const { x: cx, z: cz, r, max = 120, step = 16, spacing = 13, endGap = 16, heightAt = null, kinds = null } = o;
  const cand = [];
  for (const e of edges) {
    if ((kinds ? !kinds.includes(e.kind) : e.kind !== KIND_ROAD) || e.len < endGap * 2 + 4) continue;
    // quick reject: edge bounding circle
    const mx = e.pts[0], mz = e.pts[1];
    if (Math.hypot(mx - cx, mz - cz) > r + e.len) continue;
    for (let s = endGap; s <= e.len - endGap; s += step) {
      let k = 0;
      while (k < e.n - 2 && e.cum[k + 1] < s) k++;
      if (e.br && (e.br[k] || e.br[k + 1])) continue; // bridges
      const seg = e.cum[k + 1] - e.cum[k] || 1;
      const t = (s - e.cum[k]) / seg;
      const ax = e.pts[2 * k], az = e.pts[2 * k + 1], bx = e.pts[2 * k + 2], bz = e.pts[2 * k + 3];
      const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
      if (Math.hypot(px - cx, pz - cz) > r) continue;
      const tx = (bx - ax) / seg, tz = (bz - az) / seg;
      const py = e.y ? e.y[k] + (e.y[k + 1] - e.y[k]) * t : 0;
      const off = Math.max(1.2, e.w / 2 - 1.5); // the kerb lane, clear of parked traffic on the kerb itself
      for (const side of [1, -1]) {
        // right of the travel direction: (−tz, tx); side −1 = the opposite kerb, facing the other way
        const x = px - tz * off * side, z = pz + tx * off * side;
        if (Math.hypot(x - cx, z - cz) > r) continue; // the kerb offset must not push a slot out of the area
        const h = heightAt ? heightAt(x, z) : py;
        if (h < 0.25) continue; // water / below sea level
        const y = Math.max(h, py, 0) + 0.08;
        const fx = tx * side, fz = tz * side;
        cand.push({ x, y, z, yaw: Math.atan2(-fx, -fz), key: hash32(Math.round(x * 4) * 73856093 ^ Math.round(z * 4) * 19349663) });
      }
    }
  }
  // deterministic thinning: hash order, minimum spacing
  cand.sort((a, b) => a.key - b.key || a.x - b.x || a.z - b.z);
  const out = [];
  const cell = spacing, grid = new Map();
  const gk = (i, j) => i * 65536 + j;
  for (const c of cand) {
    if (out.length >= max) break;
    const i = Math.floor(c.x / cell), j = Math.floor(c.z / cell);
    let ok = true;
    for (let di = -1; di <= 1 && ok; di++) for (let dj = -1; dj <= 1 && ok; dj++) {
      for (const q of grid.get(gk(i + di, j + dj)) || []) if (Math.hypot(q.x - c.x, q.z - c.z) < spacing) { ok = false; break; }
    }
    if (!ok) continue;
    const s = { x: round2(c.x), y: round2(c.y), z: round2(c.z), yaw: Math.round(c.yaw * 1e4) / 1e4 };
    out.push(s);
    const key = gk(i, j);
    let l = grid.get(key);
    if (!l) grid.set(key, (l = []));
    l.push(s);
  }
  return out;
}
const round2 = (v) => Math.round(v * 100) / 100;

/** All slot sets: { start: [...], hospitals: [{...hospital, slots: [...]}] } (pure). */
export function buildSpawnSets(edges, heightAt = null) {
  const start = buildKerbSlots(edges, { x: START_AREA.x, z: START_AREA.z, r: START_AREA.r, max: START_AREA.slots, heightAt });
  const hospitals = HOSPITALS.map((h) => {
    const o = { x: h.x, z: h.z, r: h.r, max: 16, spacing: 11, heightAt };
    let slots = buildKerbSlots(edges, o);
    // Remote clinics can front an arterial rather than an urban street. Prefer
    // ordinary kerbs, but never leave a hospital with no usable respawn points.
    if (slots.length < 10) slots = buildKerbSlots(edges, { ...o, kinds: [0, 1] });
    return { ...h, slots };
  });
  return { start, hospitals };
}

/** `game.spawns`: deterministic kerb slots + occupancy-aware picking. */
export class Spawns {
  constructor(game) {
    this.game = game;
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const heightAt = game.terrain ? (x, z) => game.terrain.heightAt(x, z) : null;
    const sets = buildSpawnSets(game.roads.edges, heightAt);
    this.start = sets.start;
    this.hospitals = sets.hospitals;
    this.buildMs = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
  }

  nearestHospital(x, z) {
    let best = this.hospitals[0], bd = Infinity;
    for (const h of this.hospitals) {
      if (!h.slots.length) continue;
      const d = Math.hypot(h.x - x, h.z - z);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }

  /**
   * Pick a spawn slot. kind 'start' → Ocean Beach kerb slots; 'hospital' → slots around the hospital nearest to `near`.
   * Slots with another player (25 m) or an AI car (7 m) nearby are skipped; if all are taken, the emptiest one wins.
   * @returns {{x, y, z, yaw, name, kind, hospital?}}
   */
  pickSpawn(kind = 'start', near = null, rand = Math.random) {
    let list = this.start, name = START_AREA.name, hosp = null;
    if (kind === 'hospital') {
      const p = near || this.game.player?.focus || START_AREA;
      hosp = this.nearestHospital(p.x, p.z);
      list = hosp.slots;
      name = hosp.name;
    }
    if (!list.length) return null;
    const others = this._occupants();
    let best = null, bestClear = -1;
    const n = list.length, start = Math.floor(rand() * n);
    for (let i = 0; i < n; i++) {
      const s = list[(start + i * 7) % n]; // stride through the list so retries spread out
      const clear = this._clearance(s, others);
      if (clear >= 1) { best = s; break; }
      if (clear > bestClear) { bestClear = clear; best = s; }
    }
    return { x: best.x, y: best.y, z: best.z, yaw: best.yaw, name, kind, hospital: hosp?.id };
  }

  /** Nearest road position to (x, z) (not on a dirt track or bridge), e.g. to restore a saved position. */
  snapToRoad(x, z) {
    const g = this.game, roads = g.roads;
    let n = roads.nearest(x, z, 800, (e) => e.kind !== 2 && !e.br);
    if (!n) n = roads.nearest(x, z, 6000);
    if (!n) return { x, z, y: Math.max(g.terrain?.heightAt(x, z) ?? 0, 0) + 0.5, yaw: 0 };
    const [dx, dz] = n.dir;
    const off = Math.min(n.edge.w * 0.25, 3);
    const sx = n.x - dz * off, sz = n.z + dx * off;
    const y = Math.max(g.terrain?.heightAt(sx, sz) ?? 0, n.y, 0) + 0.08;
    return { x: sx, z: sz, y, yaw: Math.atan2(-dx, -dz) };
  }

  // positions to keep clear: remote players (multiplayer), full-physics vehicles, AI traffic
  _occupants() {
    const g = this.game, out = [];
    const remote = g.net?.remotePositions?.();
    if (remote) for (const p of remote) out.push(p.x, p.z, CLEAR_PLAYERS);
    const mine = g.player?.controllable;
    for (const v of g.vehicles?.active || []) {
      if (v === mine || !v.body) continue;
      const t = v.body.translation();
      out.push(t.x, t.z, CLEAR_PLAYERS);
    }
    for (const a of g.traffic?.agents || []) out.push(a.cur.x, a.cur.z, CLEAR_TRAFFIC);
    return out;
  }

  // ≥ 1 = free; otherwise the fraction of the required clearance to the closest occupant
  _clearance(s, o) {
    let k = Infinity;
    for (let i = 0; i < o.length; i += 3) {
      const d = Math.hypot(o[i] - s.x, o[i + 1] - s.z) / o[i + 2];
      if (d < k) k = d;
    }
    return k;
  }
}
