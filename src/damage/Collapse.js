import * as THREE from 'three';
import { GROUPS, groups } from '../vehicle/groups.js';
import { DustCloud } from './DestructionFX.js';
import { floorH } from './Fracture.js';

// Structural collapses: the failing part of a fractured building is cut into big rigid blocks that keep the real
// facade (windows and all), fall, and shatter into rubble boxes when they hit the ground; the settled rubble is baked
// into a static pile (one mesh, a drivable mound + a few flat box colliders) that persists for the session.
//
// Budgets: <= MAX_BLOCKS falling blocks, <= MAX_KEEP pinned debris boxes (oldest pile is frozen early when full),
// block geometry is prepared over a few frames before the collapse starts (short "creak" with dust at the base).

export const COLLAPSE = { MAX_BLOCKS: 24, MAX_KEEP: 180, MAX_LIVE_RUBBLE: 40, MAX_RECORDS: 400, blockDensity: 85, prepMs: 1.2 };
const BOX = (() => {
  const g = new THREE.BoxGeometry(2, 2, 2).toNonIndexed();
  const a = Float32Array.from(g.attributes.position.array);
  g.dispose();
  return a;
})();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const rnd = Math.random;
const STRIDE = 13; // rubble box: hx hy hz  x y z  qx qy qz qw  r g b

export class Collapses {
  constructor(destruction) {
    this.d = destruction;
    this.game = destruction.game;
    this.events = []; // collapses being prepared / running
    this.spawnQ = []; // prepared blocks waiting for their frame
    this.crushQ = []; // landed blocks whose vehicles underneath still have to be crushed
    this.loadQ = []; // baked piles waiting for their mesh + colliders
    this.blocks = [];
    this.jobs = []; // settling debris -> rubble
    this.records = []; // rubble piles (live or hibernating)
    this.dust = [];
    this.blockGroups = groups(GROUPS.PROP, GROUPS.GROUND | GROUPS.PROP);
    this.debrisGroups = groups(GROUPS.PROP, 0xffff & ~GROUPS.STATIC);
    this.staticGroups = groups(GROUPS.STATIC, 0xffff);
    this._hib = 0;
    this.stats = { started: 0, blocks: 0, shattered: 0, baked: 0, lastStartMs: 0, lastPrepMs: 0, maxPrepMs: 0, lastBakeMs: 0, frozen: 0 };
  }

  get rubbleMat() { return this.d.rubbleMat; }

  keepCount() {
    let n = 0;
    for (const it of this.game.fx?.debrisSys.items || []) if (it.keep) n++;
    return n;
  }

  /**
   * Start a collapse. fb: FracturedBuilding. o: { regions: [k] | null (whole building), mode: 'partial'|'pancake'|'topple',
   * dir {x,z} (topple / push direction), power, info }.
   */
  start(fb, o = {}) {
    const t0 = performance.now();
    const full = !o.regions;
    const H = fb.top - fb.base;
    const fh = floorH(fb.style);
    // rects: failing regions, or the whole building cut into ~6-9 m cells
    const rects = [];
    if (full) {
      const R = fb.rect(-1);
      const nu = THREE.MathUtils.clamp(Math.round((R.uB - R.uA) / 8), 1, 3), nv = THREE.MathUtils.clamp(Math.round((R.vB - R.vA) / 8), 1, 3);
      for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
        rects.push({ uA: R.uA + ((R.uB - R.uA) * i) / nu, uB: R.uA + ((R.uB - R.uA) * (i + 1)) / nu, vA: R.vA + ((R.vB - R.vA) * j) / nv, vB: R.vA + ((R.vB - R.vA) * (j + 1)) / nv });
      }
    } else for (const k of o.regions) rects.push(fb.rect(k));
    // vertical groups: the ground storey crumbles, above it blocks of 2..6 storeys (fewer, taller ones for towers)
    const g0 = fb.base + fh;
    const maxGroups = Math.max(1, Math.min(8, Math.floor(COLLAPSE.MAX_BLOCKS / rects.length)));
    const span = Math.max(0, fb.top - g0);
    const per = Math.max(2, Math.ceil(span / fh / maxGroups), H > 40 ? 0 : 2);
    const cuts = [g0];
    for (let y = g0 + per * fh; y < fb.top - fh * 0.6; y += per * fh) cuts.push(y);
    cuts.push(fb.top + 30); // everything above (crowns, antennas) rides on the top block
    const specs = [];
    for (const R of rects) {
      if (span > 0.5) {
        specs.push({ R, yA: fb.base - 2.5, yB: g0, crumble: true });
        for (let i = 0; i < cuts.length - 1; i++) specs.push({ R, yA: cuts[i], yB: cuts[i + 1], crumble: false });
      } else {
        // single storey: the walls buckle and the roof comes down on them
        specs.push({ R, yA: fb.base - 2.5, yB: fb.base + 0.8, crumble: true });
        specs.push({ R, yA: fb.base + 0.8, yB: fb.top + 30, crumble: false });
      }
    }
    const info = o.info || this.game.buildings.info(fb.id);
    const ev = {
      fb, id: fb.id, full, specs, built: [], next: 0, phase: 'prep', t: 0, delay: o.delay ?? (full ? 0.35 : 0.5) + Math.min(0.5, H / 120),
      mode: o.mode || (full ? 'pancake' : 'partial'), dir: o.dir || { x: 0, z: 0 }, power: o.power ?? 1, info, regions: o.regions, pivotY: o.pivotY,
      center: full ? { x: info.center.x, z: info.center.z } : null,
    };
    if (!full) {
      let x = 0, z = 0;
      for (const k of o.regions) { const c = fb.regionCenter(k); x += c.x; z += c.z; }
      ev.center = { x: x / o.regions.length, z: z / o.regions.length };
    }
    this.events.push(ev);
    this.stats.started++;
    // the creak: dust and grit bursting out of the ground storey, a low rumble
    const fx = this.game.fx;
    if (fx) {
      for (const R of rects) {
        const [x, z] = fb.toXZ((R.uA + R.uB) / 2, (R.vA + R.vB) / 2);
        fx.dust({ x, y: fb.base + 1.2, z }, 2 + Math.min(5, (R.uB - R.uA) * 0.3), { color: 'concrete', count: 10, speed: 3.5, rise: 0.5 });
        fx.bits({ x, y: fb.base + 2.5, z }, { material: 'concrete', count: 12, speed: 3, size: 0.16 });
      }
      const d = Math.hypot(ev.center.x - this.game.camera.position.x, ev.center.z - this.game.camera.position.z);
      fx.addShake(0.25 * Math.max(0, 1 - d / 120));
    }
    this.game.events?.emit('impact', { position: { x: ev.center.x, y: fb.base + 1, z: ev.center.z }, strength: 0.6, kind: 'building', material: 'concrete', source: null });
    this.stats.lastStartMs = performance.now() - t0;
    return ev;
  }

  _prep(ev, budgetEnd) {
    while (ev.next < ev.specs.length && performance.now() < budgetEnd) {
      const s = ev.specs[ev.next++];
      let blk = null;
      try { blk = ev.fb.blockGeometry(s.R, s.yA, s.yB); } catch (e) { console.warn('[collapse] block', e); }
      if (blk) ev.built.push({ ...blk, crumble: s.crumble, yA: s.yA, yB: s.yB });
    }
    return ev.next >= ev.specs.length;
  }

  _go(ev) {
    const t0 = performance.now();
    try { this._go2(ev); } finally {
      this.stats.lastGoMs = performance.now() - t0;
      if (this.stats.lastGoMs > (this.stats.maxGoMs || 0)) { this.stats.maxGoMs = this.stats.lastGoMs; this.stats.maxGoSplit = { ...this.stats.goSplit, full: ev.full, built: ev.built.length }; }
    }
  }

  _go2(ev) {
    const T = (this.stats.goSplit = {});
    let tm = performance.now();
    const lap = (k) => { const n = performance.now(); T[k] = +(n - tm).toFixed(2); tm = n; };
    this._lap = lap;
    const game = this.game, fx = game.fx, fb = ev.fb;
    const B = game.buildings;
    const H = fb.top - fb.base;
    if (fb.disposed && !ev.full) { for (const b of ev.built) b.geometry.dispose(); ev.onGo?.(); return; } // the whole building went meanwhile
    // the standing structure loses the failed part only once all of its blocks exist (spawned over a few frames):
    // the blocks are exact copies, so there is never a frame where part of the building is missing
    const finish = () => {
      if (ev.finished) return;
      ev.finished = true;
      this.d.attachmentsFall?.(fb, ev.full, ev.regions || []);
      if (ev.full) {
        const st = this.d._state(ev.id, ev.info);
        st.collapsed = true;
        B.remove(ev.id); // disposes the fractured meshes + colliders
      } else if (!fb.disposed) fb.failRegions(ev.regions);
      ev.onGo?.(); // regions are now in the failed set: release their pending mark
    };
    if (ev.full) this.d._state(ev.id, ev.info).collapsed = true; // no more hits on it meanwhile
    lap('attach');
    const job = { id: ev.id, items: [], t: 0, blocks: 0, center: ev.center, base: fb.base, info: ev.info, area: ev.info?.area ?? 100, col: null, size: Math.sqrt(ev.info?.area ?? 100), H };
    this.jobs.push(job);
    const dirL = Math.hypot(ev.dir.x, ev.dir.z) || 1;
    const dir = { x: ev.dir.x / dirL, z: ev.dir.z / dirL };
    // ground storey crumbles now, the blocks above start falling over the next frames (<= 3 per frame), bottom first
    // queue: falling blocks (bottom first), then the swap (remove the standing part), then the ground storey crumbles
    ev.built.sort((p, q) => p.pos.y - q.pos.y);
    for (const b of ev.built) job.col = job.col || b.col;
    for (const b of ev.built) if (!b.crumble) { job.blocks++; this.spawnQ.push({ b, ev, job, dir, H }); }
    job.blocks++;
    this.spawnQ.push({ finish, job });
    for (const b of ev.built) if (b.crumble) { job.blocks++; this.spawnQ.push({ b, ev, job, dir, H, crumble: true }); }
    lap('remove');
    // dust: base burst now, the big rolling cloud as it comes down
    const size = Math.sqrt(Math.max(30, ev.full ? job.area : job.area / Math.max(1, fb.nRegions)));
    const ground = fx?.decals?.groundY?.(ev.center.x, ev.center.z, fb.base + 2) ?? fb.base;
    this.dust.push(new DustCloud(game, { x: ev.center.x, y: ground, z: ev.center.z }, { size, power: Math.min(3, 0.6 + H / 25), exclude: ev.id, dur: 1.2 + Math.min(1.6, H / 60), ground }));
    lap('dust');
    if (fx) {
      const d = Math.hypot(ev.center.x - game.camera.position.x, ev.center.z - game.camera.position.z);
      fx.addShake(Math.min(1.2, 0.5 + H / 80) * Math.max(0, 1 - d / (90 + H)));
      fx.bits({ x: ev.center.x, y: fb.base + Math.min(H, 12) * 0.6, z: ev.center.z }, { material: 'concrete', count: 40, speed: 7, size: 0.2, life: 5 });
    }
    game.events?.emit('building:destroyed', { id: ev.id, position: { x: ev.center.x, y: fb.base, z: ev.center.z }, size, height: H, area: job.area, partial: !ev.full });
    game.events?.emit('impact', { position: { x: ev.center.x, y: fb.base + 1, z: ev.center.z }, strength: 1, kind: 'building', material: 'concrete', source: null });
  }

  _spawnBlock(b, ev, job, dir, H) {
    const { RAPIER, world, scene } = this.game;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(b.pos.x, b.pos.y, b.pos.z).setRotation(b.quat)
      .setLinearDamping(0.05).setAngularDamping(0.25).setCcdEnabled(true));
    world.createCollider(RAPIER.ColliderDesc.cuboid(b.half.x, b.half.y, b.half.z).setDensity(COLLAPSE.blockDensity).setFriction(0.8).setRestitution(0)
      .setCollisionGroups(this.blockGroups), body);
    const mesh = new THREE.Mesh(b.geometry, this.d.fracturer.material());
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.position.set(b.pos.x, b.pos.y, b.pos.z);
    mesh.quaternion.set(b.quat.x, b.quat.y, b.quat.z, b.quat.w);
    scene.add(mesh);
    // initial motion
    const hc = Math.max(1, b.pos.y - (ev.pivotY ?? ev.fb.base));
    const cx = ev.center.x, cz = ev.center.z;
    let ox = b.pos.x - cx, oz = b.pos.z - cz;
    const ol = Math.hypot(ox, oz) || 1;
    ox /= ol; oz /= ol;
    if (ev.mode === 'topple') {
      const w = (0.35 + rnd() * 0.2) * Math.min(1.6, 22 / Math.max(8, H));
      body.setAngvel({ x: dir.z * w, y: (rnd() - 0.5) * 0.1, z: -dir.x * w }, true);
      body.setLinvel({ x: dir.x * w * hc * 0.6, y: -0.5, z: dir.z * w * hc * 0.6 }, true);
    } else if (ev.mode === 'partial') {
      // the cut-off part leans away from the rest of the building as it drops
      let px = ev.full ? ox : ev.center.x - ev.fb.r.cx, pz = ev.full ? oz : ev.center.z - ev.fb.r.cz;
      const pl = Math.hypot(px, pz) || 1;
      px /= pl; pz /= pl;
      const w = 0.12 + rnd() * 0.18;
      body.setAngvel({ x: pz * w, y: (rnd() - 0.5) * 0.08, z: -px * w }, true);
      body.setLinvel({ x: px * (0.4 + rnd() * 0.6), y: -0.8, z: pz * (0.4 + rnd() * 0.6) }, true);
    } else {
      // pancake: straight down, a little twist, outer cells fold outwards
      const w = 0.06 + rnd() * 0.14;
      body.setAngvel({ x: oz * w, y: (rnd() - 0.5) * 0.12, z: -ox * w }, true);
      body.setLinvel({ x: ox * 0.3, y: -1.2, z: oz * 0.3 }, true);
    }
    const gy = this.game.fx?.decals?.groundY?.(b.pos.x, b.pos.z, ev.fb.base + 2) ?? ev.fb.base;
    this.blocks.push({ body, mesh, half: b.half, col: b.col, vol: b.vol, job, age: 0, vyPrev: 0, ground: gy, minY: b.pos.y, id: ev.id });
    this.stats.blocks++;
  }

  // a block (or the crushed ground storey) turns into pinned debris boxes
  _crumble(b, job, vel = null, rot = b.quat) {
    const fx = this.game.fx;
    if (!fx) return;
    let room = COLLAPSE.MAX_KEEP - this.keepCount();
    if (room < 4) { this._freezeOldest(job); room = COLLAPSE.MAX_KEEP - this.keepCount(); }
    const n = Math.max(2, Math.min(room, Math.round(THREE.MathUtils.clamp(b.vol / 20, 5, 18))));
    _q.set(rot.x, rot.y, rot.z, rot.w);
    const boxes = [];
    const col = b.col || [0.6, 0.58, 0.55];
    for (let i = 0; i < n; i++) {
      // a couple of big wall slabs (facade colour), the rest broken concrete chunks
      const slab = i < 2;
      const hx = slab ? Math.min(b.half.x, 1.0 + rnd() * 0.7) : 0.3 + rnd() * 0.55;
      const hz = slab ? Math.min(b.half.z, 0.8 + rnd() * 0.6) : 0.3 + rnd() * 0.55;
      const hy = slab ? 0.13 + rnd() * 0.07 : 0.16 + rnd() * 0.26;
      _p.set((rnd() * 2 - 1) * Math.max(0, b.half.x - hx), (rnd() * 1.2 - 1) * b.half.y * 0.8, (rnd() * 2 - 1) * Math.max(0, b.half.z - hz)).applyQuaternion(_q);
      _q2.copy(_q).multiply(new THREE.Quaternion().setFromEuler(_e.set((rnd() - 0.5) * 0.35, rnd() * 6.28, (rnd() - 0.5) * 0.35)));
      const pick = slab ? 0 : rnd();
      const c = pick < 0.5 ? col : pick < 0.8 ? [0.3, 0.29, 0.27] : [0.42, 0.4, 0.37];
      const sh = 0.75 + rnd() * 0.35;
      boxes.push({
        x: b.pos.x + _p.x, y: Math.max(b.pos.y + _p.y, job.base + hy + 0.15), z: b.pos.z + _p.z, hx, hy, hz, q: { x: _q2.x, y: _q2.y, z: _q2.z, w: _q2.w },
        color: new THREE.Color(c[0] * sh, c[1] * sh, c[2] * sh).getHex(THREE.LinearSRGBColorSpace),
      });
    }
    const items = fx.debrisSys.spawn(b.pos, { boxes, keep: true, linearColor: true, impulse: 0, spin: 0, density: 650, groups: this.debrisGroups });
    for (const it of items) {
      const v = vel || { x: 0, y: 0, z: 0 };
      it.body.setLinvel({ x: v.x * 0.35 + (rnd() - 0.5) * 3, y: Math.max(-4, v.y * 0.2) + rnd() * 2, z: v.z * 0.35 + (rnd() - 0.5) * 3 }, true);
      it.body.setAngvel({ x: (rnd() - 0.5) * 1.4, y: (rnd() - 0.5) * 1.5, z: (rnd() - 0.5) * 1.4 }, true);
      job.items.push(it);
    }
  }

  _shatter(blk) {
    const game = this.game, fx = game.fx;
    const t = blk.body.translation(), r = blk.body.rotation(), v = blk.body.linvel();
    const pos = { x: t.x, y: t.y, z: t.z };
    try { game.world.removeRigidBody(blk.body); } catch { /* gone */ }
    blk.mesh.removeFromParent();
    blk.mesh.geometry.dispose();
    blk.dead = true;
    this.stats.shattered++;
    this._crumble({ pos, quat: { x: r.x, y: r.y, z: r.z, w: r.w }, half: blk.half, col: blk.col, vol: blk.vol }, blk.job, v);
    const sz = Math.sqrt(blk.half.x * blk.half.z) * 2;
    const bot = { x: t.x, y: Math.max(blk.ground + 0.3, t.y - blk.half.y), z: t.z };
    if (fx) {
      fx.dust(bot, 1.5 + sz * 0.6, { color: 'concrete', count: 14 + Math.min(20, sz * 2), speed: 4 + sz * 0.3, rise: 0.7, spread: 0.9 });
      fx.bits({ x: t.x, y: bot.y + 1, z: t.z }, { material: 'concrete', count: 18, speed: 6, size: 0.18, life: 4 });
      if (blk.vol > 300) this.dust.push(new DustCloud(game, { x: t.x, y: blk.ground, z: t.z }, { size: sz, power: Math.min(2, blk.vol / 900), exclude: blk.id, dur: 0.9, ground: blk.ground, column: 0.4 }));
      const d = Math.hypot(t.x - game.camera.position.x, t.z - game.camera.position.z);
      fx.addShake(Math.min(0.6, blk.vol / 1500) * Math.max(0, 1 - d / 100));
    }
    game.events?.emit('impact', { position: bot, strength: Math.min(1, 0.5 + blk.vol / 600), kind: 'building', material: 'concrete', source: null });
    // vehicles underneath get crushed on the next frame (dents are expensive; never in the same frame as the shatter)
    this.crushQ.push([{ half: blk.half, vol: blk.vol }, { x: t.x, y: t.y, z: t.z }]);
  }

  // vehicles caught under a landing block get flattened (dents through the damage system) and pushed down
  _crush(blk, t) {
    const sys = this.d.sys;
    const rad = Math.max(blk.half.x, blk.half.z) + 0.8;
    const bot = t.y - blk.half.y;
    for (const st of sys.vehicles) {
      const b = st.v?.body;
      if (!b || st.disposed) continue;
      const p = b.translation();
      if (Math.hypot(p.x - t.x, p.z - t.z) > rad || p.y > bot + 2.5 || p.y < bot - 4) continue;
      try {
        st.applyImpact(new THREE.Vector3(p.x, p.y + 0.8, p.z), new THREE.Vector3(0, -1, 0), Math.min(1.3, 0.6 + blk.vol / 800), { kind: 'building', material: 'concrete' });
        b.applyImpulse({ x: 0, y: -b.mass() * 3, z: 0 }, true);
      } catch { /* vehicle gone */ }
    }
    const tr = this.game.traffic;
    if (tr?.agents) for (const a of tr.agents) {
      if (Math.hypot(a.cur.x - t.x, a.cur.z - t.z) > rad || a.cur.y > bot + 2.5) continue;
      sys.agentHit?.(a, 0.7);
      tr.crash?.(a);
    }
  }

  // full pinned-debris budget: the oldest settling pile is baked where it lies
  _freezeOldest(except) {
    const j = this.jobs.find((x) => x !== except && x.items.length);
    if (j) { this.stats.frozen++; this._bake(j); this.jobs.splice(this.jobs.indexOf(j), 1); }
  }

  update(dt) {
    const game = this.game;
    // prepare / launch collapses
    const t0 = performance.now();
    for (let i = 0; i < this.events.length; i++) {
      const ev = this.events[i];
      ev.t += dt;
      if (ev.phase === 'prep') {
        const s = performance.now();
        const done = this._prep(ev, t0 + COLLAPSE.prepMs);
        const ms = performance.now() - s;
        this.stats.lastPrepMs = ms;
        this.stats.maxPrepMs = Math.max(this.stats.maxPrepMs, ms);
        if (done && ev.t >= ev.delay) {
          ev.phase = 'done';
          this._go(ev);
        }
      }
    }
    this.events = this.events.filter((e) => e.phase !== 'done');
    if (this.crushQ.length) { const [b, t] = this.crushQ.shift(); this._crush(b, t); }
    if (this.loadQ.length) { const rec = this.loadQ.shift(); if (!rec.live) { this._load(rec); this._limitLive(); } }
    // queued blocks of collapses that just started
    // (ground storeys crumble first, then the blocks above start falling): <= 3 per frame within ~1.5 ms
    const tq = performance.now();
    for (let n = 0; n < 4 && this.spawnQ.length && performance.now() - tq < 1.5; n++) {
      const s = this.spawnQ.shift();
      if (s.finish) { s.finish(); s.job.blocks--; continue; }
      if (s.crumble || this.blocks.length >= COLLAPSE.MAX_BLOCKS) { this._crumble(s.b, s.job); s.b.geometry.dispose(); s.job.blocks--; continue; }
      this._spawnBlock(s.b, s.ev, s.job, s.dir, s.H);
      s.job.blocks--;
    }
    // falling blocks
    for (const blk of this.blocks) {
      if (blk.dead) continue;
      blk.age += dt;
      const t = blk.body.translation(), r = blk.body.rotation();
      blk.mesh.position.set(t.x, t.y, t.z);
      blk.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      const v = blk.body.linvel();
      const vy = v.y;
      // landing: a sudden stop while falling, low enough above the ground, or simply too old / settled
      const lowest = t.y - Math.max(blk.half.x, blk.half.y, blk.half.z);
      const hit = blk.vyPrev < -2.2 && vy > blk.vyPrev + 2.2;
      const near = lowest < blk.ground + 0.6 && blk.age > 0.25;
      const slow = blk.age > 1 && Math.hypot(v.x, vy, v.z) < 0.6;
      if (hit || near || slow || blk.age > 5 || t.y < blk.ground - 20) this._shatter(blk);
      else {
        // runaway guard
        const sp = Math.hypot(v.x, v.y, v.z);
        if (sp > 60) blk.body.setLinvel({ x: (v.x * 60) / sp, y: (v.y * 60) / sp, z: (v.z * 60) / sp }, true);
      }
      blk.vyPrev = vy;
    }
    this.blocks = this.blocks.filter((b) => !b.dead);
    // dust clouds
    this.dust = this.dust.filter((d) => d.update(dt));
    // settle -> bake
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const j = this.jobs[i];
      j.t += dt;
      if (j.blocks > 0 || this.blocks.some((b) => b.job === j)) continue;
      let settled = j.t > 2.5;
      if (settled && j.t < 9) for (const it of j.items) {
        if (it.removed || it.body.isSleeping()) continue;
        const v = it.body.linvel();
        if (v.x * v.x + v.y * v.y + v.z * v.z > 0.1) { settled = false; break; }
      }
      if (settled) { this.jobs.splice(i, 1); this._bake(j); }
    }
    // rubble streaming (~1 Hz)
    this._hib -= dt;
    if (this._hib <= 0) { this._hib = 1; this._stream(); }
  }

  // ---------- rubble ----------

  _bake(job) {
    const t0 = performance.now();
    const fx = this.game.fx;
    const boxes = [];
    let sx = 0, sz = 0, n = 0, top = -Infinity;
    for (const it of job.items) {
      if (it.removed) continue;
      const t = it.body.translation(), r = it.body.rotation();
      if (t.y > job.base - 8) {
        boxes.push(it.hx, it.hy, it.hz, t.x, t.y, t.z, r.x, r.y, r.z, r.w, it.r, it.g, it.b);
        sx += t.x; sz += t.z; n++;
        top = Math.max(top, t.y + it.hy);
      }
      // freeze it where it lies; removed when the pile mesh replaces it (next frame, no blink)
      try { it.body.sleep(); } catch { /* gone */ }
    }
    const items = job.items.slice();
    job.items.length = 0;
    if (!n) { for (const it of items) fx?.debrisSys.remove(it); return; }
    // big collapses: keep the 110 biggest pieces in the pile (the rest are dust and grit by now)
    if (boxes.length / STRIDE > 110) {
      const idx = [...Array(boxes.length / STRIDE).keys()].sort((a, b) => boxes[b * STRIDE] * boxes[b * STRIDE + 1] * boxes[b * STRIDE + 2] - boxes[a * STRIDE] * boxes[a * STRIDE + 1] * boxes[a * STRIDE + 2]).slice(0, 110);
      const kept = [];
      for (const i of idx) for (let k = 0; k < STRIDE; k++) kept.push(boxes[i * STRIDE + k]);
      boxes.length = 0; boxes.push(...kept);
    }
    // the pile sits on the collapsed footprint; its size follows where most of the debris lies (not the stray pieces)
    const cx = job.center ? (job.center.x * 2 + sx / n) / 3 : sx / n, cz = job.center ? (job.center.z * 2 + sz / n) / 3 : sz / n;
    const ds = [];
    for (let i = 0; i < boxes.length; i += STRIDE) ds.push(Math.hypot(boxes[i + 3] - cx, boxes[i + 5] - cz) + Math.max(boxes[i], boxes[i + 2]) * 0.5);
    ds.sort((a, b) => a - b);
    const cap = (job.size || 10) * 0.75 + 1.5;
    const rr = THREE.MathUtils.clamp(ds[Math.floor(ds.length * 0.7)] || 2, 2.5, cap);
    const ground = fx?.decals?.groundY?.(cx, cz, job.base + 2) ?? job.base;
    const h = THREE.MathUtils.clamp(Math.max((top - ground) * 0.5, 0.4 + (job.H || 6) * 0.07), 0.45, Math.min(2.4, rr * 0.32));
    const col = job.col || [0.55, 0.53, 0.5];
    const rec = {
      pendingItems: items,
      id: job.id, x: cx, z: cz, ground, boxes: Float32Array.from(boxes),
      mound: { r: rr, h, col: [0.17 + col[0] * 0.12, 0.165 + col[1] * 0.12, 0.155 + col[2] * 0.12], seed: (rnd() * 1e6) | 0 },
      live: null,
    };
    this.records.push(rec);
    while (this.records.length > COLLAPSE.MAX_RECORDS) this._unload(this.records.shift());
    // the static pile is built next frame (keeps the bake and the mesh/collider build in separate frames);
    // the debris it replaces stays drawn until then via a short-lived proxy: the pile appears in the same place
    this.loadQ.push(rec);
    // dusty footprint
    fx?.decals?.addGround?.({ x: cx, y: ground, z: cz }, Math.min(30, rr * 2.6 + 4), { kind: 2, life: 1e7, heat: 0 });
    this.stats.baked++;
    this.stats.lastBakeMs = performance.now() - t0;
  }

  _moundPoints(rec) {
    const m = rec.mound;
    let s = m.seed;
    const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const N = 12, pts = [];
    const T = this.game.terrain;
    for (let ring = 0; ring < 2; ring++) {
      const rk = ring === 0 ? 1 : 0.55, hk = ring === 0 ? -0.35 : 0.7;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2 + rand() * 0.3;
        const r = m.r * rk * (0.75 + rand() * 0.4);
        const x = rec.x + Math.cos(a) * r, z = rec.z + Math.sin(a) * r;
        const gy = ring === 0 ? Math.min(rec.ground, T?.heightAt?.(x, z) ?? rec.ground) : rec.ground;
        pts.push(x, gy + m.h * hk * (0.8 + rand() * 0.4), z);
      }
    }
    pts.push(rec.x + (rand() - 0.5), rec.ground + m.h, rec.z + (rand() - 0.5));
    return pts;
  }

  _load(rec) {
    if (rec.live) return;
    const { RAPIER, world, scene } = this.game;
    const B = rec.boxes, nb = B.length / STRIDE;
    const mp = this._moundPoints(rec);
    const N = 12;
    const moundTris = N * 2 * 3 + N * 3; // ring0-ring1 quads + ring1-top fan
    const pos = new Float32Array((nb * 36 + moundTris) * 3), col = new Float32Array((nb * 36 + moundTris) * 3);
    let o = 0;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    let colliders = 0;
    for (let b = 0; b < nb; b++) {
      const k = b * STRIDE;
      const hx = B[k], hy = B[k + 1], hz = B[k + 2];
      _q.set(B[k + 6], B[k + 7], B[k + 8], B[k + 9]);
      for (let v = 0; v < 36; v++) {
        _p.set(BOX[v * 3] * hx, BOX[v * 3 + 1] * hy, BOX[v * 3 + 2] * hz).applyQuaternion(_q);
        pos[o] = _p.x + B[k + 3]; pos[o + 1] = _p.y + B[k + 4]; pos[o + 2] = _p.z + B[k + 5];
        col[o] = B[k + 10]; col[o + 1] = B[k + 11]; col[o + 2] = B[k + 12];
        o += 3;
      }
      // flat collider slabs for the bigger pieces (cars climb / bump over them; the mound carries the rest)
      if (Math.max(hx, hz) > 0.5 && colliders < 28) {
        const ch = Math.min(hy, 0.26);
        world.createCollider(RAPIER.ColliderDesc.cuboid(hx * 0.9, ch, hz * 0.9).setTranslation(B[k + 3], B[k + 4] - (hy - ch) * 0.7, B[k + 5])
          .setRotation({ x: B[k + 6], y: B[k + 7], z: B[k + 8], w: B[k + 9] }).setFriction(0.9).setCollisionGroups(this.staticGroups), body);
        colliders++;
      }
    }
    // mound
    const mc = rec.mound.col;
    const put = (i, sh) => { pos[o] = mp[i * 3]; pos[o + 1] = mp[i * 3 + 1]; pos[o + 2] = mp[i * 3 + 2]; col[o] = mc[0] * sh; col[o + 1] = mc[1] * sh; col[o + 2] = mc[2] * sh; o += 3; };
    for (let i = 0; i < N; i++) {
      const a0 = i, a1 = (i + 1) % N, b0 = N + i, b1 = N + ((i + 1) % N);
      const sh = 0.85 + ((i * 37) % 10) / 40;
      put(a0, sh); put(b1, sh); put(a1, sh);
      put(a0, sh); put(b0, sh); put(b1, sh);
      put(b0, sh * 1.05); put(2 * N, sh * 1.05); put(b1, sh * 1.05);
    }
    try {
      const hull = RAPIER.ColliderDesc.convexHull(Float32Array.from(mp));
      if (hull) world.createCollider(hull.setFriction(1).setCollisionGroups(this.staticGroups), body);
    } catch { /* degenerate mound */ }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals(); // same attribute set as the prewarmed mesh: no new (shadow) program at the first pile
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.rubbleMat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.name = `rubble:${rec.id}`;
    scene.add(mesh);
    rec.live = { mesh, body };
    if (rec.pendingItems) { for (const it of rec.pendingItems) this.game.fx?.debrisSys.remove(it); rec.pendingItems = null; }
  }

  _unload(rec) {
    if (!rec?.live) return;
    rec.live.mesh.removeFromParent();
    rec.live.mesh.geometry.dispose();
    try { this.game.world.removeRigidBody(rec.live.body); } catch { /* gone */ }
    rec.live = null;
  }

  _limitLive() {
    const cam = this.game.camera.position;
    let live = this.records.filter((r) => r.live);
    while (live.length > COLLAPSE.MAX_LIVE_RUBBLE) {
      let far = live[0], fd = -1;
      for (const r of live) { const d = Math.hypot(r.x - cam.x, r.z - cam.z); if (d > fd) { fd = d; far = r; } }
      this._unload(far);
      live = live.filter((r) => r !== far);
    }
  }

  // piles far away hibernate (record kept), and come back when the player returns
  _stream() {
    const f = this.game.player?.focus || this.game.camera.position;
    let loads = 0;
    for (const r of this.records) {
      const d = Math.hypot(r.x - f.x, r.z - f.z);
      if (r.live && d > 750) this._unload(r);
      else if (!r.live && d < 550 && loads < 2) { this._load(r); loads++; }
    }
    if (loads) this._limitLive();
  }

  get rubble() { return this.records.filter((r) => r.live); }

  clear() {
    for (const b of this.blocks) { try { this.game.world.removeRigidBody(b.body); } catch { /* gone */ } b.mesh.removeFromParent(); b.mesh.geometry.dispose(); }
    this.blocks.length = 0;
    for (const e of this.events) for (const b of e.built) b.geometry.dispose();
    for (const q of this.spawnQ) q.b?.geometry.dispose();
    this.spawnQ.length = 0;
    this.events.length = 0;
    this.jobs.length = 0;
    for (const r of this.records) this._unload(r);
    this.records.length = 0;
    this.dust.length = 0;
  }
}
