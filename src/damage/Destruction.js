import * as THREE from 'three';
import { GROUPS, groups } from '../vehicle/groups.js';
import { Fracturer } from './Fracture.js';
import { Collapses } from './Collapse.js';
import { glassBurst, WaterJet, poleSnap, poleLand } from './DestructionFX.js';

// Impulse (N·s ≈ mass × Δv) needed to snap a trunk. bush < palm < tree < pine < cypress.
// halved after play-testing: cars snap palms and trees easily and keep most of their speed
export const TREE_IMPULSE = { reed: 500, bush: 900, palm: 3200, tree: 4500, pine: 6500, cypress: 9000 };
const TREE_TOP = { palm: 8, tree: 4.5, pine: 8, cypress: 9, bush: 1, reed: 1.2 };
// Buildings: hit points from volume (big blasts flatten small buildings); legacy thresholds kept for the fallback path.
export const BUILDING = {
  hp: (area, height) => THREE.MathUtils.clamp(6 * Math.sqrt(Math.max(1, area * height)), 25, 700),
  small: (info) => info.kind !== 'tower' && info.height <= 13 && info.area <= 650,
  explosionDamage: 260, // per unit power at the facade, falls off with distance
  impactScale: 1 / 1000, // contact impulse (N·s) -> damage (legacy path)
  minImpulse: 1200, // ignore gentle pushes (N·s per physics step)
};
// Facades break in proportion to the energy that reaches each wall panel (bay x storey).
// strength by facade style: 0 stucco, 1 art deco, 2 glass curtain wall, 3 house, 4 industrial, 5 concrete
export const WALL = {
  strength: [1.0, 1.15, 0.55, 0.6, 0.85, 1.6],
  panelJ: 60000, // impact energy (J) that knocks out a 3.1 x 3.6 m stucco panel (a car at ~35 km/h)
  glassJ: 2600, // energy that shatters a pane (ground-floor storefronts break at 60 % of it: they go first)
  minJ: 2500, // below: a scuff
  blastK: 2.6, blastR: 2.4, // explosion: panel damage = Pw·K / (1 + (d / (blastR·∛Pw))²) / strength
  glassR: 1.5, // blast overpressure shatters windows out to glassR × blast radius
  support: 0.45, // a region with less than this share of its ground-storey walls left gives way
  sideSupport: 0.35, // ... or with one whole side (>= 3 bays) down to this share: that wall carried the floors above
  keepVel: 0.55, // max share of its speed a car keeps when it bursts through a wall
};
const MAX_CHUNKS = 32;
const MAX_ACTIVE_CHUNKS = 130;
const MAX_RUBBLE = 40;
const MAX_JETS = 4;

const _c = new THREE.Color();
// unit cube (-1..1) as 12 outward-facing triangles
const BOX = (() => {
  const g = new THREE.BoxGeometry(2, 2, 2).toNonIndexed();
  const a = Float32Array.from(g.attributes.position.array);
  g.dispose();
  return a;
})();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const rnd = Math.random;
const clamp = THREE.MathUtils.clamp;

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// nearest point on the polygon outline + distance (0 inside)
function nearestOnPoly(x, z, poly) {
  let best = Infinity, bx = x, bz = z;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [cx, cz] = poly[(i + 1) % poly.length];
    const ex = cx - ax, ez = cz - az;
    const l2 = ex * ex + ez * ez || 1;
    const t = clamp(((x - ax) * ex + (z - az) * ez) / l2, 0, 1);
    const px = ax + ex * t, pz = az + ez * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) { best = d; bx = px; bz = pz; }
  }
  return { x: bx, z: bz, d: pointInPoly(x, z, poly) ? 0 : best, edge: best };
}

// Trees, buildings, lamps and street props reacting to impacts and explosions.
export class Destruction {
  constructor(game, sys) {
    this.game = game;
    this.sys = sys;
    this.treeAcc = new Map();
    this.bAcc = new Map();
    this.bState = new Map();
    this.jobs = []; // legacy collapses (fallback when a building can't be fractured)
    this.collapseQueue = [];
    this._collapseCd = 0;
    this.legacyRubble = [];
    this.rubbleMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 });
    this.staticGroups = groups(GROUPS.STATIC, 0xffff);
    this.chunkGroups = groups(GROUPS.PROP, 0xffff);
    this.fracturer = new Fracturer(game);
    this.collapses = new Collapses(this);
    this.jets = [];
    this.later = []; // delayed events [t, name, payload]
    this.poles = new WeakSet();
    this.stats = { collapses: 0, lastCollapseMs: 0, lastBakeMs: 0, trees: 0, hits: 0, lastHitMs: 0, maxHitMs: 0, panels: 0, panes: 0, lastBlastMs: 0, maxJobMs: 0 };
    const ev = game.events;
    this._offs = ev ? [
      ev.on('tank:hit', (e) => this.onTankHit(e)),
      ev.on('prop:broken', (e) => this.onPropBroken(e)),
      ev.on('lamp:broken', (e) => this.onPoleBroken(e)),
    ] : [];
  }

  get rubble() { return [...this.collapses.rubble, ...this.legacyRubble]; }

  prewarmObjects() {
    const out = this.fracturer.prewarmObjects();
    // snapped trees are drawn with their instanced material on a plain mesh (Vegetation.breakTree): another program
    for (const t of ['palm', 'tree', 'pine', 'cypress']) {
      const sc = this.game.veg?.scatters?.[t];
      if (!sc?.geometry || !sc.mesh?.material) continue;
      const m = new THREE.Mesh(sc.geometry, sc.mesh.material);
      m.castShadow = true;
      m.frustumCulled = false;
      out.push(m);
    }
    return out;
  }

  // ---------- trees ----------

  onTreeContact(type, id, tCol, other, force) {
    const ob = other?.parent?.();
    if (!ob || !ob.isDynamic()) return;
    const J = force / 60;
    const key = `${type}:${id}`;
    const now = this.game.time;
    let a = this.treeAcc.get(key);
    if (!a || now - a.t > 0.25) a = { J: 0, t: now, shook: false };
    a.J += J;
    a.t = now;
    this.treeAcc.set(key, a);
    const thr = TREE_IMPULSE[type] ?? 12000;
    const lv = ob.linvel();
    const sp = Math.hypot(lv.x, lv.z);
    const dir = sp > 0.3 ? { x: lv.x / sp, z: lv.z / sp } : { x: 1, z: 0 };
    let base;
    try { base = tCol.translation(); } catch { return; }
    const hh = tCol.halfHeight?.() ?? 2;
    const bp = { x: base.x, y: base.y - hh, z: base.z };
    if (a.J >= thr) {
      this.treeAcc.delete(key);
      this.breakTree(type, id, bp, dir, a.J / thr, ob);
    } else if (J > thr * 0.2 && !a.shook) {
      a.shook = true;
      this.game.fx?.leaves({ x: bp.x, y: bp.y + (TREE_TOP[type] ?? 4), z: bp.z }, { count: 8, spread: 1.5 });
    }
  }

  breakTree(type, id, bp, dir, ratio = 1, otherBody = null) {
    const game = this.game;
    const ok = game.veg?.breakTree?.(type, id, dir, clamp(ratio - 0.4, 0.2, 2.4));
    if (!ok) return false;
    this.stats.trees++;
    const fx = game.fx;
    if (fx && type !== 'reed') {
      const top = { x: bp.x + dir.x * 1.5, y: bp.y + (TREE_TOP[type] ?? 4), z: bp.z + dir.z * 1.5 };
      if (type !== 'bush') fx.leaves(top, { count: type === 'palm' ? 22 : 34, spread: type === 'palm' ? 2.5 : 2 });
      else fx.leaves({ x: bp.x, y: bp.y + 0.8, z: bp.z }, { count: 14, spread: 1 });
      fx.bits({ x: bp.x, y: bp.y + 0.6, z: bp.z }, { material: 'wood', count: 14, speed: 5, dir: { x: dir.x, y: 0.3, z: dir.z } });
      fx.dust({ x: bp.x, y: bp.y + 0.2, z: bp.z }, 1.2, { color: 'dust', count: 6 });
    }
    game.events?.emit('tree:broken', { position: bp, type, id });
    game.events?.emit('impact', { position: { x: bp.x, y: bp.y + 0.8, z: bp.z }, strength: Math.min(1, 0.4 + ratio * 0.2), kind: 'tree', material: 'wood', source: otherBody });
    // keep the vehicle going instead of stopping dead
    const st = otherBody && this.sys.byHandle.get(otherBody.handle);
    if (st?.hasPrev) {
      const m = otherBody.mass();
      const pl = st.pl;
      const sp = Math.hypot(pl.x, pl.y, pl.z);
      const thr = TREE_IMPULSE[type] ?? 12000;
      if (sp > 1) {
        const keep = clamp(1 - (thr * 0.35) / (m * sp), 0.6, 0.94);
        otherBody.setLinvel({ x: pl.x * keep, y: pl.y * keep, z: pl.z * keep }, true);
        st.suppress = 2;
        const inward = new THREE.Vector3(-pl.x, 0, -pl.z).normalize();
        const dl = st._dirToLocal(inward, new THREE.Vector3());
        const p = st._toWorld(st.surfacePoint(dl, new THREE.Vector3()), new THREE.Vector3());
        st.applyImpact(p, inward, 0.12 + 0.3 * Math.min(1, thr / (m * sp)), { quiet: true });
      }
    }
    return true;
  }

  // ---------- buildings: contacts ----------

  _state(id, info) {
    let st = this.bState.get(id);
    if (!st) {
      const hp = BUILDING.hp(info.area, Math.max(3, info.height));
      st = { hp, maxHp: hp, small: BUILDING.small(info), lastFx: -1, collapsed: false, collapsing: false, pending: new Set() };
      this.bState.set(id, st);
    }
    return st;
  }

  onBuildingContact(id, bCol, other, force) {
    const ob = other?.parent?.();
    if (!ob || !ob.isDynamic()) return;
    const J = force / 60;
    if (J < BUILDING.minImpulse) return;
    let point = null, normal = null;
    try {
      this.game.world.contactPair(bCol, other, (m, flipped) => {
        if (point || m.numSolverContacts() <= 0) return;
        const p = m.solverContactPoint(0);
        point = { x: p.x, y: p.y, z: p.z };
        const n = m.normal(), s = flipped ? -1 : 1; // building -> other = outward
        normal = { x: n.x * s, y: n.y * s, z: n.z * s };
      });
    } catch { /* collider gone */ }
    if (!point) { const t = ob.translation(); point = { x: t.x, y: t.y, z: t.z }; }
    let a = this.bAcc.get(id);
    if (!a) {
      // velocity before this step (the damage system has not seen the impact yet)
      const st = this.sys.byHandle.get(ob.handle);
      const v = st?.hasPrev ? st.pl : ob.linvel();
      // vehicles (player / AI) break walls; flying debris and props only chip them (no chain reactions)
      const vehicle = !!st || !!this.game.traffic?.colliderMap?.has(other.handle);
      this.bAcc.set(id, (a = { J: 0, point, normal, vel: { x: v.x, y: v.y, z: v.z }, body: vehicle ? ob : null, mass: ob.mass() || 1000, k: vehicle ? 1 : 0.12 }));
    }
    a.J += J;
    if (!a.normal && normal) a.normal = normal;
    a.point = point;
  }

  _impact(id, a) {
    const t0 = performance.now();
    const B = this.game.buildings;
    const info = B?.info?.(id);
    if (!info || info.removed) return;
    const st = this._state(id, info);
    if (st.collapsed || st.collapsing) return;
    let n = a.normal;
    if (!n || Math.abs(n.y) > 0.8) {
      const np = nearestOnPoly(a.point.x, a.point.z, info.footprint);
      n = { x: a.point.x - info.center.x, y: 0, z: a.point.z - info.center.z };
      if (np.edge < 2) n = { x: -(a.vel.x), y: 0, z: -(a.vel.z) };
    }
    const nl = Math.hypot(n.x, n.z) || 1;
    n = { x: n.x / nl, y: 0, z: n.z / nl };
    const m = a.mass;
    const vn = Math.max(0, -(a.vel.x * n.x + a.vel.z * n.z));
    const E = Math.max(0.5 * m * vn * vn, (0.6 * a.J * a.J) / (2 * m)) * (a.k ?? 1);
    const fx = this.game.fx;
    if (E < WALL.minJ) return;
    const fb = this.fracturer.get(id);
    if (!fb) {
      if (this.fracturer.prep.defer(id, () => this._impact(id, a))) return;
      this.hitBuilding(id, a.J * BUILDING.impactScale, a.point, { x: -n.x, y: 0, z: -n.z }, 'impact', n);
      return;
    }
    const S = WALL.strength[info.style] ?? 1;
    const r0 = 1.7 + Math.sqrt(E / 200000);
    fb.ensureAround(a.point, Math.min(6, r0 * 2));
    const knocked = [], panes = [];
    for (const { panel: p, d } of fb.panelsNear(a.point, r0 * 2.6)) {
      // the shock travels along the storey: panes above / below need a lot more
      const dg = Math.hypot(p.x - a.point.x, (p.y - a.point.y) * 1.5, p.z - a.point.z);
      const wg = Math.exp(-((dg / (r0 * 1.3)) ** 2));
      if (!p.glass && E * wg >= WALL.glassJ * (p.ground ? 0.6 : 1)) panes.push(p);
      const w = Math.exp(-((d / r0) ** 2));
      const area = Math.max(0.35, (p.w * p.h) / (3.1 * 3.6));
      const dmg = p.dmg + (E * w) / (WALL.panelJ * S * area);
      if (dmg >= 1) knocked.push(p);
      else if (dmg - p.dmg > 0.04) fb.shade(p, dmg);
    }
    const dir = { x: -n.x, y: 0, z: -n.z };
    this._applyPanels(fb, info, knocked, panes, { cause: 'impact', point: a.point, n, E, vel: a.vel, k: Math.min(1.5, E / 120000) });
    // bursting through: a car that knocked out the wall in front of it keeps part of its speed
    if (knocked.length && a.body) {
      let Eabs = 0, through = false;
      for (const p of knocked) {
        Eabs += WALL.panelJ * S * Math.max(0.35, (p.w * p.h) / (3.1 * 3.6));
        if (p.ground && Math.hypot(p.x - a.point.x, p.z - a.point.z) < p.w * 0.8 + 0.6) through = true;
      }
      const keep = clamp(1 - (1.5 * Eabs) / E, 0, WALL.keepVel);
      if (through && keep > 0.05) {
        try {
          a.body.setLinvel({ x: a.vel.x * keep, y: Math.max(-2, a.vel.y * keep), z: a.vel.z * keep }, true);
          const vst = this.sys.byHandle.get(a.body.handle);
          if (vst) vst.suppress = 2;
        } catch { /* body gone */ }
      }
    }
    if (fx) {
      fx.hit(a.point, { normal: n, strength: Math.min(1, E / 150000), material: 'concrete' });
    }
    this.game.events?.emit('building:damaged', { id, position: a.point, size: Math.sqrt(info.area), height: info.height, damage: E / 1000, health: Math.max(0, st.hp / st.maxHp), cause: 'impact' });
    if (knocked.length) this._structure(id, fb, info, dir, Math.min(2, E / 300000));
    const ms = performance.now() - t0;
    this.stats.hits++;
    this.stats.lastHitMs = ms;
    this.stats.maxHitMs = Math.max(this.stats.maxHitMs, ms);
  }

  // knocked-out panels and shattered panes: geometry + debris + glass + dust + sounds
  _applyPanels(fb, info, knocked, panes, o) {
    const fx = this.game.fx;
    const glassStyle = info.style === 2;
    let bursts = 0, sounds = 0;
    for (const p of panes) {
      if (!fb.breakGlass(p)) continue;
      this.stats.panes++;
      if (fx && bursts < (o.cause === 'impact' ? 10 : 14)) {
        bursts++;
        const inward = o.cause === 'impact' ? 0.25 : 0.55;
        glassBurst(fx, { x: p.x + p.nx * 0.05, y: p.y + (p.ground ? -0.3 : 0.1), z: p.z + p.nz * 0.05 }, { x: p.nx, z: p.nz }, p.w * (glassStyle ? 0.9 : 0.62), Math.min(p.h, 3.4) * (p.ground ? 0.72 : 0.55), { k: o.k, inward });
      }
      if (sounds < 3) { sounds++; this._later(0.05 + rnd() * 0.1 + sounds * 0.07, 'impact', { position: { x: p.x, y: p.y, z: p.z }, strength: clamp(0.45 + o.k * 0.4, 0.3, 1), kind: 'window', material: 'glass', source: null }); }
    }
    if (!knocked.length) { fb.flush(); return; }
    for (const p of knocked) fb.knock(p);
    const hang = fb.hanging(knocked);
    fb.flush();
    const all = knocked.concat(hang);
    this.stats.panels += all.length;
    if (!fx) return;
    let boxes = 0;
    const maxBoxes = o.cause === 'impact' ? 14 : 22;
    all.forEach((p, i) => {
      if (glassStyle || !p.glass) {
        if (bursts < 16) { bursts++; glassBurst(fx, { x: p.x, y: p.y, z: p.z }, { x: p.nx, z: p.nz }, p.w * (glassStyle ? 0.9 : 0.6), Math.min(3.4, p.h) * 0.55, { k: o.k, inward: o.cause === 'impact' ? 0.5 : 0.7 }); }
        if (sounds < 3 && (glassStyle || i === 0)) { sounds++; this._later(0.08 + sounds * 0.06, 'impact', { position: { x: p.x, y: p.y, z: p.z }, strength: 0.8, kind: 'window', material: 'glass', source: null }); }
      }
      if (boxes < maxBoxes) boxes += this._panelDebris(fb, p, o, Math.min(3, maxBoxes - boxes), glassStyle, p.region);
      if (i < 6) {
        fx.dust({ x: p.x + p.nx * 0.8, y: p.y - 0.5, z: p.z + p.nz * 0.8 }, 1.1 + Math.min(1.5, o.k), { color: 'concrete', count: 6 + Math.min(10, o.k * 6), speed: 2.5, rise: 0.5 });
        fx.bits({ x: p.x, y: p.y, z: p.z }, { material: 'concrete', count: 8, speed: 4, dir: { x: p.nx, y: 0.2, z: p.nz }, size: 0.15 });
      }
    });
  }

  // a knocked-out panel breaks into a few wall-coloured slabs (non-pinned, recycled debris)
  _panelDebris(fb, p, o, max, glassStyle) {
    const fx = this.game.fx;
    const E = fb.edges[p.e];
    const n = glassStyle ? 1 : Math.min(max, 2 + (rnd() < 0.4 ? 1 : 0));
    if (n <= 0) return 0;
    const tx = -p.nz, tz = p.nx;
    const yaw = Math.atan2(p.nx, p.nz);
    const boxes = [];
    for (let i = 0; i < n; i++) {
      const u = (rnd() - 0.5) * p.w * 0.6, v = (rnd() - 0.5) * Math.min(3.2, p.h) * 0.5;
      _q.setFromAxisAngle(_up, yaw + (rnd() - 0.5) * 0.5);
      const core = rnd() < 0.3;
      const c = core ? [0.36, 0.34, 0.31] : E.col;
      const sh = 0.8 + rnd() * 0.3;
      boxes.push({
        x: p.x + tx * u + p.nx * 0.3, y: Math.max(fb.base + 0.5, p.y + v), z: p.z + tz * u + p.nz * 0.3,
        hx: p.w * (0.14 + rnd() * 0.14), hy: Math.min(3.2, p.h) * (0.12 + rnd() * 0.14), hz: 0.12 + rnd() * 0.08,
        q: { x: _q.x, y: _q.y, z: _q.z, w: _q.w }, color: _c.setRGB(c[0] * sh, c[1] * sh, c[2] * sh).getHex(THREE.LinearSRGBColorSpace),
      });
    }
    const items = fx.debrisSys.spawn(p, { boxes, linearColor: true, impulse: 0, density: 1300, life: 14, spin: 0 });
    for (const it of items) {
      let vx, vy, vz;
      if (o.cause === 'impact') {
        // the wall gives way in front of the car and falls around it
        const s = 0.6 + rnd() * 1.6 + Math.min(4, (o.E || 0) / 80000);
        const toIn = rnd() < 0.55 ? -1 : 0.6;
        vx = p.nx * s * toIn + (o.vel?.x || 0) * 0.25 + (rnd() - 0.5) * 1.5; vy = rnd() * 1.5; vz = p.nz * s * toIn + (o.vel?.z || 0) * 0.25 + (rnd() - 0.5) * 1.5;
      } else {
        // blast: flung away from the explosion (into the building), some spall back out
        const bx = p.x - o.point.x, by = p.y - o.point.y, bz = p.z - o.point.z;
        const bl = Math.hypot(bx, by, bz) || 1;
        const s = (6 + rnd() * 10) * Math.sqrt(o.Pw || 1) * Math.max(0.3, 1 - bl / (o.R || 17));
        const spall = rnd() < 0.35 ? -0.55 : 1;
        vx = (bx / bl) * s * spall + (rnd() - 0.5) * 2; vy = (by / bl) * s * 0.4 + 2 + rnd() * 3; vz = (bz / bl) * s * spall + (rnd() - 0.5) * 2;
      }
      it.body.setLinvel({ x: vx, y: vy, z: vz }, true);
      it.body.setAngvel({ x: (rnd() - 0.5) * 6, y: (rnd() - 0.5) * 4, z: (rnd() - 0.5) * 6 }, true);
    }
    return items.length;
  }

  // ---------- structure: a storey that loses its walls brings everything above it down ----------

  _structure(id, fb, info, dir, power = 1) {
    const st = this._state(id, info);
    if (st.collapsed || st.collapsing || fb.disposed) return;
    const failed = [], storey = new Map();
    for (let k = 0; k < fb.nRegions; k++) {
      if (fb.rec.failed.has(k) || st.pending.has(k)) continue;
      const s = fb.failStorey(k, WALL.support, WALL.sideSupport);
      if (s !== null && s >= 0) { failed.push(k); storey.set(k, s); }
    }
    if (!failed.length) return;
    // interior regions (no walls of their own) fall with most of their neighbours
    for (let k = 0; k < fb.nRegions; k++) {
      if (fb.support(k) !== null || fb.rec.failed.has(k) || st.pending.has(k)) continue;
      const nb = fb.neighbours(k);
      const gone = nb.filter((x) => fb.rec.failed.has(x) || st.pending.has(x) || failed.includes(x)).length;
      if (nb.length && gone >= Math.max(2, nb.length - 1)) failed.push(k);
    }
    const total = fb.rec.failed.size + st.pending.size + failed.length;
    const tower = info.kind === 'tower' || info.height > 40;
    const small = !tower && info.height <= 16 && info.area <= 900;
    const share = total / fb.nRegions;
    const full = fb.nRegions === 1 || small || share >= (tower ? 0.6 : 0.5) || (!tower && power >= 4);
    // where the support went: failed regions off-centre, and the sides that lost their walls
    let wx = 0, wz = 0;
    for (const k of failed) {
      const c = fb.regionCenter(k);
      wx += c.x - info.center.x; wz += c.z - info.center.z;
      const wd = fb.weakDir(k, storey.get(k) ?? 0);
      if (wd) { wx += wd.x * Math.sqrt(info.area) * 0.4; wz += wd.z * Math.sqrt(info.area) * 0.4; }
    }
    const wl = Math.hypot(wx, wz);
    if (full) {
      st.collapsing = true;
      const slender = info.height / Math.max(4, Math.sqrt(info.area)) > 0.85;
      const lopsided = wl > Math.sqrt(info.area) * 0.15;
      const tdir = lopsided ? { x: wx / wl, z: wz / wl } : dir;
      this.stats.collapses++;
      // the lowest storey that gave way is where the building breaks (and the pivot when it topples)
      const sMin = storey.size ? Math.min(...storey.values()) : 0;
      this.collapses.start(fb, { mode: lopsided && slender ? 'topple' : 'pancake', dir: tdir, power, info, pivotY: fb.base + sMin * fb.fh });
    } else {
      for (const k of failed) st.pending.add(k);
      this.stats.collapses++;
      const ev = this.collapses.start(fb, { regions: failed, mode: 'partial', dir, power, info });
      ev.onGo = () => { for (const k of failed) st.pending.delete(k); };
    }
  }

  /**
   * Things mounted on a building go down with it (no floating neon strips, rooftop billboards, blade signs or
   * rooftop postcards). full: the whole building; else only what sits on the failed regions.
   */
  attachmentsFall(fb, full, regions) {
    const game = this.game, fx = game.fx;
    const fell = full ? null : (x, y, z) => regions.includes(fb.regionOf(x, z));
    const gone = game.life?.signage?.detach?.(fb.id, fell) || [];
    let n = 0;
    for (const a of gone) {
      if (!fx || n++ > 10) break;
      fx.sparks({ x: a.x, y: a.y, z: a.z }, { x: 0, y: 0.3, z: 0 }, 10, { speed: 4, spread: 1, color: [2.5, 1.2, 3.2], life: 0.5 });
      fx.debrisSys.spawn({ x: a.x, y: a.y, z: a.z }, { count: 2, size: 0.6, color: [0x2b2b30, 0x45454c], impulse: 3, up: 0.5, life: 10, density: 600 });
    }
    // rooftop postcards drop to the street onto the pile
    const C = game.life?.collectibles;
    if (C?.spots) {
      const r = fb.r;
      let moved = false;
      for (const sp of C.spots) {
        if (sp.y < fb.base + 3 || Math.hypot(sp.x - r.cx, sp.z - r.cz) > fb.size + 6) continue;
        if (fell && !fell(sp.x, sp.y, sp.z)) continue;
        sp.y = (fx?.decals?.groundY?.(sp.x, sp.z, fb.base + 2) ?? fb.base) + 1.6;
        moved = true;
      }
      if (moved) C.rebuild?.();
    }
    game.events?.emit('building:collapse', { id: fb.id, full, regions: full ? null : regions.slice() });
  }

  /** Full collapse (lab / scripted). Uses the fractured path, falls back to the legacy shell of boxes. */
  collapse(id, info, dir = { x: 0, z: 0 }, amount = 50) {
    const st = this._state(id, info);
    if (st.collapsed || st.collapsing) return;
    const fb = this.fracturer.get(id);
    if (!fb) {
      if (this.fracturer.prep.defer(id, () => this.collapse(id, info, dir, amount))) return;
      this._collapseLegacy(id, info, dir, amount); return;
    }
    st.collapsing = true;
    this.stats.collapses++;
    const t0 = performance.now();
    this.collapses.start(fb, { mode: 'pancake', dir, power: amount / 60, info, delay: 0.2 });
    this.stats.lastCollapseMs = performance.now() - t0;
  }

  // ---------- explosions ----------

  onExplosion(pos, Pw, R) {
    const t0 = performance.now();
    const game = this.game;
    const B = game.buildings;
    const Rg = R * WALL.glassR;
    if (B?.query && B.info) {
      const list = [];
      for (const id of B.query(pos.x, pos.z, Rg + 45)) {
        const info = B.info(id);
        if (!info || info.removed) continue;
        const np = nearestOnPoly(pos.x, pos.z, info.footprint);
        const topY = top(info);
        const dy = pos.y > topY ? pos.y - topY : pos.y < info.base ? info.base - pos.y : 0;
        const d = Math.hypot(np.d, dy);
        if (d > Rg) continue;
        list.push([d, id, info, np]);
      }
      list.sort((a, b) => a[0] - b[0]);
      let n = 0;
      for (const [d, id, info, np] of list) {
        const st = this._state(id, info);
        if (st.collapsed) continue;
        if (d <= R) {
          // old-style hit points: big blasts flatten small buildings outright; scorch tint
          const f = Math.pow(1 - d / R, 1.2);
          const amount = BUILDING.explosionDamage * Pw * f;
          st.hp -= amount;
          B.damage?.(id, (amount / st.maxHp) * (st.small ? 0.6 : 0.15)); // overall scorch: big buildings only darken a little
          let nx = pos.x - np.x, nz = pos.z - np.z;
          if (Math.hypot(nx, nz) < 0.01) { nx = pos.x - info.center.x; nz = pos.z - info.center.z; }
          const l = Math.hypot(nx, nz) || 1;
          nx /= l; nz /= l;
          const point = { x: np.x, y: clamp(pos.y, info.base + 1, top(info) - 0.5), z: np.z };
          if (this.fracturer.broken.has(id)) { this.hitBuilding(id, amount, point, { x: -nx, y: 0, z: -nz }, 'explosion', { x: nx, y: 0, z: nz }); continue; }
          this.fracturer.queue(() => this._blast(id, pos, Pw, R, Rg, point, { x: nx, y: 0, z: nz }), id, d / 340);
        } else if (n < 8) {
          this.fracturer.queue(() => this._blast(id, pos, Pw, R, Rg, null, null), id, d / 340);
        }
        n++;
      }
    }
    // trees and bushes
    const veg = game.veg;
    if (veg?.query) {
      let bursts = 0;
      for (const t of veg.query(pos.x, pos.z, R * 0.75)) {
        const raw = veg.scatters?.[t.type]?.raw;
        if (!raw) continue;
        const tx = raw[t.id * 6], ty = raw[t.id * 6 + 1], tz = raw[t.id * 6 + 2];
        const d = Math.hypot(tx - pos.x, tz - pos.z, Math.max(0, ty - pos.y - 2));
        const f = Math.pow(Math.max(0, 1 - d / R), 1.2);
        const J = 32000 * Pw * f;
        const thr = TREE_IMPULSE[t.type] ?? 12000;
        const l = Math.hypot(tx - pos.x, tz - pos.z) || 1;
        const dir = { x: (tx - pos.x) / l, z: (tz - pos.z) / l };
        if (J >= thr) {
          if (veg.breakTree?.(t.type, t.id, dir, clamp(J / thr - 0.4, 0.2, 2.4))) {
            this.stats.trees++;
            if (bursts++ < 6 && game.fx && t.type !== 'reed') game.fx.leaves({ x: tx, y: ty + (TREE_TOP[t.type] ?? 3), z: tz }, { count: 16 });
            game.events?.emit('tree:broken', { position: { x: tx, y: ty, z: tz }, type: t.type, id: t.id });
          }
        } else if (J > thr * 0.35 && bursts++ < 6 && game.fx) {
          game.fx.leaves({ x: tx, y: ty + (TREE_TOP[t.type] ?? 3), z: tz }, { count: 8 });
        }
      }
    }
    // street lamps
    const L = game.lamps;
    if (L?.scatter?.near && L.breakLamp) {
      for (const id of L.scatter.near(pos.x, pos.z, R * 0.6)) {
        if (L.broken?.has(id)) continue;
        const raw = L.scatter.raw;
        const lx = raw[id * 6], ly = raw[id * 6 + 1], lz = raw[id * 6 + 2];
        const l = Math.hypot(lx - pos.x, lz - pos.z) || 1;
        L.breakLamp(game.RAPIER, game.world, game.scene, id, { x: (lx - pos.x) / l, z: (lz - pos.z) / l }, groups(GROUPS.PROP, 0xffff));
        game.events?.emit('lamp:broken', { position: { x: lx, y: ly + 4.25, z: lz }, type: 'lamp', dir: { x: (lx - pos.x) / l, z: (lz - pos.z) / l } });
      }
    }
    // traffic signals
    const TL = game.traffic?.lights;
    if (TL?.colliders && TL.breakLight) {
      const hit = [];
      for (const [key, c] of TL.colliders) {
        let t;
        try { t = c.translation(); } catch { continue; }
        if (Math.hypot(t.x - pos.x, t.z - pos.z) < R * 0.55) hit.push([key, t]);
      }
      for (const [key, t] of hit) {
        const l = Math.hypot(t.x - pos.x, t.z - pos.z) || 1;
        const dir = { x: (t.x - pos.x) / l, z: (t.z - pos.z) / l };
        const at = TL.breakLight(game.RAPIER, game.world, game.scene, key, dir, groups(GROUPS.PROP, 0xffff), this.sys.brokenLampMat);
        if (at) game.events?.emit('lamp:broken', { position: { x: at.x, y: at.y + 3, z: at.z }, type: 'signal', dir });
      }
    }
    // street furniture is thrown by the blast
    game.life?.street?.blast?.(pos, Pw, R * 0.8);
    this.stats.lastBlastMs = performance.now() - t0;
  }

  // one building in a blast (queued; split into one job per storey band so big towers never stall a frame)
  _blast(id, pos, Pw, R, Rg, point, normal) {
    const B = this.game.buildings;
    const info = B.info(id);
    if (!info || info.removed) return;
    const st = this._state(id, info);
    if (st.collapsed || st.collapsing) return;
    const fb = this.fracturer.get(id);
    if (!fb) { this.fracturer.prep.defer(id, () => this._blast(id, pos, Pw, R, Rg, point, normal)); return; }
    const S = WALL.strength[info.style] ?? 1;
    const rs = WALL.blastR * Math.cbrt(Pw);
    const reach = point ? Math.min(R, rs * Math.sqrt(Math.max(0, (Pw * WALL.blastK) / (S * 0.12) - 1))) : 0;
    const y0 = Math.min(pos.y - Math.max(reach, 12), pos.y - 3), y1 = pos.y + Math.max(reach, 12);
    const ctx = { fb, info, pos, Pw, R, Rg, S, rs, knocked: [], panes: [], point: point || pos, normal, n: 0 };
    const a = fb.bandOf(y0), b = fb.bandOf(y1);
    // one job per cell (4 storeys x one region), nearest first: a tower never stalls a frame
    const regs = fb.regionsNear(pos.x, pos.z, Rg);
    const cells = [];
    for (let k = a; k <= b; k++) for (const reg of regs) {
      const c = fb.regionCenter(reg);
      cells.push([Math.hypot(c.x - pos.x, fb.base + (k + 0.5) * fb.BH - pos.y, c.z - pos.z), k, reg]);
    }
    cells.sort((p, q) => p[0] - q[0]);
    for (const [, k, reg] of cells) this.fracturer.queue(() => this._blastCell(ctx, k, reg), id);
    this.fracturer.queue(() => this._blastDone(ctx, id), id);
  }

  _blastCell(ctx, k, reg) {
    const { fb, pos, Pw, R, Rg, S, rs } = ctx;
    if (fb.disposed) return;
    const part = fb.activateCell(k, reg);
    for (const pt of part ? [part] : []) {
      for (const p of pt.panels) {
        if (p.out) continue;
        const dx = p.x - pos.x, dy = p.y - pos.y, dz = p.z - pos.z;
        const d = Math.hypot(dx, dy, dz) || 0.01;
        if (d > Rg) continue;
        const facing = -(p.nx * dx + p.nz * dz) / d; // > 0: the blast is in front of this panel
        if (facing > 0.05 && !p.glass && rnd() < 1.3 * (1 - d / Rg)) ctx.panes.push(p);
        if (d > R || !ctx.normal) continue;
        const shield = facing > 0.05 ? 1 : 0.15;
        const dmg = p.dmg + ((Pw * WALL.blastK) / (1 + (d / rs) ** 2) / S) * shield * Math.sqrt(1 - d / R);
        if (dmg >= 1) ctx.knocked.push(p);
        else if (dmg - p.dmg > 0.05) fb.shade(p, dmg);
      }
    }
  }

  _blastDone(ctx, id) {
    const { fb, info, pos, Pw, R } = ctx;
    if (fb.disposed) return;
    this._applyPanels(fb, info, ctx.knocked, ctx.panes, { cause: 'explosion', point: pos, Pw, R, k: Math.min(1.6, 0.6 + Pw * 0.5) });
    const fx = this.game.fx;
    if (ctx.normal && ctx.knocked.length && fx) {
      // scorched crater rim with radial cracks around the hole
      let mx = 0, my = 0, mz = 0;
      for (const p of ctx.knocked) { mx += p.x; my += p.y; mz += p.z; }
      const k = ctx.knocked.length;
      const c = { x: mx / k, y: my / k, z: mz / k };
      const sz = 3 + Math.sqrt(k) * 3.2;
      fx.wallScorch({ x: c.x, y: c.y, z: c.z }, ctx.normal, sz * 1.1, { kind: 0, heat: 0.8, life: 600 });
    }
    if (ctx.knocked.length) {
      this.game.events?.emit('building:damaged', { id, position: ctx.point, size: Math.sqrt(info.area), height: info.height, damage: Pw * 50, health: 1, cause: 'explosion' });
      this._structure(id, fb, info, { x: -(ctx.normal?.x ?? 0), z: -(ctx.normal?.z ?? 0) }, Pw);
    }
    const st = this._state(id, info);
    // a blast that ate the building's hit points brings a small building down whatever is left standing
    if (st.small && st.hp <= 0 && !st.collapsing && !st.collapsed && !fb.disposed) {
      st.collapsing = true;
      this.stats.collapses++;
      const l = Math.hypot(info.center.x - pos.x, info.center.z - pos.z) || 1;
      this.collapses.start(fb, { mode: 'pancake', dir: { x: (info.center.x - pos.x) / l, z: (info.center.z - pos.z) / l }, power: Pw, info, delay: 0.15 });
    }
  }

  // tank shell into a facade: the blast already ran; add the penetration, a cracked crater rim and spall
  onTankHit(e) {
    if (!e || e.kind !== 'building' || e.remote || !e.position) return;
    const B = this.game.buildings;
    const pos = e.position, dir = e.dir || { x: 0, y: 0, z: 1 };
    let best = null, bd = 3.5;
    for (const id of B.query(pos.x, pos.z, 60)) {
      const info = B.info(id);
      if (!info || info.removed) continue;
      const np = nearestOnPoly(pos.x, pos.z, info.footprint);
      if (np.edge < bd && pos.y < info.top + 1) { bd = np.edge; best = info; }
    }
    if (!best) return;
    const id = best.id;
    const apply = () => {
      const info = B.info(id);
      if (!info || info.removed) return;
      const st = this._state(id, info);
      if (st.collapsed || st.collapsing) return;
      const fb = this.fracturer.get(id);
      if (!fb) { this.fracturer.prep.defer(id, apply); return; }
      fb.ensureAround(pos, 4);
      const dl = Math.hypot(dir.x, dir.z) || 1;
      const n = { x: -dir.x / dl, y: 0, z: -dir.z / dl };
      const knocked = [];
      for (const { panel: p, d } of fb.panelsNear(pos, 2.2, 1)) if (d < 1.9 || rnd() < 0.5) knocked.push(p);
      this._applyPanels(fb, info, knocked, [], { cause: 'explosion', point: { x: pos.x + n.x * 2, y: pos.y, z: pos.z + n.z * 2 }, Pw: 1.6, R: 12, k: 1.4 });
      const fx = this.game.fx;
      if (fx) {
        fx.wallScorch({ x: pos.x, y: pos.y, z: pos.z }, n, 5.5, { kind: 0, heat: 0.9, life: 600 });
        // radial cracks around the crater: the surviving panels around the hole crack in proportion to distance
        for (const { panel: q, d } of fb.panelsNear(pos, 7, 1)) if (!q.out) fb.shade(q, Math.max(q.dmg, Math.min(1, 1.25 - d / 7)));
        // spall + dust jet back out of the hole
        fx.debrisSys.spawn({ x: pos.x + n.x * 0.8, y: pos.y, z: pos.z + n.z * 0.8 }, { count: 6, size: 0.55, color: [info.color ?? 0x9a948a, 0x6b6762, 0x8a8580], impulse: 9, dir: { x: n.x, y: 0.35, z: n.z }, spread: 0.9, up: 0.6, life: 12, spin: 8, density: 1600 });
        fx.dust({ x: pos.x + n.x * 1.5, y: pos.y, z: pos.z + n.z * 1.5 }, 2.6, { color: 'concrete', count: 18, speed: 6, rise: 0.4, spread: 0.6 });
        fx.bits({ x: pos.x, y: pos.y, z: pos.z }, { material: 'concrete', count: 26, speed: 9, dir: { x: n.x, y: 0.3, z: n.z }, size: 0.17 });
      }
      if (knocked.length) this._structure(id, fb, info, { x: dir.x / dl, z: dir.z / dl }, 1.6);
    };
    this.fracturer.queue(apply, id, 0.02);
  }

  // ---------- props ----------

  onPropBroken(e) {
    const fx = this.game.fx;
    if (!fx || !e?.position) return;
    const p = e.position;
    if (e.type === 'hydrant') {
      while (this.jets.length >= MAX_JETS) this.jets.shift();
      this.jets.push(new WaterJet(this.game, { x: p.x, y: p.y - 0.4, z: p.z }, { life: 20 + rnd() * 10, height: 9 + rnd() * 4 }));
      this.game.events?.emit('splash', { position: p, strength: 0.7 });
    } else if (e.type === 'shelter') {
      for (let i = 0; i < 2; i++) glassBurst(fx, { x: p.x + (rnd() - 0.5) * 2, y: p.y + 0.2, z: p.z + (rnd() - 0.5) * 2 }, { x: rnd() - 0.5, z: rnd() - 0.5 }, 1.6, 1.8, { k: 1.2, inward: 0.5 });
      this._later(0.04, 'impact', { position: p, strength: 0.85, kind: 'window', material: 'glass', source: null });
    } else if (e.type === 'meter' || e.type === 'news' || e.type === 'mail' || e.type === 'rack') {
      fx.sparks({ x: p.x, y: p.y - 0.3, z: p.z }, { x: 0, y: 1, z: 0 }, 10, { speed: 4, spread: 0.9, life: 0.5 });
      if (e.type === 'meter') fx.glass({ x: p.x, y: p.y + 0.4, z: p.z }, { x: 0, y: 0.3, z: 0 }, 6);
    }
  }

  // snapped lamp / signal pole: sparks + arc at the base now, glass and sparks where the head lands
  onPoleBroken(e) {
    const fx = this.game.fx;
    if (!fx || !e?.position) return;
    const p = e.position;
    const gy = this.game.terrain?.heightAt?.(p.x, p.z) ?? p.y - 4;
    const dir = e.dir || { x: rnd() - 0.5, z: rnd() - 0.5 };
    poleSnap(fx, { x: p.x, y: Math.max(gy, -1), z: p.z }, dir);
  }

  _poleHeads() {
    const fx = this.game.fx;
    if (!fx) return;
    const scan = (map, half, glass) => {
      if (!map) return;
      for (const b of map.values()) {
        if (!b?.body || b.t > 5 || this.poles.has(b)) continue;
        let t, r;
        try { t = b.body.translation(); r = b.body.rotation(); } catch { continue; }
        _q.set(r.x, r.y, r.z, r.w);
        _p.set(0, half * 0.95, 0).applyQuaternion(_q);
        const hx = t.x + _p.x, hy = t.y + _p.y, hz = t.z + _p.z;
        const gy = this.game.terrain?.heightAt?.(hx, hz) ?? 0;
        if (hy < Math.max(gy, 0) + 1.1 && _p.y < half * 0.6) {
          this.poles.add(b);
          const l = Math.hypot(_p.x, _p.z) || 1;
          poleLand(fx, { x: hx, y: Math.max(gy, 0), z: hz }, { x: _p.x / l, z: _p.z / l }, glass);
          this.game.events?.emit('impact', { position: { x: hx, y: Math.max(gy, 0) + 0.3, z: hz }, strength: 0.55, kind: 'prop', material: 'metal', source: null });
        }
      }
    };
    scan(this.game.lamps?.broken, 4.25, true);
    scan(this.game.traffic?.lights?.broken, 3.0, true);
  }

  _later(delay, name, payload) { this.later.push([(this.game.time ?? 0) + delay, name, payload]); }

  // ---------- per frame ----------

  update(dt) {
    // flush accumulated building hits (one damage application per building per frame)
    for (const [id, a] of this.bAcc) this._impact(id, a);
    this.bAcc.clear();
    this.fracturer.update(dt);
    this.collapses.update(dt);
    // legacy collapses
    this._collapseCd -= dt;
    if (this.collapseQueue.length && this._collapseCd <= 0) {
      const [id, info, dir, amount] = this.collapseQueue.shift();
      this._collapseLegacy(id, info, dir, amount);
      this._collapseCd = 0.12;
    }
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const j = this.jobs[i];
      j.t += dt;
      let settled = j.t > 2.5;
      if (settled && j.t < 8) for (const it of j.items) if (!it.removed && !it.body.isSleeping() && Math.hypot(...Object.values(it.body.linvel())) > 0.25) { settled = false; break; }
      if (settled) { this.jobs.splice(i, 1); this._bakeLegacy(j); }
    }
    // water jets, delayed sounds, falling poles
    if (this.jets.length) this.jets = this.jets.filter((j) => j.update(dt));
    if (this.later.length) {
      const now = this.game.time ?? 0;
      for (let i = this.later.length - 1; i >= 0; i--) {
        const [t, name, payload] = this.later[i];
        if (t > now) continue;
        this.later.splice(i, 1);
        this.game.events?.emit(name, payload);
      }
    }
    this._poleHeads();
    const now = this.game.time;
    if (this.treeAcc.size > 64) for (const [k, a] of this.treeAcc) if (now - a.t > 1) this.treeAcc.delete(k);
  }

  // ---------- legacy path (buildings whose walls could not be captured) ----------

  /** Damage a building (legacy). dir = direction of the hit (into the building). cause: 'impact' | 'explosion'. */
  hitBuilding(id, amount, point, dir, cause = 'impact', normal = null) {
    const B = this.game.buildings;
    if (!B?.info) return;
    const info = B.info(id);
    if (!info || info.removed) return;
    const st = this._state(id, info);
    if (st.collapsed || st.collapsing) return;
    st.hp -= amount;
    B.damage?.(id, amount / st.maxHp);
    const game = this.game;
    const fx = game.fx;
    const size = Math.sqrt(info.area);
    game.events?.emit('building:damaged', { id, position: point, size, height: info.height, damage: amount, health: Math.max(0, st.hp / st.maxHp), cause });
    const nrm = normal || { x: -dir.x, y: 0, z: -dir.z };
    if (fx && cause === 'impact') fx.hit(point, { normal: nrm, strength: Math.min(1, amount / 30), material: 'concrete' });
    if (st.small && st.hp <= 0) {
      st.collapsed = true; // queued: several collapses in one blast are spread over frames
      this.collapseQueue.push([id, info, dir, amount]);
      return;
    }
    if (amount > 6 && game.time - st.lastFx > 0.25) {
      st.lastFx = game.time;
      this.facadeChunks(info, point, nrm, amount, cause);
    }
  }

  // legacy fracture: any storey (not only the ground one) with less than WALL.support of its panels left
  _legacyStoreyLost(B, info) {
    const f = B.recs?.[info.id]?.frac;
    if (!f || f.external || !Array.isArray(f.panels)) return false;
    const n = new Map(), out = new Map();
    for (const q of f.panels) {
      const k = Math.max(0, Math.floor((q.y - info.base) / 3.6));
      n.set(k, (n.get(k) || 0) + 1);
      if (q.out) out.set(k, (out.get(k) || 0) + 1);
    }
    for (const [k, o] of out) if ((n.get(k) || 0) >= 3 && 1 - o / n.get(k) < WALL.support) return true;
    return false;
  }

  // chunks falling off a facade around `point` (legacy)
  facadeChunks(info, point, normal, amount, cause) {
    const B = this.game.buildings;
    const rad = clamp(1.2 + amount / 14, 1.6, cause === 'explosion' ? 6.5 : 4.2);
    if (B?.punch && !B.recs?.[info.id]?.frac?.external) {
      const gone = B.punch(info.id, point, rad);
      const st = this._state(info.id, info);
      if (!st.collapsed && (B.supportLost?.(info.id) || this._legacyStoreyLost(B, info))) {
        st.collapsed = true;
        this.collapseQueue.push([info.id, info, { x: -normal.x, y: 0, z: -normal.z }, Math.max(amount, 80)]);
      }
      const fx2 = this.game.fx;
      if (fx2) for (const q of gone.slice(0, 10)) fx2.debris?.({ x: q.x + q.nx * 0.4, y: q.y, z: q.z + q.nz * 0.4 }, { count: 1, size: Math.min(1.6, Math.max(q.w, q.h) * 0.45), color: info.color, impulse: 3 + amount / 20 });
    } else B?.addHole?.(point, rad);
    const fx = this.game.fx;
    if (!fx) return;
    const nl = Math.hypot(normal.x, normal.z) || 1;
    const nx = normal.x / nl, nz = normal.z / nl;
    const tx = -nz, tz = nx;
    const n = clamp(Math.round(amount / 12), 2, 7);
    const y0 = info.base + 0.6, y1 = info.base + Math.max(3, info.height) - 0.4;
    const py = clamp(point.y, y0, y1);
    _c.setHex(info.color ?? 0xb0aaa0, THREE.LinearSRGBColorSpace);
    const wall = _c.getHex(THREE.LinearSRGBColorSpace);
    const boxes = [];
    for (let i = 0; i < n; i++) {
      const s = 0.45 + rnd() * 0.8 * Math.min(1.6, amount / 40);
      const u = (rnd() - 0.5) * 3, v = (rnd() - 0.5) * 2.5;
      boxes.push({
        x: point.x + nx * 0.7 + tx * u, y: clamp(py + v, y0, y1), z: point.z + nz * 0.7 + tz * u,
        hx: s * (0.5 + rnd() * 0.5) / 2, hy: s * (0.3 + rnd() * 0.4) / 2, hz: s * (0.5 + rnd() * 0.5) / 2, color: i % 3 ? wall : 0x8a8680,
      });
    }
    fx.debrisSys.spawn(point, { boxes, linearColor: true, impulse: 3 + Math.min(5, amount / 25), dir: { x: nx, y: 0.1, z: nz }, spread: 0.8, up: 0.3, density: 1100, life: 14, spin: 5 });
    const dp = { x: point.x + nx * 0.8, y: py, z: point.z + nz * 0.8 };
    fx.dust(dp, 1 + Math.min(2.5, amount / 40), { color: 'concrete', count: 6 + Math.min(14, amount / 8) });
    fx.bits(dp, { material: 'concrete', count: 10 + Math.min(20, amount / 6), speed: 4, dir: { x: nx, y: 0.2, z: nz }, size: 0.16 });
    if (cause === 'explosion') fx.wallScorch({ x: point.x, y: py, z: point.z }, { x: nx, z: nz }, 3 + Math.min(5, amount / 50), { kind: amount > 70 ? 1 : 0, heat: 0.8 });
  }

  /** Legacy full collapse of a small building: hollow shell of chunks, dust, then a static rubble pile. */
  _collapseLegacy(id, info, dir = { x: 0, z: 0 }, amount = 50) {
    const t0 = performance.now();
    const game = this.game;
    const fx = game.fx;
    const st = this._state(id, info);
    st.collapsed = true;
    game.buildings.remove?.(id);
    game.life?.signage?.detach?.(id); // mounted signs come down too
    const poly = info.footprint;
    const cx = info.center.x, cz = info.center.z;
    let bestL = 0, ux = 1, uz = 0;
    for (let i = 0; i < poly.length; i++) {
      const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
      const L = Math.hypot(bx - ax, bz - az);
      if (L > bestL) { bestL = L; ux = (bx - ax) / L; uz = (bz - az) / L; }
    }
    const vx = -uz, vz = ux;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of poly) {
      const u = (x - cx) * ux + (z - cz) * uz, v = (x - cx) * vx + (z - cz) * vz;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const Lu = u1 - u0, Lv = v1 - v0;
    const H = Math.max(3, info.height);
    const base = info.base;
    let nu = clamp(Math.round(Lu / 2.2), 2, 6);
    let nv = clamp(Math.round(Lv / 2.2), 2, 6);
    let ny = clamp(Math.round(H / 1.9), 1, 5);
    const active = fx?.debrisSys.items.filter((it) => it.keep).length ?? 0;
    const budget = Math.max(8, Math.min(MAX_CHUNKS, MAX_ACTIVE_CHUNKS - active));
    const count = () => (2 * (nu + nv) - 4) * ny + nu * nv;
    while (count() > budget) {
      if (ny > 1 && ny >= Math.max(nu, nv) - 1) ny--;
      else if (nu >= nv && nu > 2) nu--;
      else if (nv > 2) nv--;
      else if (ny > 1) ny--;
      else break;
    }
    const yaw = Math.atan2(-uz, ux);
    const qBase = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    _c.setHex(info.color ?? 0xd8cfc0, THREE.LinearSRGBColorSpace);
    const wall = _c.clone();
    const roof = info.kind === 'house' ? new THREE.Color().setHex(0x7a2e1c, THREE.LinearSRGBColorSpace) : wall.clone().multiplyScalar(0.72);
    const T = 0.22;
    const cu = Lu / nu, cv = Lv / nv, ch = H / ny;
    const boxes = [];
    const tipAxes = [];
    const put = (u, v, y, hu, hy, hv, col, tip) => {
      const x = cx + ux * u + vx * v, z = cz + uz * u + vz * v;
      if (!pointInPoly(x - (ux * Math.sign(u) + vx * Math.sign(v)) * 0.3, z - (uz * Math.sign(u) + vz * Math.sign(v)) * 0.3, poly) && !pointInPoly(x, z, poly)) return;
      const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.04, 0, (rnd() - 0.5) * 0.04));
      const q = qBase.clone().multiply(tilt);
      boxes.push({ x, y, z, hx: hu, hy, hz: hv, q: { x: q.x, y: q.y, z: q.z, w: q.w }, color: col.clone().multiplyScalar(0.82 + rnd() * 0.3).getHex(THREE.LinearSRGBColorSpace) });
      tipAxes.push(tip);
    };
    for (let iy = 0; iy < ny; iy++) {
      const y = base + (iy + 0.5) * ch + 0.04;
      const hy = (ch / 2) * 0.94;
      for (let iu = 0; iu < nu; iu++) {
        for (let iv = 0; iv < nv; iv++) {
          const eu = iu === 0 || iu === nu - 1, ev = iv === 0 || iv === nv - 1;
          if (!eu && !ev) continue;
          if (iy === 0 && ny > 1 && rnd() < 0.3) continue;
          const u = u0 + (iu + 0.5) * cu, v = v0 + (iv + 0.5) * cv;
          const alongV = eu && (!ev || rnd() < 0.5);
          const pu = alongV ? (iu === 0 ? u0 + T : u1 - T) : u;
          const pv = !alongV ? (iv === 0 ? v0 + T : v1 - T) : v;
          const hu = alongV ? T : (cu / 2) * 0.95, hv = !alongV ? T : (cv / 2) * 0.95;
          const tip = alongV ? { x: vx, z: vz } : { x: ux, z: uz };
          put(pu, pv, y, hu, hy, hv, wall, tip);
        }
      }
    }
    for (let iu = 0; iu < nu; iu++) for (let iv = 0; iv < nv; iv++) put(u0 + (iu + 0.5) * cu, v0 + (iv + 0.5) * cv, base + H + 0.2, (cu / 2) * 0.96, 0.18, (cv / 2) * 0.96, roof, null);
    const center = new THREE.Vector3(cx, base + H / 2, cz);
    let items = [];
    if (fx && boxes.length) {
      items = fx.debrisSys.spawn(center, { boxes, keep: true, linearColor: true, impulse: 0, spin: 0, density: 500, groups: this.chunkGroups });
      const dl = Math.hypot(dir.x, dir.z) || 1;
      const push = 1.2 + Math.min(6, amount / 40);
      items.forEach((it, i) => {
        const t = it.body.translation();
        const rx = t.x - cx, rz = t.z - cz;
        const rl = Math.hypot(rx, rz) || 1;
        const hf = (t.y - base) / H;
        const out = 0.3 + rnd() * 1.2;
        it.body.setLinvel({ x: (rx / rl) * out + (dir.x / dl) * push * (0.5 + hf * 0.7) + (rnd() - 0.5) * 0.6, y: rnd() * 0.8 - hf * 0.8, z: (rz / rl) * out + (dir.z / dl) * push * (0.5 + hf * 0.7) + (rnd() - 0.5) * 0.6 }, true);
        const tip = tipAxes[i];
        if (tip) {
          const sgn = Math.sign((rx * -tip.z + rz * tip.x) || 1) * (rnd() < 0.25 ? -1 : 1);
          const w = (1.2 + rnd() * 1.8) * sgn;
          it.body.setAngvel({ x: tip.x * w, y: (rnd() - 0.5) * 0.6, z: tip.z * w }, true);
        } else it.body.setAngvel({ x: (rnd() - 0.5) * 1.6, y: (rnd() - 0.5) * 0.6, z: (rnd() - 0.5) * 1.6 }, true);
      });
    }
    if (fx) {
      const ground = { x: cx, y: base + 1.2, z: cz };
      const sz = Math.sqrt(info.area);
      fx.smoke(ground, { color: 'concrete', rate: 22, size: 1.6 + sz * 0.12, duration: 2.6, density: 1.1 });
      fx.dust(ground, sz * 0.55, { color: 'concrete', count: 26, speed: 4, rise: 1.2, spread: 0.7 });
      fx.bits({ x: cx, y: base + H * 0.6, z: cz }, { material: 'concrete', count: 40, speed: 7, size: 0.2, life: 5 });
      fx.addShake(0.7 * Math.max(0, 1 - center.distanceTo(game.camera.position) / 90));
    }
    this.jobs.push({ id, items, t: 0, info });
    this.stats.collapses++;
    const size = Math.sqrt(info.area);
    game.events?.emit('building:destroyed', { id, position: { x: cx, y: base, z: cz }, size, height: H, area: info.area });
    game.events?.emit('impact', { position: { x: cx, y: base + 1, z: cz }, strength: 1, kind: 'building', material: 'concrete', source: null });
    this.stats.lastCollapseMs = performance.now() - t0;
  }

  _bakeLegacy(job) {
    const t0 = performance.now();
    const { RAPIER, world, scene } = this.game;
    const fx = this.game.fx;
    const info = job.info;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const list = [];
    for (const it of job.items) {
      if (it.removed) continue;
      const t = it.body.translation(), r = it.body.rotation();
      if (t.y > info.base - 6) list.push([it.hx, it.hy, it.hz, { x: t.x, y: t.y, z: t.z }, { x: r.x, y: r.y, z: r.z, w: r.w }, it.r, it.g, it.b, true]);
      fx?.debrisSys.remove(it);
    }
    const pos = new Float32Array(list.length * 108), col = new Float32Array(list.length * 108);
    let o = 0;
    for (const [hx, hy, hz, t, r, cr, cg, cb, collide] of list) {
      _q.set(r.x, r.y, r.z, r.w);
      for (let v = 0; v < 36; v++) {
        _p.set(BOX[v * 3] * hx, BOX[v * 3 + 1] * hy, BOX[v * 3 + 2] * hz).applyQuaternion(_q);
        pos[o] = _p.x + t.x; pos[o + 1] = _p.y + t.y; pos[o + 2] = _p.z + t.z;
        col[o] = cr; col[o + 1] = cg; col[o + 2] = cb;
        o += 3;
      }
      if (collide) world.createCollider(RAPIER.ColliderDesc.cuboid(hx, Math.min(hy, 0.3), hz).setTranslation(t.x, t.y, t.z).setRotation(r).setFriction(0.9).setCollisionGroups(this.staticGroups), body);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.rubbleMat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = `rubble:${job.id}`;
    scene.add(mesh);
    this.legacyRubble.push({ mesh, body, x: info.center.x, z: info.center.z, id: job.id });
    while (this.legacyRubble.length > MAX_RUBBLE) {
      const r = this.legacyRubble.shift();
      r.mesh.removeFromParent(); r.mesh.geometry.dispose();
      try { world.removeRigidBody(r.body); } catch { /* gone */ }
    }
    this.stats.lastBakeMs = performance.now() - t0;
  }

  clear() {
    for (const r of this.legacyRubble) { r.mesh.removeFromParent(); r.mesh.geometry.dispose(); try { this.game.world.removeRigidBody(r.body); } catch { /* gone */ } }
    this.legacyRubble.length = 0;
    this.jobs.length = 0;
    this.collapses.clear();
    this.jets.length = 0;
    this.later.length = 0;
  }

  dispose() {
    for (const off of this._offs) off?.();
    this.clear();
    this.fracturer.clear();
    this.rubbleMat.dispose();
  }
}

function top(info) { return info.base + Math.max(3, info.height); }
