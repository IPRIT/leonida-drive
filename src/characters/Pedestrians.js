// Pedestrians v2: diverse instanced crowd walking the sidewalks of lit streets (and beaches), with idle/chat/phone/
// jogging behaviours, panic reactions (fast cars, explosions, fire), dives, knock-downs with ragdolls (capped pool) or
// cheap tumbles, getting up, limping away and dropping cash. Rendering: HumanBatch near (articulated) + far LOD.
import * as THREE from 'three';
import { NJ, ROOT, makeDims, fk, pelvisMatrix } from './rig.js';
import * as PZ from './poses.js';
import { makeLook, lookData, rng } from './looks.js';
import { HumanBatch } from './HumanBatch.js';
import { getRagdolls } from './Ragdoll.js';
import { vehicleBox, agentBox, boxLocal, groundY, wrapAngle, clamp } from './util.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { vehicleKnock, blastKnock, pushVehicle, tumbleStep, hoodRamp, KNOCK } from './impact.js';
import { getObstacles, INFLATE, toLocal, toWorld, segHitsBox } from './obstacles.js';

const WALKERS = new Set(['walk', 'wander', 'flee', 'limp', 'stumble', 'shuffle']);
const CALM = new Set(['walk', 'wander', 'idle', 'phone', 'chat', 'limp']);
const RESTING = new Set(['sunbathe', 'sit']);
const FLYING = new Set(['ragdoll', 'tumble', 'dive']);
const AVOID = new Set(['walk', 'wander', 'idle', 'phone', 'chat', 'shuffle', 'flee', 'limp', 'down', 'getup', 'stumble', 'cower', 'dive', 'ragdoll', 'sunbathe', 'sit']);
const TOWELS = [0xff4f9a, 0x2fd6d0, 0xf5c84c, 0x6b8cff, 0xff8a3d, 0x8fe38a, 0xb38cff, 0xffffff, 0xff6f61, 0x41e2b4, 0x1d6fd8, 0xd63a5a];
const _frustum = new THREE.Frustum(), _m4 = new THREE.Matrix4(), _sph = new THREE.Sphere(new THREE.Vector3(), 1.3);
const _M = new Float32Array(12), _loc = {};
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _e = new THREE.Euler(), _qq = new THREE.Quaternion(), _v3 = new THREE.Vector3(), _s3 = new THREE.Vector3(), _col = new THREE.Color();
const _kn = {}, _la = {}, _lb = {};
const OBST_RANGE = 60; // peds closer than this to the focus avoid vehicles
const CELL = 20, CELL_CAP = 4; // spawn spacing: at most CELL_CAP street peds per 20 m cell
// 7×7 grid of 100 m cells around the focus for spawn candidates, nearest first (dx, dz pairs)
const CAND_CELLS = (() => {
  const c = [];
  for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) c.push([i, j]);
  c.sort((a, b) => a[0] * a[0] + a[1] * a[1] - b[0] * b[0] - b[1] * b[1]);
  return c.flat();
})();
const SPAWN_MIN = 32, SPAWN_MAX = 235, SPAWN_VIEW = 150; // spawn ring (m); in view only beyond SPAWN_VIEW m from the camera
const XWALK_OFF = 2.1; // Roads.js: zebra centre 2.1 m past the junction trim
const ROAD_LIFT = 0.07, KERB = 0.14; // Roads.js: road surface lift and sidewalk kerb height
let SEED = 1;

// critically damped follow of the ground height (kerbs, slopes, edge changes never pop)
function smoothY(p, target, dt) {
  const omega = 2 / 0.14, x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const c = p.y - target;
  const tmp = ((p.yv || 0) + omega * c) * dt;
  p.yv = ((p.yv || 0) - omega * tmp) * e;
  p.y = target + (c + tmp) * e;
}

export class Pedestrians {
  /**
   * @param {{scene, roads, terrain, max?: number, game?: object}} o
   *   game is optional at construction; without it peds have no ragdolls/cash/events (call attach(game) later).
   */
  constructor({ scene, roads, terrain, max = 170, game = null }) {
    this.scene = scene;
    this.roads = roads;
    this.terrain = terrain;
    this.max = Math.min(260, game?.quality?.pedsMax ?? max);
    this.beachMax = game?.quality?.name === 'low' ? 60 : 120;
    this.cap = this.max + this.beachMax + 40;
    this.beach = { count: 0, target: 0, sandFrac: 0, timer: 0, sampleT: 0, enabled: true };
    this.parkPeds = { count: 0, timer: 0, max: game?.quality?.name === 'low' ? 24 : 48 }; // park strollers
    this.batch = new HumanBatch(scene, this.cap, { far: true });
    this.list = [];
    this.positions = []; // for traffic avoidance ({x,z})
    this.litEdges = roads.edges.filter((e) => e.lit && e.kind !== 1 && e.len > 20);
    this.spawnTimer = 0;
    // LOD distances (m): full detail, mid (boxy), shadows; far impostor up to drawFar
    this.lod0 = 25;
    this.lod1 = 55;
    this.shadowDist = 30;
    this.drawFar = 280;
    this.ragdollEnabled = true;
    this.forceLOD = null; // 'near' | 'far' | null (debug)
    this.stats = { count: 0, near: 0, mid: 0, far: 0, ragdolls: 0, ms: 0, msMax: 0 };
    this.movers = [];
    this._moverPool = [];
    this.fires = new Map();
    this.time = 0;
    this._tmp = {};
    this._tmp2 = {};
    this._st = { x: 0, z: 0 }; // steering point (detour corner)
    this.insideStats = { checks: 0, inside: 0, max: 0 }; // debug: ped centres inside a vehicle body
    this._nrm = new Map(); // edge index -> mitred vertex normals
    this._sww = new Map(); // edge index -> sidewalk width
    this._warm = 2; // seconds of fast fill after startup / teleport (in view only beyond 45 m)
    this._lastFocus = { x: 0, z: 0, ok: false };
    this._budget = 0; // spawn budget (peds), refilled at a per-second rate
    this.spawnStats = { total: 0, lastSec: 0, maxPerSec: 0, _n: 0, _t: 0 };
    this._wk = new Map(); // edge-side -> walkable sidewalk run
    this._swCells = null; // 100 m cell -> edges with sidewalks
    this._cand = []; this._candN = 0; this._candT = 0; this._seen = new Set(); // spawn candidates near the focus
    this._cells = new Map(); this._cellT = 0; // street peds per 20 m cell
    this._cam = null;
    this._q = {};
    this.game = null;
    this._frame = 0;
    this._makeBeachProps(scene);
    if (game) this.attach(game);
  }

  // instanced towels (one slot per pedestrian) and parasols; materials created once here
  _makeBeachProps(scene) {
    const strip = [];
    for (let i = 0; i < 5; i++) {
      const b = new THREE.PlaneGeometry(0.86, 0.38).toNonIndexed();
      b.rotateX(-Math.PI / 2);
      b.translate(0, 0.012, -0.76 + i * 0.38);
      const c = i % 2 ? 0.55 : 1;
      b.setAttribute('color', new THREE.BufferAttribute(new Float32Array(b.attributes.position.count * 3).fill(c), 3));
      b.deleteAttribute('uv');
      strip.push(b);
    }
    const tg = mergeGeometries(strip);
    const tm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
    this.towels = new THREE.InstancedMesh(tg, tm, this.cap);
    this.towels.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 3).fill(1), 3);
    this.towels.count = 0;
    this.towelOwners = []; // dense: instance i -> ped (swap-remove)
    this.towels.frustumCulled = false;
    this.towels.receiveShadow = true;
    this.towels.name = 'beach:towels';
    scene.add(this.towels);
    const pole = new THREE.CylinderGeometry(0.025, 0.03, 2.25, 5).toNonIndexed();
    pole.translate(0, 1.12, 0);
    pole.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pole.attributes.position.count * 3).fill(0.3), 3));
    const cone = new THREE.ConeGeometry(1.35, 0.5, 8, 1, true).toNonIndexed();
    cone.translate(0, 2.2, 0);
    const cc = new Float32Array(cone.attributes.position.count * 3);
    const cp = cone.attributes.position.array;
    for (let t = 0; t < cp.length / 9; t++) {
      const cx = cp[t * 9] + cp[t * 9 + 3] + cp[t * 9 + 6], cz = cp[t * 9 + 2] + cp[t * 9 + 5] + cp[t * 9 + 8];
      const seg = Math.floor(((Math.atan2(cz, cx) + Math.PI) / (Math.PI * 2)) * 8 + 0.5) % 2;
      cc.fill(seg ? 1 : 0.999, t * 9, t * 9 + 9);
      if (!seg) for (let k = 0; k < 9; k++) cc[t * 9 + k] = 1.6; // white stripes: instance colour is <= 0.62
    }
    cone.setAttribute('color', new THREE.BufferAttribute(cc, 3));
    for (const g of [pole, cone]) { g.deleteAttribute('uv'); g.deleteAttribute('normal'); g.computeVertexNormals(); }
    const pg = mergeGeometries([pole, cone]);
    this.parasolMax = 96;
    this.parasols = new THREE.InstancedMesh(pg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }), this.parasolMax);
    this.parasols.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.parasolMax * 3).fill(1), 3);
    this.parasols.count = 0;
    this.parasols.frustumCulled = false;
    this.parasols.castShadow = true;
    this.parasols.name = 'beach:parasols';
    scene.add(this.parasols);
    this.parasolOwners = [];
  }

  _towel(p, kind) {
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const off = kind === 'sit' ? 0.55 : kind === 'down' ? 0.15 : -0.15;
    _e.set(0, p.yaw, 0);
    _qq.setFromEuler(_e);
    _m4.compose(_v3.set(p.x + fx * off, p.y + 0.004, p.z + fz * off), _qq, _s3.set(1, 1, 1));
    const i = this.towelOwners.length;
    this.towelOwners.push(p);
    p.towelI = i;
    this.towels.setMatrixAt(i, _m4);
    _col.setHex(TOWELS[(Math.random() * TOWELS.length) | 0]);
    this.towels.setColorAt(i, _col);
    this.towels.count = this.towelOwners.length;
    this.towels.instanceMatrix.needsUpdate = true;
    this.towels.instanceColor.needsUpdate = true;
  }

  // swap-remove from a dense instanced list (only existing items are drawn)
  _dense(mesh, owners, i, key) {
    const last = owners.length - 1;
    if (i !== last) {
      const q = owners[last];
      mesh.getMatrixAt(last, _m4);
      mesh.setMatrixAt(i, _m4);
      mesh.getColorAt(last, _col);
      mesh.setColorAt(i, _col);
      owners[i] = q;
      q[key] = i;
    }
    owners.pop();
    mesh.count = owners.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
  }

  _parasol(x, y, z, owner) {
    if (this.parasolOwners.length >= this.parasolMax) return;
    const i = this.parasolOwners.length;
    this.parasolOwners.push(owner);
    _e.set((Math.random() - 0.5) * 0.25, Math.random() * 6.28, (Math.random() - 0.5) * 0.25);
    _qq.setFromEuler(_e);
    _m4.compose(_v3.set(x, y - 0.15, z), _qq, _s3.set(1, 1, 1));
    this.parasols.setMatrixAt(i, _m4);
    _col.setHex(TOWELS[(Math.random() * TOWELS.length) | 0]).multiplyScalar(0.62);
    this.parasols.setColorAt(i, _col);
    this.parasols.instanceMatrix.needsUpdate = true;
    this.parasols.instanceColor.needsUpdate = true;
    this.parasols.count = this.parasolOwners.length;
    owner.parasol = i;
  }

  attach(game) {
    if (this.game === game) return;
    this.game = game;
    this.ragdolls = getRagdolls(game);
    this.obs = getObstacles(game);
    if (game.quality?.name === 'low') { this.lod0 = 16; this.lod1 = 40; this.shadowDist = 18; }
    const ev = game.events;
    this._off = [
      ev.on('explosion', (e) => this._explosion(e)),
      ev.on('fire:start', (e) => { if (e?.position) this.fires.set(e.target ?? `${e.position.x | 0},${e.position.z | 0}`, e.position); }),
      ev.on('fire:stop', (e) => this.fires.delete(e?.target ?? `${e?.position?.x | 0},${e?.position?.z | 0}`)),
      ev.on('impact', (e) => { if (e?.position && e.kind !== 'ped' && (e.strength ?? 0) > 0.45) this.panic(e.position, 22, 0.7); }),
      ev.on('horn', (e) => { if (e?.on && e.vehicle?.body) { const t = e.vehicle.body.translation(); this.panic(t, 9, 0.4, 3); } }),
    ];
  }

  // Sidewalk centre line of edge e at arc length s (side +1 left / -1 right of the edge direction).
  // Vertex normals are mitred and interpolated along each segment, so the offset curve is continuous
  // (no jumps at polyline bends). Height follows the raised slab built by Roads.sidewalks().
  sidewalkPoint(e, s, side, out) {
    const arc = Math.min(Math.max(s, 0), e.len);
    let k = out.k ?? 0;
    if (k > e.n - 2 || e.cum[k] > arc) k = 0;
    while (k < e.n - 2 && e.cum[k + 1] < arc) k++;
    const seg = e.cum[k + 1] - e.cum[k] || 1;
    const t = Math.min(1, Math.max(0, (arc - e.cum[k]) / seg));
    const ax = e.pts[2 * k], az = e.pts[2 * k + 1], bx = e.pts[2 * k + 2], bz = e.pts[2 * k + 3];
    const N = this._normals(e);
    const nx = N[2 * k] + (N[2 * k + 2] - N[2 * k]) * t, nz = N[2 * k + 1] + (N[2 * k + 3] - N[2 * k + 1]) * t;
    const sw = this._swWidth(e);
    const half = (e.wp ? e.wp[k] + (e.wp[k + 1] - e.wp[k]) * t : e.w) / 2; // tapered like the drawn kerb
    const o = (sw ? half + sw / 2 : half + 2.3) * side;
    const cx = ax + (bx - ax) * t, cz = az + (bz - az) * t;
    out.x = cx + nx * o;
    out.z = cz + nz * o;
    const ry = e.y[k] + (e.y[k + 1] - e.y[k]) * t;
    // slab top (road + lift + kerb), following the terrain where it rises above it (Roads.sidewalks())
    if (sw) out.y = Math.max(ry + ROAD_LIFT + KERB, this.terrain.heightAt(out.x, out.z) + 0.03);
    else out.y = Math.max(ry + 0.05, this.terrain.heightAt(out.x, out.z));
    out.tx = (bx - ax) / seg; out.tz = (bz - az) / seg; out.k = k;
    const nl = (Math.hypot(nx, nz) || 1) * (side < 0 ? -1 : 1);
    out.nx = nx / nl; out.nz = nz / nl; // outward unit normal (away from the road)
    return out;
  }

  _swWidth(e) {
    const cache = (this._sww ||= new Map());
    let w = cache.get(e.i);
    if (w === undefined) { w = typeof this.roads.sidewalkWidth === 'function' ? this.roads.sidewalkWidth(e) || 0 : 0; cache.set(e.i, w); }
    return w;
  }

  // mitred unit normals at the vertices of an edge (left of travel), cached
  _normals(e) {
    const cache = (this._nrm ||= new Map());
    let N = cache.get(e.i);
    if (N) return N;
    const n = e.n, P = e.pts;
    N = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) {
      let ax = 0, az = 0, sx = 0, sz = 0;
      for (let j = k - 1; j <= k; j++) {
        if (j < 0 || j >= n - 1) continue;
        const dx = P[2 * j + 2] - P[2 * j], dz = P[2 * j + 3] - P[2 * j + 1], l = Math.hypot(dx, dz) || 1;
        ax += -dz / l; az += dx / l;
        sx = -dz / l; sz = dx / l;
      }
      const l = Math.hypot(ax, az) || 1;
      ax /= l; az /= l;
      const m = 1 / Math.max(0.6, ax * sx + az * sz);
      N[2 * k] = ax * m; N[2 * k + 1] = az * m;
    }
    cache.set(e.i, N);
    return N;
  }

  _context(x, z, extra = {}) {
    const g = this.game;
    const area = g?.world3d?.areaAt?.(x, z);
    const G = this.terrain.G;
    const sand = this.terrain.groundAt(x, z) === G.sand;
    const beachy = sand || (area?.name?.includes('Beach') && Math.random() < 0.3);
    return { wealth: area?.wealth ?? 0.5, beach: beachy, night: g?.sky?.night ?? 0, ...extra };
  }

  _create(look, x, y, z, yaw) {
    const slot = this.batch.alloc();
    if (slot < 0) return null;
    const dims = makeDims(look);
    const data = lookData(look, dims);
    this.batch.setLook(slot, data);
    const p = {
      id: SEED++, slot, look, dims, hold: data.hold, x, y, z, yaw,
      P: PZ.newPose(), T: PZ.newPose(), W: new Float32Array(NJ * 12),
      state: 'walk', t: 0, dur: 0, phase: Math.random() * 6.28, speed: 1.25, base: 1.25,
      e: null, s: 0, side: 1, dir: 1, sp: { k: 0 }, mode: 'path',
      vx: 0, vy: 0, vz: 0, spin: 0, panic: 0, fleeX: 0, fleeZ: 0, partner: null, seed: Math.random() * 100,
      near: false, vis: 0, rd: null, gu: 0, faceUp: true, knocks: 0, phoneMode: Math.random() < 0.5 ? 1 : 2,
      jogger: false, obsOn: false, blockT: 0, blockLim: 0, prevState: null, shift: 0, shiftHold: 0,
      planK: '', planArm: null, planSide: 1, planSx: 0, planNi: 0, cross: null, waitX: false, rsT: 0, scareT: 0,
    };
    const elderly = look.build === 'elderly';
    p.base = elderly ? 0.85 + Math.random() * 0.25 : 1.1 + Math.random() * 0.45;
    p.speed = p.base;
    PZ.poseIdle(p.P, 0, p.seed, dims);
    this.list.push(p);
    return p;
  }

  _spawnSidewalk(e, s, side, dir, ctx, look = null) {
    const q = this.sidewalkPoint(e, s, side, { k: 0 });
    const lk = look || makeLook(rng((Math.random() * 4e9) >>> 0), this._context(q.x, q.z, ctx));
    const p = this._create(lk, q.x, q.y, q.z, Math.atan2(-q.tx * dir, -q.tz * dir));
    if (!p) return null;
    p.e = e; p.s = s; p.side = side; p.dir = dir; p.mode = 'path'; p.sp.k = q.k; p.shift = 0;
    this.spawnStats.total++; this.spawnStats._n++;
    const ck = this._cellKey(q.x, q.z);
    this._cells.set(ck, (this._cells.get(ck) || 0) + 1);
    const r = Math.random();
    if (lk.handR === 'phone' && r < 0.3) this._setState(p, 'phone', 4 + Math.random() * 8);
    else if (r < 0.08) this._setState(p, 'idle', 2 + Math.random() * 6);
    else this._setState(p, 'walk', 0);
    return p;
  }

  // ---------------- beach life ----------------
  _isDrySand(x, z, hmin = 0.25, hmax = 5) {
    const h = this.terrain.heightAt(x, z);
    return this.terrain.groundAt(x, z) === this.terrain.G.sand && h > hmin && h < hmax;
  }

  _findSand(focus, rMin, rMax, hmin, hmax, tries = 10) {
    for (let i = 0; i < tries; i++) {
      const a = Math.random() * Math.PI * 2, r = rMin + Math.pow(Math.random(), 1.6) * (rMax - rMin);
      const x = focus.x + Math.cos(a) * r, z = focus.z + Math.sin(a) * r;
      if (!this._isDrySand(x, z, hmin, hmax)) continue;
      if (!this._hidden(x, this.terrain.heightAt(x, z), z)) continue;
      return { x, z, h: this.terrain.heightAt(x, z) };
    }
    return null;
  }

  // unit vector pointing to the sea (lowest terrain around)
  _seaDir(x, z) {
    let best = 0, bh = Infinity;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const h = this.terrain.heightAt(x + Math.cos(a) * 40, z + Math.sin(a) * 40) + this.terrain.heightAt(x + Math.cos(a) * 15, z + Math.sin(a) * 15);
      if (h < bh) { bh = h; best = a; }
    }
    return [Math.cos(best), Math.sin(best)];
  }

  _beachUpdate(dt, focus, camera, density) {
    const B = this.beach, g = this.game;
    this._cam = camera;
    B.sampleT -= dt;
    if (B.sampleT <= 0) {
      B.sampleT = 2;
      let n = 0;
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * Math.PI * 2, r = 20 + Math.random() * 170;
        if (this._isDrySand(focus.x + Math.cos(a) * r, focus.z + Math.sin(a) * r)) n++;
      }
      B.sandFrac = Math.min(1, (n / 40) * 3.5);
    }
    const hour = g?.sky?.time ?? 13;
    const day = Math.max(0, Math.sin((Math.PI * (hour - 7.5)) / 11));
    const rain = g?.weather?.rain ?? g?.uniforms?.uRain?.value ?? 0;
    B.target = B.sandFrac < 0.04 ? 0 : Math.round(this.beachMax * Math.pow(day, 0.8) * (1 - 0.9 * rain) * B.sandFrac * density);
    if (this._warm > 0) { // scene (re)load: fill the beach at once
      for (let k = 0; k < 8 && B.count < B.target - 1 && this.batch.hi < this.cap - 4; k++) {
        if (Math.random() < 0.22) this._spawnStroller(focus); else this._spawnBeachGroup(focus);
      }
      return;
    }
    B.timer -= dt;
    if (B.timer > 0) return;
    B.timer = 0.2;
    if (B.count < B.target - 1 && this.batch.hi < this.cap - 4) {
      if (Math.random() < 0.22) this._spawnStroller(focus); else this._spawnBeachGroup(focus);
    } else if (B.count > B.target + 4) {
      // over budget (evening, rain): quietly remove someone out of view
      let worst = null, wd = -1;
      for (const p of this.list) {
        if (!p.beach || p.vis !== 0 || p.rd) continue;
        const d = Math.hypot(p.x - focus.x, p.z - focus.z);
        if (d > wd) { wd = d; worst = p; }
      }
      if (worst) this.remove(worst);
    }
  }

  _beachPed(x, z, yaw, ctx, state, dur) {
    const look = makeLook(rng((Math.random() * 4e9) >>> 0), ctx);
    const p = this._create(look, x, Math.max(this.terrain.heightAt(x, z), 0), z, yaw);
    if (!p) return null;
    p.beach = true;
    this.beach.count++;
    p.mode = 'free';
    p.sandOnly = true;
    p.variant = (Math.random() * 3) | 0;
    this._setState(p, state, dur);
    return p;
  }

  _spawnBeachGroup(focus) {
    const s = this._findSand(focus, 25, 190, 0.3, 5);
    if (!s) return;
    const [sx, sz] = this._seaDir(s.x, s.z);
    const tx = -sz, tz = sx;
    const ctx = this._context(s.x, s.z, { beach: true, night: 0 });
    ctx.beach = true;
    const r = Math.random();
    if (r < 0.18) { // standing group chatting in a circle
      const n = 2 + ((Math.random() * 3) | 0);
      const members = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
        const x = s.x + Math.cos(a) * 0.8, z = s.z + Math.sin(a) * 0.8;
        const p = this._beachPed(x, z, Math.atan2(Math.cos(a), Math.sin(a)), ctx, 'chat', 20 + Math.random() * 50);
        if (!p) break;
        p.faceX = s.x; p.faceZ = s.z;
        members.push(p);
      }
      return;
    }
    const n = r < 0.5 ? 1 : r < 0.82 ? 2 : r < 0.93 ? 3 : 4;
    let first = null;
    for (let i = 0; i < n; i++) {
      const off = (i - (n - 1) / 2) * 1.15 + (Math.random() - 0.5) * 0.2;
      const x = s.x + tx * off, z = s.z + tz * off;
      if (!this._isDrySand(x, z, 0.15)) continue;
      const sit = Math.random() < 0.35;
      const faceUp = Math.random() < 0.7;
      const yaw = sit || faceUp ? Math.atan2(-sx, -sz) : Math.atan2(sx, sz);
      const p = this._beachPed(x, z, yaw, ctx, sit ? 'sit' : 'sunbathe', 60 + Math.random() * 180);
      if (!p) break;
      p.faceUp = faceUp;
      if (sit) PZ.poseSitGround(p.P, p.variant, 0, p.dims); else PZ.poseSunbathe(p.P, faceUp, p.variant, 0, p.dims);
      if (Math.random() < 0.9) this._towel(p, sit ? 'sit' : faceUp ? 'up' : 'down');
      first ||= p;
    }
    if (first && Math.random() < 0.42) this._parasol(s.x - sx * 1.1 + tx * 0.7, s.h, s.z - sz * 1.1 + tz * 0.7, first);
  }

  _spawnStroller(focus) {
    const s = this._findSand(focus, 25, 190, 0.03, 0.7, 14);
    if (!s) return;
    const [sx, sz] = this._seaDir(s.x, s.z);
    const sg = Math.random() < 0.5 ? 1 : -1;
    const tx = -sz * sg, tz = sx * sg;
    const ctx = this._context(s.x, s.z, { beach: true, night: 0 });
    ctx.beach = true;
    const p = this._beachPed(s.x, s.z, Math.atan2(-tx, -tz), ctx, 'wander', 15 + Math.random() * 30);
    if (!p) return;
    p.shore = true;
    p.jogger = Math.random() < 0.35 && p.look.build !== 'elderly' && p.look.build !== 'heavy';
    p.base = p.jogger ? 2.6 + Math.random() * 0.7 : p.base;
  }

  // ---------------- park strollers (path graph of src/world/Parks.js) ----------------
  _parkGraph() {
    if (this._pg !== undefined) return this._pg;
    const E = this.game?.parks?.pathGraph?.();
    if (!E?.length) return (this._pg = null);
    const adj = new Map();
    for (let i = 0; i < E.length; i++) {
      const e = E[i];
      if (!e.cum) {
        e.cum = new Float32Array(e.n);
        for (let k = 1; k < e.n; k++) e.cum[k] = e.cum[k - 1] + Math.hypot(e.pts[k * 3] - e.pts[k * 3 - 3], e.pts[k * 3 + 2] - e.pts[k * 3 - 1]);
        e.len = e.cum[e.n - 1];
      }
      for (const nd of [e.a, e.b]) { if (!adj.has(nd)) adj.set(nd, []); adj.get(nd).push(i); }
    }
    return (this._pg = { E, adj });
  }

  _parkPoint(e, s, off, out) {
    const c = e.cum, n = e.n, P = e.pts;
    const a = Math.min(Math.max(s, 0), e.len);
    let k = out.k ?? 0;
    if (k > n - 2 || c[k] > a) k = 0;
    while (k < n - 2 && c[k + 1] < a) k++;
    const seg = c[k + 1] - c[k] || 1, t = Math.min(1, Math.max(0, (a - c[k]) / seg));
    const dx = (P[k * 3 + 3] - P[k * 3]) / seg, dz = (P[k * 3 + 5] - P[k * 3 + 2]) / seg;
    out.x = P[k * 3] + (P[k * 3 + 3] - P[k * 3]) * t - dz * off;
    out.z = P[k * 3 + 2] + (P[k * 3 + 5] - P[k * 3 + 2]) * t + dx * off;
    out.y = P[k * 3 + 1] + (P[k * 3 + 4] - P[k * 3 + 1]) * t;
    out.k = k;
    return out;
  }

  _parkUpdate(dt, focus, density, night) {
    const S = this.parkPeds;
    if ((S.timer -= dt) > 0) return;
    S.timer = this._warm > 0 ? 0.05 : 0.4;
    const G = this._parkGraph();
    if (!G) return;
    const hour = this.game?.sky?.time ?? 13;
    const day = Math.max(0.25, Math.sin((Math.PI * (hour - 6.5)) / 14));
    const rain = this.game?.weather?.rain ?? 0;
    // paths around the focus (sampled), crowd proportional to their length
    let near = 0;
    const cand = this._pcand || (this._pcand = []);
    if ((S.scanT = (S.scanT ?? 0) - 1) <= 0) {
      S.scanT = 5;
      cand.length = 0;
      for (let i = 0; i < G.E.length; i++) {
        const e = G.E[i], m = (e.n >> 1) * 3;
        const d = Math.hypot(e.pts[m] - focus.x, e.pts[m + 2] - focus.z) - e.len / 2;
        if (d < 230) { cand.push(i); near += e.len; }
      }
      S.near = near;
    }
    const target = Math.min(S.max, Math.round((S.near || 0) / 28 * day * (1 - 0.85 * rain) * density * (1 - night * 0.5)));
    if (S.count >= target || !cand.length || this.batch.hi >= this.cap - 4) return;
    for (let tries = 0; tries < 6; tries++) {
      const e = G.E[cand[(Math.random() * cand.length) | 0]];
      const s = Math.random() * e.len, off = (Math.random() - 0.5) * Math.min(1.6, e.w * 0.5);
      const q = this._parkPoint(e, s, off, {});
      const d = Math.hypot(q.x - focus.x, q.z - focus.z);
      if (d > 235 || (d < 28 && this._warm <= 0)) continue;
      if (this._warm <= 0 && !this._hidden(q.x, q.y, q.z)) continue;
      const dir = Math.random() < 0.5 ? 1 : -1;
      const look = makeLook(rng((Math.random() * 4e9) >>> 0), this._context(q.x, q.z, { beach: false }));
      const t = this._parkPoint(e, s + dir, off, {});
      const p = this._create(look, q.x, q.y, q.z, Math.atan2(-(t.x - q.x), -(t.z - q.z)));
      if (!p) return;
      p.park = true; p.mode = 'park'; p.pe = e; p.ps = s; p.pdir = dir; p.poff = off; p.pk = { k: 0 };
      S.count++;
      p.jogger = Math.random() < 0.18 && p.look.build !== 'elderly' && p.look.build !== 'heavy';
      if (p.jogger) p.base = 2.5 + Math.random() * 0.8;
      else p.base *= 0.85; // strolling
      p.speed = p.base;
      if (!p.jogger && Math.random() < 0.12) this._setState(p, 'phone', 4 + Math.random() * 8);
      else this._setState(p, 'walk', 0);
      return;
    }
  }

  // along the park path: carrot at the arc position, next path at the junctions (no U-turns unless a dead end)
  _parkStep(p, dt) {
    const G = this._parkGraph();
    if (!G || !p.pe) { p.mode = 'free'; return; }
    let q = this._parkPoint(p.pe, p.ps, p.poff, p.pk);
    let d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d > 9) { this._parkResnap(p); q = this._parkPoint(p.pe, p.ps, p.poff, p.pk); d = Math.hypot(q.x - p.x, q.z - p.z); }
    if (d < 1.2) {
      p.ps += p.speed * dt * p.pdir + Math.max(0, 0.7 - d) * dt * 2 * p.pdir;
      if (p.ps > p.pe.len || p.ps < 0) {
        const nd = p.ps > p.pe.len ? p.pe.b : p.pe.a;
        const opts = (G.adj.get(nd) || []).filter((i) => G.E[i] !== p.pe);
        if (opts.length) {
          const e = G.E[opts[(Math.random() * opts.length) | 0]];
          const fromA = e.a === nd;
          p.pe = e; p.ps = fromA ? 0.3 : e.len - 0.3; p.pdir = fromA ? 1 : -1; p.pk.k = 0;
        } else { p.pdir = -p.pdir; p.ps = Math.min(Math.max(p.ps, 0), p.pe.len); }
      }
      q = this._parkPoint(p.pe, p.ps, p.poff, p.pk);
      d = Math.hypot(q.x - p.x, q.z - p.z);
    }
    if (this._walkTo(p, q.x, q.z, d, dt) === 2 && p.blockT > p.blockLim) { p.pdir = -p.pdir; p.blockT = 0; }
    smoothY(p, q.y, dt);
  }

  _parkResnap(p) {
    const G = this._parkGraph();
    if (!G) { p.mode = 'free'; return; }
    let best = null, bd = 40;
    const tmp = {};
    for (const e of G.E) {
      const m = (e.n >> 1) * 3;
      if (Math.hypot(e.pts[m] - p.x, e.pts[m + 2] - p.z) > e.len / 2 + 40) continue;
      for (let s = 0; s <= e.len; s += 3) {
        const q = this._parkPoint(e, s, 0, tmp);
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (d < bd) { bd = d; best = [e, s]; }
      }
    }
    if (!best) { p.mode = 'free'; p.park = true; return; }
    p.pe = best[0]; p.ps = best[1]; p.pk = { k: 0 }; p.mode = 'park';
    p.pdir ||= 1;
  }

  _parkAway(p, fx, fz) {
    if (!p.pe) return p.pdir || 1;
    const a = this._parkPoint(p.pe, p.ps, 0, {}), b = this._parkPoint(p.pe, p.ps + 1, 0, {});
    return ((b.x - a.x) * (p.x - fx) + (b.z - a.z) * (p.z - fz)) >= 0 ? 1 : -1;
  }

  // resting -> standing (sitters skip the lying part); after: next state ('flee', 'wander', null = default)
  _getUp(p, after, dur = 1.5) {
    p.gu0 = p.state === 'sit' ? 0.35 : 0;
    if (p.state === 'sit') p.faceUp = true;
    p.after = after ?? (p.beach ? 'wander' : null);
    this._setState(p, 'getup', dur);
  }

  // a spawn point must be out of view (outside the frustum), or in view but far (a few pixels tall); during the short
  // fill after startup / teleport anything beyond 45 m is fine
  _hidden(x, y, z) {
    if (!this._cam) return true;
    const c = this._cam.position;
    const d = Math.hypot(x - c.x, y - c.y, z - c.z);
    if (this._warm > 0 && d > 45) return true;
    _sph.center.set(x, y + 0.9, z);
    _sph.radius = 2;
    if (!_frustum.intersectsSphere(_sph)) return true;
    return d > SPAWN_VIEW;
  }

  // ---------------- sidewalk network ----------------
  _trimOf(e, end) { const t = this.roads.trims?.[e.i]?.[end]; return t && typeof t === 'object' ? t : null; }

  // what is at an edge end: 'j' urban junction (corners + crosswalks), 'n' plain node (sidewalk continues), 'x' none
  _endKind(e, end) {
    const R = this.roads, ni = end ? e.b : e.a;
    const J = R.junctions?.[ni];
    if (J) return J.arms ? 'j' : 'x';
    for (const ei of R.adj[ni]) if (R.edges[ei] !== e) return 'n';
    return 'x';
  }

  /**
   * Walkable sidewalk run of edge e on one side: { a, b, endA, endB } in arc length, or null. Junction mouths are cut
   * off (trims) and so are stretches where Roads built no sidewalk (another road or a junction underneath).
   */
  _walk(e, side) {
    if (e.noSidewalk) return null;
    const key = e.i * 2 + (side > 0 ? 1 : 0);
    const W = this._wk;
    const got = W.get(key);
    if (got !== undefined) return got;
    let w = null;
    const R = this.roads;
    if (this._swWidth(e) > 0 && !e.internal && e.kind !== 1) {
      const t0 = this._trimOf(e, 0)?.t ?? 0, t1 = this._trimOf(e, 1)?.t ?? 0;
      const lo = t0 + 0.4, hi = e.len - t1 - 0.4;
      if (hi - lo >= 4) {
        const n = Math.max(2, Math.ceil((hi - lo) / 2));
        let ba = -1, bb = -1, ra = -1;
        for (let k = 0; k <= n; k++) {
          const q = this.sidewalkPoint(e, lo + ((hi - lo) * k) / n, side, this._tmp);
          const y = q.y - 0.2;
          const ok = !(R.sidewalkBlocked?.(e, q.x, q.z, y) || R.inJunction?.(q.x, q.z, y) || this._onCarriageway(q.x, q.z, y));
          if (!ok) { ra = -1; continue; }
          if (ra < 0) ra = k;
          if (k - ra > bb - ba) { ba = ra; bb = k; }
        }
        if (ba >= 0 && bb > ba) {
          const a = lo + ((hi - lo) * ba) / n, b = lo + ((hi - lo) * bb) / n;
          if (b - a >= 4) w = { a, b, endA: ba === 0 ? this._endKind(e, 0) : 'x', endB: bb === n ? this._endKind(e, 1) : 'x' };
        }
      }
    }
    W.set(key, w);
    return w;
  }

  // (x, z) on the asphalt of any road at about this height (incl. the edge's own other segments at sharp bends)
  _onCarriageway(x, z, y) {
    // the road network is static: cache by 0.5 m cell and 2 m height band
    const C = (this._cwc ||= new Map());
    const key = (Math.round(x * 2) * 100003 + Math.round(z * 2)) * 64 + (Math.round(y / 2) & 63);
    const got = C.get(key);
    if (got !== undefined) return got;
    const n = this.roads.nearest(x, z, 18);
    let r = false;
    if (n) {
      const e = n.edge, k = n.seg;
      const w = e.wp ? e.wp[k] + (e.wp[k + 1] - e.wp[k]) * n.t : e.w;
      r = n.dist < w / 2 + 0.2 && Math.abs(n.y - y) < 2.5;
    }
    if (C.size > 20000) C.clear();
    C.set(key, r);
    return r;
  }

  // edges with sidewalks by 100 m cell (built once)
  _sidewalkCells() {
    if (this._swCells) return this._swCells;
    const M = (this._swCells = new Map());
    for (const e of this.roads.edges) {
      if (!(this._swWidth(e) > 0) || e.internal || e.kind === 1) continue;
      let last = null;
      for (let k = 0; k < e.n; k++) {
        const key = Math.floor(e.pts[2 * k] / 100) * 100003 + Math.floor(e.pts[2 * k + 1] / 100);
        if (key === last) continue;
        last = key;
        let l = M.get(key);
        if (!l) M.set(key, (l = []));
        if (l[l.length - 1] !== e) l.push(e);
      }
    }
    return M;
  }

  // spawn candidates: walkable sidewalk runs around the focus, weighted by length (pooled entries)
  _refreshCandidates(focus, full = false) {
    const M = this._sidewalkCells(), C = this._cand, seen = this._seen;
    seen.clear();
    let n = 0, tot = 0, fresh = 0, more = false;
    // new (uncached) sidewalk runs per refresh: at most 40 and ~2.5 ms; while some are still missing the refresh repeats
    // next frame (_update), nearest cells first, so a teleport / respawn fills in over a few frames instead of one
    // 30-40 ms frame (the loading screen computes everything around the spawn: prewarm)
    const lim = full ? Infinity : 40;
    const deadline = full ? Infinity : performance.now() + 2.5;
    const ci = Math.floor(focus.x / 100), cj = Math.floor(focus.z / 100);
    for (let o = 0; o < CAND_CELLS.length; o += 2) {
      const i = ci + CAND_CELLS[o], j = cj + CAND_CELLS[o + 1];
      {
        const l = M.get(i * 100003 + j);
        if (!l) continue;
        for (const e of l) {
          if (seen.has(e)) continue;
          seen.add(e);
          for (let sd = -1; sd <= 1; sd += 2) {
            const key = e.i * 2 + (sd > 0 ? 1 : 0);
            if (!this._wk.has(key)) {
              if (fresh >= lim || (fresh & 3) === 3 && performance.now() > deadline) { more = true; continue; }
              fresh++;
            }
            const w = this._walk(e, sd);
            if (!w || w.b - w.a < 8) continue;
            tot += w.b - w.a - 4;
            const c = C[n] || (C[n] = { e: null, side: 1, w: null, cum: 0 });
            c.e = e; c.side = sd; c.w = w; c.cum = tot;
            n++;
          }
        }
      }
    }
    this._candN = n;
    this._candMore = more;
  }

  /** Loading screen: sidewalk index and every spawn candidate around the start point, so the first frame only spawns. */
  prewarm(focus) {
    if (!focus) return;
    this._refreshCandidates(focus, true);
    this._candT = 1;
    this._lastFocus.x = focus.x; this._lastFocus.z = focus.z; this._lastFocus.ok = true;
  }

  _cellKey(x, z) { return Math.floor(x / CELL) * 100003 + Math.floor(z / CELL); }

  _countCells() {
    const M = this._cells;
    M.clear();
    for (const p of this.list) {
      if (p.beach) continue;
      const k = this._cellKey(p.x, p.z);
      M.set(k, (M.get(k) || 0) + 1);
    }
  }

  spawn(focus, camera) {
    const C = this._cand, n = this._candN;
    if (!n) return null;
    const tot = C[n - 1].cum;
    for (let t = 0; t < 10; t++) {
      // length-weighted pick: uniform density along every sidewalk around the focus
      const r = Math.random() * tot;
      let lo = 0, hi = n - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (C[m].cum < r) lo = m + 1; else hi = m; }
      const c = C[lo], e = c.e, w = c.w;
      const s = w.a + 2 + Math.random() * (w.b - w.a - 4);
      const q = this.sidewalkPoint(e, s, c.side, this._tmp);
      const d = Math.hypot(q.x - focus.x, q.z - focus.z);
      if (d < SPAWN_MIN || d > SPAWN_MAX) continue;
      if (!this._hidden(q.x, q.y, q.z)) continue;
      const key = this._cellKey(q.x, q.z);
      const occ = this._cells.get(key) || 0;
      if (occ >= CELL_CAP) continue;
      if (this.obs && this._insideAny(q.x, q.z, q.y, null, 0.4)) continue; // not under a parked car
      const g = Math.random();
      let p;
      if (g < 0.035 && occ <= CELL_CAP - 2) p = this._spawnPair(e, s, c.side, w);
      else if (g < 0.045 && occ <= CELL_CAP - 3) p = this._spawnPair(e, s, c.side, w, true);
      else p = this._spawnSidewalk(e, s, c.side, Math.random() < 0.5 ? -1 : 1);
      return p;
    }
    return null;
  }

  // chatting pair (rarely three people) standing on the sidewalk
  _spawnPair(e, s, side, w, three = false) {
    const lo = w ? w.a : 0, hi = w ? w.b : e.len;
    const a = this._spawnSidewalk(e, Math.max(lo, s - 0.55), side, 1);
    const b = a && this._spawnSidewalk(e, Math.min(hi, s + 0.55), side, -1);
    if (!a || !b) return a;
    a.partner = b; b.partner = a;
    const dur = 8 + Math.random() * 18;
    this._setState(a, 'chat', dur);
    this._setState(b, 'chat', dur);
    if (three) {
      const c = this._spawnSidewalk(e, s, side, 1);
      if (c) {
        const q = this.sidewalkPoint(e, s, side, this._tmp);
        c.x = q.x + q.nx * 0.6; c.z = q.z + q.nz * 0.6; // outer side of the pair (sidewalk)
        c.faceX = q.x; c.faceZ = q.z;
        this._setState(c, 'chat', dur * (0.6 + Math.random() * 0.4));
      }
    }
    return a;
  }

  /** Debug/lab: spawn a crowd of a given body type on sidewalks around (x, z). */
  spawnCrowd({ build, count = 50, x, z, radius = 60, beach } = {}) {
    let made = 0;
    for (let i = 0; i < count * 4 && made < count; i++) {
      const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * radius;
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      const n = this.roads.nearest(px, pz, 40, (e) => this._swWidth(e) > 0 && !e.internal && e.kind !== 1);
      if (!n) continue;
      const e = n.edge, side = Math.random() < 0.5 ? -1 : 1, w = this._walk(e, side);
      if (!w) continue;
      const s = Math.min(Math.max(e.cum[n.seg] + n.t * (e.cum[n.seg + 1] - e.cum[n.seg]), w.a), w.b);
      if (this._spawnSidewalk(e, s, side, Math.random() < 0.5 ? -1 : 1, { build, beach })) made++;
    }
    return made;
  }

  /** A character handed over by another system (e.g. a carjacked driver). */
  adopt({ look, x, y, z, yaw, pose, state = 'stumble', fleeFrom }) {
    const p = this._create(look, x, y, z, yaw);
    if (!p) return null;
    if (pose) p.P.set(pose);
    p.mode = 'free';
    p.adopted = true;
    if (fleeFrom) { p.fleeX = fleeFrom.x; p.fleeZ = fleeFrom.z; }
    p.yaw = Math.atan2(-(x - (fleeFrom?.x ?? x - 1)), -(z - (fleeFrom?.z ?? z)));
    this._setState(p, state, state === 'stumble' ? 1.4 : 8);
    this.game?.events?.emit('ped:panic', { position: { x, y, z }, ped: p });
    return p;
  }

  remove(p) {
    const i = this.list.indexOf(p);
    if (i >= 0) this.list.splice(i, 1);
    if (p.rd) { this.ragdolls?.release(p.rd); p.rd = null; }
    if (p.partner) { p.partner.partner = null; if (p.partner.state === 'chat') this._setState(p.partner, 'walk', 0); }
    if (p.towelI !== undefined) { this._dense(this.towels, this.towelOwners, p.towelI, 'towelI'); p.towelI = undefined; }
    if (p.parasol !== undefined) { this._dense(this.parasols, this.parasolOwners, p.parasol, 'parasol'); p.parasol = undefined; }
    if (p.beach) this.beach.count--;
    if (p.park) this.parkPeds.count--;
    this.batch.release(p.slot);
  }

  clear() { while (this.list.length) this.remove(this.list[0]); }

  _setState(p, s, dur = 0) {
    p.state = s;
    p.t = 0;
    p.dur = dur;
  }

  // ---------------- reactions ----------------
  /** Make pedestrians around a point panic (flee or cower). */
  panic(pos, radius = 20, prob = 0.8, dur = 0) {
    for (const p of this.list) {
      if (RESTING.has(p.state)) {
        if (Math.hypot(p.x - pos.x, p.z - pos.z) < radius && Math.random() < prob) { p.fleeX = pos.x; p.fleeZ = pos.z; this._getUp(p, 'flee', 0.8); }
        continue;
      }
      if (!CALM.has(p.state) && p.state !== 'flee') continue;
      const d = Math.hypot(p.x - pos.x, p.z - pos.z);
      if (d > radius || Math.random() > prob) continue;
      this._flee(p, pos.x, pos.z, dur || 6 + Math.random() * 6);
    }
  }

  _flee(p, fx, fz, dur) {
    p.fleeX = fx; p.fleeZ = fz;
    if (p.partner) { const q = p.partner; p.partner = null; q.partner = null; }
    if (p.mode === 'cross' && !p.cross.go) { p.mode = 'path'; p.waitX = false; } // still on the kerb: run along it
    // street peds in free mode (carjacked drivers, after a fall) flee along the nearest sidewalk
    if (p.mode === 'free' && !p.beach && !p.sandOnly) this._resnap(p, true);
    if (p.park) { this._parkResnap(p); p.pdir = this._parkAway(p, fx, fz); }
    p.planK = '';
    if (p.mode === 'path' && p.e) {
      const q = this.sidewalkPoint(p.e, p.s, p.side, p.sp);
      const nd = (q.tx * (p.x - fx) + q.tz * (p.z - fz)) >= 0 ? 1 : -1;
      // turning around: the carrot stays where it is, the ped turns and walks the other way smoothly
      p.dir = nd;
    }
    this._setState(p, 'flee', dur);
  }

  _explosion(e) {
    if (!e?.position) return;
    const pos = e.position, R = (e.radius ?? 8), power = e.power ?? 1;
    for (const p of this.list) {
      const dx = p.x - pos.x, dy = (p.y + 1) - pos.y, dz = p.z - pos.z, d = Math.hypot(dx, dy, dz);
      if (d < R * 0.85 && p.state !== 'ragdoll' && p.state !== 'tumble') {
        const kn = blastKnock(dx, dy, dz, R * 0.85, power, _kn);
        this.knock(p, kn, 0.5 + kn.k * 0.5, null);
      } else if (d < 15 && CALM.has(p.state) && Math.random() < 0.5) {
        this._setState(p, 'cower', 1.2 + Math.random() * 1.8);
        p.fleeX = pos.x; p.fleeZ = pos.z;
      } else if (d < 60) {
        if (CALM.has(p.state) || p.state === 'flee') this._flee(p, pos.x, pos.z, 8 + Math.random() * 6);
        else if (RESTING.has(p.state)) { p.fleeX = pos.x; p.fleeZ = pos.z; this._getUp(p, 'flee', 0.8); }
      }
    }
  }

  /**
   * Knock a pedestrian down (vehicle hit, explosion).
   * @param {object} p ped
   * @param {{x,y,z, sx?,sy?,sz?}} kn launch velocity (+ optional spin) — see impact.js vehicleKnock / blastKnock
   * @param {number} strength 0..1
   * @param {object|null} source vehicle/agent
   */
  knock(p, kn, strength = 0.5, source = null) {
    const g = this.game;
    if (p.state === 'ragdoll' || p.state === 'tumble') return;
    if (p.partner) { p.partner.partner = null; this._flee(p.partner, p.x, p.z, 8); p.partner = null; }
    p.knocks++;
    const pos = { x: p.x, y: p.y + 1, z: p.z };
    g?.events?.emit('ped:knocked', { position: pos, ped: p, strength });
    g?.events?.emit('impact', { position: pos, strength: Math.min(1, strength), kind: 'ped', material: 'body', source });
    // cash: richer districts drop more
    if (g?.cash && p.knocks <= 2 && Math.random() < 0.8) {
      const w = p.look.wealth ?? 0.5;
      const amount = Math.round(5 + 75 * Math.min(1, w * w * (0.35 + Math.random() * 0.9))); // $5..$80 by district
      g.cash.drop(p.x, p.y + 0.7, p.z, amount, { expire: 30, reason: 'pickup' });
    }
    // witnesses flee
    this.panic(pos, 16, 0.75);
    const vel = { x: kn.x, y: kn.y, z: kn.z };
    let spin;
    if (kn.sx !== undefined) spin = { x: kn.sx, y: kn.sy, z: kn.sz };
    else { // default: forward tumble about (direction x up), capped
      const h = Math.hypot(vel.x, vel.z) || 1, w = Math.min(KNOCK.maxSpin, 0.25 * h);
      spin = { x: (-vel.z / h) * w, y: 0, z: (vel.x / h) * w };
    }
    if (this.ragdollEnabled && this.ragdolls && p.near && this.ragdolls.available(1)) {
      // pose must be current for the ragdoll's initial state
      pelvisMatrix(_M, p.x, p.y, p.z, p.yaw, p.P, p.dims);
      fk(p.W, _M, p.P, p.dims);
      const rd = this.ragdolls.spawn(p.W, p.dims, vel, { spin, priority: 1, onEvict: () => this._fromRagdoll(p) });
      if (rd) {
        p.rd = rd;
        this._setState(p, 'ragdoll', 0);
        return;
      }
    }
    // scripted tumble with the same arc as a ragdoll: face against the launch, roll about the local x axis
    p.vx = vel.x; p.vy = vel.y; p.vz = vel.z;
    let h = Math.hypot(vel.x, vel.z);
    if (kn.carry > h && h > 0.1) { p.vx *= kn.carry / h; p.vz *= kn.carry / h; h = kn.carry; }
    if (h > 0.3) p.yaw = Math.atan2(vel.x, vel.z);
    p.spin = Math.max(-KNOCK.maxSpin, Math.min(KNOCK.maxSpin, spin.x * Math.cos(p.yaw) - spin.z * Math.sin(p.yaw)));
    p.h0 = Math.max(0.5, h);
    p.air = true;
    this._setState(p, 'tumble', 0);
  }

  // mass of a pedestrian (kg), same as its ragdoll
  _mass(p) { return Math.min(92, Math.max(70, 80 * p.dims.g * (p.dims.h / 1.76))); }

  // a vehicle box hit a pedestrian: launch, keep the body outside the car, slow the car a little
  _carHit(p, b) {
    const walking = WALKERS.has(p.state) || p.state === 'wander';
    const pvx = walking ? -Math.sin(p.yaw) * p.speed : 0, pvz = walking ? -Math.cos(p.yaw) * p.speed : 0;
    boxLocal(b, p.x, p.z, _loc);
    const kn = vehicleKnock(b, pvx, pvz, _loc.lx / (b.hw + 0.3), _kn);
    // start the ragdoll just outside the car body (no depenetration kick); at most 0.5 m
    const mx = b.hw + 0.35 - Math.abs(_loc.lx), mz = b.hl + 0.35 - Math.abs(_loc.lz);
    if (mx > 0 && mz > 0) {
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      if (mz <= mx) { const dz = Math.min(mz, 0.5) * (Math.sign(_loc.lz) || -1); p.x += s * dz; p.z += c * dz; }
      else { const dx = Math.min(mx, 0.5) * (Math.sign(_loc.lx) || 1); p.x += c * dx; p.z -= s * dx; }
    }
    pushVehicle(b, this._mass(p), kn.h);
    this.knock(p, kn, Math.min(1, kn.rel / 22), b.ref);
    // fast hits roll the body up over the hood and roof instead of bulldozing it
    if (p.rd && kn.rel > 11) this.ragdolls.addRamp(b.ref?.body, hoodRamp(b.ref));
  }

  _fromRagdoll(p) {
    const rd = p.rd;
    if (!rd || rd.released) { p.rd = null; return; }
    const t = this.ragdolls.pelvis(rd);
    const gy = this.game ? groundY(this.game, t.x, t.z, t.y + 0.5) : this.terrain.heightAt(t.x, t.z);
    const info = this.ragdolls.toPose(rd, p.P, p.W, gy);
    this.ragdolls.release(rd);
    p.rd = null;
    p.x = info.x; p.z = info.z; p.y = gy; p.yv = 0; p.yaw = info.yaw;
    p.faceUp = info.faceUp;
    this._setState(p, 'down', 1.5 + Math.random() * 2.5);
  }

  _dive(p, b) {
    // jump sideways out of the vehicle's path
    const n = b.speed || 1;
    const sx = -b.vz / n, sz = b.vx / n;
    const sgn = Math.sign((p.x - b.x) * sx + (p.z - b.z) * sz) || 1;
    p.vx = sx * sgn * 5.2; p.vz = sz * sgn * 5.2; p.vy = 2.6;
    p.yaw = Math.atan2(-p.vx, -p.vz);
    p.fleeX = b.x; p.fleeZ = b.z;
    if (p.partner) { p.partner.partner = null; p.partner = null; }
    this._setState(p, 'dive', 0);
  }

  // ---------------- per frame ----------------
  _collectMovers(focus, player) {
    const g = this.game;
    const M = this.movers;
    M.length = 0;
    let n = 0;
    const take = () => this._moverPool[n] || (this._moverPool[n] = {});
    if (g) {
      for (const v of g.vehicles?.active || []) {
        if (!v?.body?.translation || v.destroyed === 'removed') continue;
        const b = vehicleBox(v, take());
        if (b.speed < 1.5 || Math.abs(b.x - focus.x) > 300 || Math.abs(b.z - focus.z) > 300) continue;
        M.push(b); n++;
      }
      for (const a of g.traffic?.agents || []) {
        if (!a?.cur || !a.cq) continue;
        if (Math.abs(a.cur.x - focus.x) > 300 || Math.abs(a.cur.z - focus.z) > 300) continue;
        const b = agentBox(a, take());
        if (b.speed < 1.5) continue;
        b.traffic = !a.crashed;
        M.push(b); n++;
      }
    } else if (player?.position && player.velocity) {
      const b = take();
      const v = player.velocity, sp = Math.hypot(v.x, v.z);
      if (sp > 1.5) {
        Object.assign(b, { x: player.position.x, y: player.position.y, z: player.position.z, vx: v.x, vy: 0, vz: v.z, speed: sp, hw: 1, hl: 2.3, yaw: Math.atan2(-v.x, -v.z), ref: null });
        M.push(b);
      }
    }
  }

  // Per-frame entry point. Never throws: optional systems (player type, traffic, cash, ragdolls, UI) may be
  // missing or different in labs; a failure is logged once and the frame is skipped for the crowd only.
  update(dt, focus, camera, player, night = 0) {
    try {
      this._update(dt, focus, camera, player, night);
    } catch (err) {
      if (!this._errLogged) { this._errLogged = true; console.error('[peds] update failed (logged once)', err); }
      try { this.batch.flush(); } catch { /* keep rendering state consistent */ }
    }
  }

  _update(dt, focus, camera, player, night = 0) {
    if (!focus || !(dt >= 0)) return;
    dt = Math.min(dt, 0.1);
    const t0 = performance.now();
    this.time += dt;
    const g = this.game;
    if (camera) _frustum.setFromProjectionMatrix(_m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    this._cam = camera || null;
    // a big focus jump (teleport, respawn) reloads the scene: allow filling it in view for a moment
    const LF = this._lastFocus;
    if (LF.ok && Math.hypot(focus.x - LF.x, focus.z - LF.z) > 60) { this._warm = 1.5; this.beach.sampleT = 0; this._candT = 0; }
    LF.x = focus.x; LF.z = focus.z; LF.ok = true;
    this._warm = Math.max(0, this._warm - dt);
    // population: denser in the city, fewer at night
    const density = g?.settings?.peds ?? 1;
    const want = Math.round(this.max * (1 - night * 0.45) * density);
    this.spawnTimer -= dt;
    let street = this.list.length - this.beach.count - this.parkPeds.count;
    // spawn pacing: a steady per-second budget (fast only while a scene is (re)loading), spread over every sidewalk
    // run around the focus, never more than CELL_CAP street peds per 20 m cell
    if ((this._candT -= dt) <= 0 || this._candMore) { this._candT = 1; this._refreshCandidates(focus); }
    if ((this._cellT -= dt) <= 0) { this._cellT = 0.5; this._countCells(); }
    const deficit = want - street;
    const rate = deficit <= 0 ? 0 : this._warm > 0 ? 50 : Math.min(10, 1.5 + deficit * 0.12);
    this._budget = Math.min(2, this._budget + dt * rate);
    while (this._budget >= 1 && street < want) {
      const before = this.list.length;
      if (!this.spawn(focus, camera)) { this._budget -= 1; break; }
      const k = this.list.length - before; // a chatting pair / three use the budget of two / three
      this._budget -= k;
      street += k;
    }
    const SS = this.spawnStats;
    if ((SS._t += dt) >= 1) { SS.lastSec = SS._n; SS.maxPerSec = Math.max(SS.maxPerSec, this._warm > 0 ? 0 : SS._n); SS._n = 0; SS._t = 0; }
    if (this.spawnTimer <= 0 && street > want * 1.15 + 4) {
      // evening thins the crowd: drop someone out of view
      this.spawnTimer = 0.25;
      const p = this.list.find((q) => !q.beach && !q.park && !q.rd && q.vis === 0 && Math.hypot(q.x - focus.x, q.z - focus.z) > 70);
      if (p) this.remove(p);
    }
    this._frame++;
    if (this.beach.enabled) this._beachUpdate(dt, focus, camera, density);
    this._parkUpdate(dt, focus, density, night); // strollers on the park paths (src/world/Parks.js)
    this._collectMovers(focus, player);
    this._fireT = (this._fireT ?? 0) - dt;
    if (this._fireT <= 0 && this.fires.size) {
      this._fireT = 0.5;
      for (const f of this.fires.values()) this.panic(f, 20, 0.5);
    }
    const pl = g?.player;
    const pc = pl?.pos && pl.motor?.vel && pl.state !== 'vehicle' && !pl.rd ? pl.pos : null;
    const pSpeed = pc ? Math.hypot(pl.motor.vel.x, pl.motor.vel.z) : 0;
    this.positions.length = 0;
    let nNear = 0, nMid = 0, nFar = 0;
    const camPos = camera?.position;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      const df = Math.hypot(p.x - focus.x, p.z - focus.z);
      // peds out of view and far away simulate at half rate (positions stay continuous: 2x dt every other frame)
      p.sdt = (p.sdt || 0) + dt;
      if (p.vis === 0 && df > 60 && !p.rd && !FLYING.has(p.state) && (this._frame + p.id) & 1) {
        if (df > 320) { this.remove(p); continue; }
        if (AVOID.has(p.state)) this.positions.push(p);
        continue;
      }
      const sdt = Math.min(p.sdt, 0.2);
      p.sdt = 0;
      p.t += sdt;
      // vehicles: hits and dives
      if (AVOID.has(p.state) && p.state !== 'ragdoll' && p.state !== 'dive') this._react(p, sdt);
      // the on-foot player bumps into people
      if (pc && (WALKERS.has(p.state) || CALM.has(p.state))) {
        const dx = p.x - pc.x, dz = p.z - pc.z, d2 = dx * dx + dz * dz;
        if (d2 < 0.5 && d2 > 1e-6) {
          const d = Math.sqrt(d2), push = Math.min(0.71 - d, 2.5 * sdt); // step aside, no pops
          p.x += (dx / d) * push; p.z += (dz / d) * push;
          if (pSpeed > 5 && p.state !== 'stumble') { p.yaw = Math.atan2(-dx, -dz); this._setState(p, 'stumble', 0.9); p.fleeX = pc.x; p.fleeZ = pc.z; }
        }
      }
      p.obsOn = df < OBST_RANGE && !!this.obs;
      if (p.obsOn && (p.state === 'idle' || p.state === 'phone' || p.state === 'chat')) this._shuffleCheck(p);
      this._step(p, sdt);
      if (p.obsOn && !FLYING.has(p.state)) this._keepOut(p, sdt);
      if (this.debugJumps && p.obsOn && !FLYING.has(p.state)) this._checkInside(p);
      if (AVOID.has(p.state) && p.state !== 'ragdoll') this.positions.push(p);
      // ---- render ----
      const dc = camPos ? Math.hypot(p.x - camPos.x, p.y - camPos.y, p.z - camPos.z) : df;
      let vis = 2;
      if (camera) {
        _sph.center.set(p.x, p.y + 0.9, p.z);
        _sph.radius = p.rd ? 2.5 : 1.3;
        if (!_frustum.intersectsSphere(_sph) || dc > this.drawFar) vis = 0;
      }
      // recycle only out of view
      if (vis === 0 && !p.rd && df > 320) { this.remove(p); continue; }
      // LOD: full detail close, boxy mid range, impostor beyond; resting beach crowds use cheaper LODs sooner
      let lod = 2;
      const resting = RESTING.has(p.state);
      if (vis) {
        lod = dc < (resting ? 14 : this.lod0) ? 0 : dc < (resting ? 40 : this.lod1) ? 1 : 2;
        if (p.rd && lod === 2) lod = 1;
        if (this.forceLOD === 'near') lod = 0;
        else if (this.forceLOD === 'far' && !p.rd) lod = 2;
      }
      const was = p.near;
      p.near = vis > 0 && lod < 2;
      p.vis = vis ? (lod < 2 ? 1 : 2) : 0;
      if (this.debugJumps) this._checkJump(p, p.vis);
      p.pdt = (p.pdt || 0) + dt;
      if (p.vis === 1) {
        if (lod === 0) nNear++; else nMid++;
        // resting sunbathers barely move (pose every 3rd frame); mid LOD poses at half rate
        const skip = was && !FLYING.has(p.state) && ((resting && p.t > 1.5 && (this._frame + p.id) % 3) || (lod === 1 && (this._frame + p.id) % 2));
        if (!skip) { this._pose(p, p.pdt); p.pdt = 0; }
        this.batch.writeFigure(p.slot, p.W, p.dims, lod, dc < (resting ? 14 : this.shadowDist));
      } else if (p.vis === 2) { this._far(p, p.pdt); p.pdt = 0; nFar++; } else p.pdt = Math.min(p.pdt, 0.1);
    }
    this.batch.flush();
    const ms = performance.now() - t0;
    const st = this.stats;
    st.count = this.list.length; st.near = nNear; st.mid = nMid; st.far = nFar; st.ragdolls = this.ragdolls?.count ?? 0;
    st.ms += (ms - st.ms) * 0.05;
    st.msMax = Math.max(st.msMax * 0.995, ms);
  }

  // debug (lab soak): ped centre inside a vehicle's real body (not inflated)
  _checkInside(p) {
    const O = this.obs, S = this.insideStats;
    S.checks++;
    const list = O.at(p.x, p.z);
    for (let n = 0; n < list.length; n++) {
      const b = O.boxes[list[n]];
      if (b.hw < 0 || Math.abs(b.y - (p.y + 0.9)) > 2.6) continue;
      toLocal(b, p.x, p.z, _la);
      const d = Math.min(b.hw - Math.abs(_la.lx), b.hl - Math.abs(_la.lz));
      if (d > 0) {
        S.inside++;
        S.max = Math.max(S.max, d);
        if (S.inside < 50) console.warn(`[peds] inside vehicle by ${d.toFixed(2)} m: ped ${p.id} ${p.state} (car speed ${b.speed.toFixed(1)})`);
        return;
      }
    }
  }

  // debug (lab soak): per-frame displacement of visible pedestrians that are not flying (ragdoll/tumble/dive)
  _checkJump(p, vis) {
    const J = this.jumpStats || (this.jumpStats = { checks: 0, over: 0, max: 0, maxWhat: '', log: [] });
    if (p._jx !== undefined && p._jvis && vis && !FLYING.has(p.state) && !FLYING.has(p._jstate)) {
      const d = Math.hypot(p.x - p._jx, p.y - p._jy, p.z - p._jz);
      J.checks++;
      if (d > J.max) { J.max = d; J.maxWhat = `${p._jstate}->${p.state}/${p.mode}`; }
      if (d > 0.5) {
        J.over++;
        if (J.log.length < 300) J.log.push({ id: p.id, d: +d.toFixed(2), dy: +(p.y - p._jy).toFixed(2), from: p._jstate, to: p.state, mode: p.mode, t: +this.time.toFixed(1) });
        console.warn(`[peds] jump ${d.toFixed(2)} m: ped ${p.id} ${p._jstate}->${p.state} (${p.mode})`);
      }
    }
    p._jx = p.x; p._jy = p.y; p._jz = p.z; p._jvis = vis > 0; p._jstate = p.state;
  }

  _react(p, dt) {
    const M = this.movers;
    for (let k = 0; k < M.length; k++) {
      const b = M[k];
      const dx = p.x - b.x, dz = p.z - b.z;
      if (dx * dx + dz * dz > 400) continue;
      if (Math.abs(b.y - (p.y + 0.9)) > 2.6) continue;
      boxLocal(b, p.x, p.z, _loc);
      // padded box, extended along the motion so the hit is caught before the body is inside the car
      const ahead = b.speed * dt * 1.5;
      const inside = Math.abs(_loc.lx) < b.hw + 0.3 && Math.abs(_loc.lz) < b.hl + 0.3 + ahead;
      if (inside && b.speed > 2.5 && (dx * b.vx + dz * b.vz) > 0 && p.state !== 'tumble') {
        const n = Math.hypot(dx, dz) || 1;
        if (b.traffic && b.speed < 6) { // traffic nudging someone: step aside, stumble
          const st = Math.min(0.4, 2.5 * dt);
          p.x += (dx / n) * st; p.z += (dz / n) * st;
          if (p.state !== 'stumble' && RESTING.has(p.state) === false) { this._setState(p, 'stumble', 0.8); p.fleeX = b.x; p.fleeZ = b.z; }
          continue;
        }
        this._carHit(p, b);
        return;
      }
      if (b.speed > 5 && RESTING.has(p.state)) {
        const n = b.speed;
        const along = (dx * b.vx + dz * b.vz) / n, lat = Math.abs(dx * b.vz - dz * b.vx) / n;
        if (along > 0 && along < n * 1.6 && lat < b.hw + 1.5 && Math.random() < 0.7) { p.fleeX = b.x; p.fleeZ = b.z; this._getUp(p, 'flee', 0.7); return; }
        continue;
      }
      if (b.speed > 6 && this.time > p.scareT && (p.state === 'walk' || p.state === 'idle' || p.state === 'phone' || p.state === 'chat' || p.state === 'wander' || p.state === 'flee' || p.state === 'limp')) {
        const n = b.speed;
        const along = (dx * b.vx + dz * b.vz) / n;
        const lat = Math.abs(dx * b.vz - dz * b.vx) / n;
        if (along > 0 && along < n * 1.1 && lat < b.hw + 1.1) {
          p.scareT = this.time + 5; // one scare at a time (no cower / dive loops next to a busy road)
          if (Math.random() < 0.85) this._dive(p, b);
          else { this._setState(p, 'cower', 1 + Math.random()); p.fleeX = b.x; p.fleeZ = b.z; }
          return;
        }
      }
    }
  }

  _step(p, dt) {
    switch (p.state) {
      case 'walk': case 'limp': case 'flee': case 'stumble': {
        if (p.state === 'stumble' && p.t > (p.dur || 1.2)) { this._flee(p, p.fleeX, p.fleeZ, 8 + Math.random() * 6); break; }
        if (p.state === 'limp' && p.t > p.dur) this._setState(p, 'walk', 0);
        if (p.state === 'flee' && p.t > p.dur) { this._setState(p, p.mode === 'free' ? 'wander' : 'walk', 6); }
        const crossing = p.mode === 'cross' && p.cross.go;
        const target = p.blockT > 0 || p.waitX ? 0 : p.state === 'flee' ? 5.4 + (p.id % 5) * 0.2 : p.state === 'limp' ? 0.8 : p.state === 'stumble' ? 1.8 : crossing ? Math.max(1.45, p.base * 1.2) : p.base;
        p.speed += (target - p.speed) * Math.min(1, dt * 3);
        if (p.mode === 'path') this._followPath(p, dt);
        else if (p.mode === 'park') this._parkStep(p, dt);
        else if (p.mode === 'cross') this._crossStep(p, dt);
        else this._moveFree(p, dt, p.state === 'flee' || p.state === 'stumble' ? Math.atan2(-(p.x - p.fleeX), -(p.z - p.fleeZ)) + Math.PI : null);
        // walkers sometimes stop to look around or take a call (on the sidewalk only)
        if (p.state === 'walk' && p.mode === 'path' && p.rsT <= 0 && p.t > 6 && Math.random() < dt * 0.04) {
          if (p.look.handR === 'phone' || Math.random() < 0.25) this._setState(p, 'phone', 4 + Math.random() * 8);
          else this._setState(p, 'idle', 2 + Math.random() * 5);
        }
        break;
      }
      case 'wander': {
        p.speed += ((p.blockT > 0 ? 0 : p.base) - p.speed) * Math.min(1, dt * 2);
        this._moveFree(p, dt, null);
        if (p.t > p.dur) { if (Math.random() < 0.3 && !p.jogger) this._setState(p, 'idle', 2 + Math.random() * 6); else { p.yaw += (Math.random() - 0.5) * 1.5; p.t = 0; p.dur = 4 + Math.random() * 8; } }
        break;
      }
      case 'idle': case 'phone': case 'chat': {
        p.speed = Math.max(0, p.speed - dt * 4);
        if (p.state === 'chat' && p.faceX !== undefined) p.yaw += wrapAngle(Math.atan2(-(p.faceX - p.x), -(p.faceZ - p.z)) - p.yaw) * Math.min(1, dt * 4);
        else if (p.state === 'chat' && p.partner) p.yaw += wrapAngle(Math.atan2(-(p.partner.x - p.x), -(p.partner.z - p.z)) - p.yaw) * Math.min(1, dt * 4);
        if (p.t > p.dur) {
          if (p.partner) { const q = p.partner; p.partner = null; q.partner = null; if (q.state === 'chat') this._setState(q, q.mode === 'free' ? 'wander' : 'walk', 6); }
          this._setState(p, p.mode === 'free' ? 'wander' : 'walk', 6);
        }
        break;
      }
      case 'shuffle': {
        p.speed = 1.4;
        p.x += p.vx * dt; p.z += p.vz * dt;
        p.yaw += wrapAngle(Math.atan2(-p.vx, -p.vz) - p.yaw) * Math.min(1, dt * 8);
        smoothY(p, p.mode === 'path' && p.e ? this.sidewalkPoint(p.e, p.s, p.side, p.sp).y : this._groundAt(p, dt), dt);
        if (p.t > p.dur) this._setState(p, p.mode === 'free' ? 'wander' : 'walk', 6);
        break;
      }
      case 'sunbathe': case 'sit':
        p.speed = 0;
        if (p.t > p.dur) this._getUp(p, null);
        break;
      case 'cower':
        p.speed = 0;
        smoothY(p, this._groundAt(p, dt), dt);
        if (p.t > Math.min(p.dur, 3)) this._flee(p, p.fleeX, p.fleeZ, 8 + Math.random() * 5);
        break;
      case 'dive': {
        p.vy -= 9.81 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        const gy = Math.max(this._groundAt(p, dt), -1.2);
        if ((p.y <= gy && p.vy < 0) || p.t > 2.5) { // landed (or a watchdog: never stuck mid-air)
          p.y = gy; p.yv = 0;
          p.vx = p.vy = p.vz = 0;
          p.faceUp = false;
          this._setState(p, 'down', 0.5 + Math.random() * 0.8);
        }
        break;
      }
      case 'tumble': {
        // same arcs as the ragdolls (impact.js tumbleStep)
        const gy = Math.max(this._groundAt(p, dt), -1.2);
        p.rot = p.P[ROOT + 3];
        const done = tumbleStep(p, dt, gy) || p.t > 10;
        p.P[ROOT + 3] = p.rot;
        if (!p.air) p.yv = 0;
        if (done) {
          p.vx = p.vz = 0;
          const r = wrapAngle(p.P[ROOT + 3]);
          p.P[ROOT + 3] = r;
          p.faceUp = r > 0;
          this._setState(p, 'down', 2 + Math.random() * 2.5);
        }
        break;
      }
      case 'ragdoll': {
        const rd = p.rd;
        if (!rd || rd.released) { p.rd = null; this._setState(p, 'down', 1); break; }
        if (p.t > 25) { this._fromRagdoll(p); break; } // never left lying in a ragdoll forever
        const t = this.ragdolls.pelvis(rd);
        p.x = t.x; p.z = t.z; p.y = t.y - 0.1;
        if (rd.settled) this._fromRagdoll(p);
        break;
      }
      case 'down':
        smoothY(p, this._groundAt(p, dt), dt);
        if (p.t > Math.min(p.dur, 8)) { p.gu = 0; this._setState(p, 'getup', 1.4); }
        break;
      case 'getup':
        smoothY(p, this._groundAt(p, dt), dt);
        if (p.t > Math.min(p.dur || 1.4, 3)) {
          if (p.after) { const a = p.after; p.after = null; if (a === 'flee') this._flee(p, p.fleeX, p.fleeZ, 8 + Math.random() * 6); else this._setState(p, a, 10 + Math.random() * 20); break; }
          this._resnap(p, !p.beach && !p.sandOnly);
          const r = Math.random();
          if (p.knocks && r < 0.35) this._setState(p, 'limp', 10 + Math.random() * 10);
          else if (p.knocks || r < 0.6) this._flee(p, p.fleeX || p.x + 1, p.fleeZ || p.z, 6 + Math.random() * 6);
          else this._setState(p, p.mode === 'free' ? 'wander' : 'walk', 6);
        }
        break;
      default: break;
    }
  }

  // Carrot following: the path parameter s only advances while the ped is close to it; the ped walks towards
  // the carrot at its own speed (never faster), turning smoothly. Route changes (next edge, dead ends, fleeing
  // the other way) move the carrot, and the ped walks there instead of being snapped.
  // carrot on the sidewalk path, shifted outwards by p.shift (passing cars parked along the kerb)
  _pathPoint(p) {
    const q = this.sidewalkPoint(p.e, p.s, p.side, p.sp);
    if (p.shift > 0.005) { q.x += q.nx * p.shift; q.z += q.nz * p.shift; }
    return q;
  }

  // lateral shift so the path clears vehicles standing along it: rises quickly, relaxes slowly after a hold, so a
  // row of parked cars is passed on one line instead of zigzagging between them
  _updateShift(p, q, dt) {
    const bx = q.x - q.nx * p.shift, bz = q.z - q.nz * p.shift; // unshifted path point
    let want = 0;
    if (this._insideAny(bx, bz, q.y, null, 0.2)) {
      want = -1;
      const maxS = (this._swWidth(p.e) || 2.4) / 2 + 0.5;
      const G = this.terrain?.G;
      for (let k = 1; k <= 6; k++) {
        const sh = Math.min(maxS, k * 0.35);
        const x = bx + q.nx * sh, z = bz + q.nz * sh;
        if (!this._insideAny(x, z, q.y, null, 0.2) && !(G && this.terrain.groundAt(x, z) === G.building)) { want = sh; break; }
        if (sh >= maxS) break;
      }
    }
    if (want < 0) return; // no room beside it: the carrot skip and the detour handle it
    if (want > 0) p.shiftHold = 1.5;
    if (want > p.shift) p.shift = Math.min(want, p.shift + dt * 1.1);
    else if ((p.shiftHold -= dt) <= 0) p.shift = Math.max(want, p.shift - dt * 0.45);
  }

  _followPath(p, dt) {
    const sp = p.speed;
    const w = this._walk(p.e, p.side); // null: legacy edge without a sidewalk run (whole edge)
    const a = w ? w.a : 0, b = w ? w.b : p.e.len;
    if (p.s < a || p.s > b) p.s = Math.min(Math.max(p.s, a), b);
    let q = this._pathPoint(p);
    if (p.obsOn) this._updateShift(p, q, dt);
    else p.shift = Math.max(0, p.shift - dt * 0.45);
    q = this._pathPoint(p);
    let dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
    // far from the carrot (pushed, knocked down, a route change on the other side): back to the nearest sidewalk
    // point instead of cutting across the road
    if ((p.rsT -= dt) <= 0 && d > 9) {
      p.rsT = 1;
      this._resnap(p, true);
      if (p.mode !== 'path') return;
      q = this._pathPoint(p);
      dx = q.x - p.x; dz = q.z - p.z; d = Math.hypot(dx, dz);
    }
    if (d < 1.0) {
      p.s += (sp * dt + Math.max(0, 0.6 - d) * dt * 2) * p.dir;
      if (this._routeAt(p, w)) return;
      q = this._pathPoint(p);
    }
    // a vehicle standing across the path: move the carrot past it (up to 12 m), the ped then walks around
    if (p.obsOn) {
      let k = 0;
      while (k < 24 && this._insideAny(q.x, q.z, q.y, null)) {
        p.s += 0.5 * p.dir;
        if (this._routeAt(p, this._walk(p.e, p.side))) return;
        q = this._pathPoint(p);
        k++;
      }
    }
    dx = q.x - p.x; dz = q.z - p.z; d = Math.hypot(dx, dz);
    if (this._walkTo(p, q.x, q.z, d, dt) === 2) { // blocked on both sides: wait, then turn around
      if (p.blockT > p.blockLim) { p.dir = -p.dir; p.blockT = 0; p.planK = ''; }
    }
    smoothY(p, q.y, dt);
  }

  // route events along the run after the carrot moved: junction decisions, crossings, run ends.
  // returns true when the ped left path mode (started crossing)
  _routeAt(p, w) {
    const e = p.e, a = w ? w.a : 0, b = w ? w.b : e.len;
    const endKind = w ? (p.dir > 0 ? w.endB : w.endA) : 'n';
    const toEnd = p.dir > 0 ? b - p.s : p.s - a;
    if (endKind === 'j' && toEnd < 5 && (!p.planK || p.planK === 'nocross')) this._plan(p, p.planK === 'nocross' || p.state === 'flee');
    // a planned crossing: start at the zebra
    if ((p.planK === 'xA' || p.planK === 'cross') && (p.s - p.planSx) * p.dir >= 0) {
      p.s = p.planSx;
      this._startCross(p);
      return p.mode === 'cross';
    }
    if (p.s >= a && p.s <= b) return false;
    p.s = Math.min(Math.max(p.s, a), b);
    if (endKind === 'j') {
      if (!p.planK || p.planK === 'nocross' || p.planK === 'cross' || p.planK === 'xA') this._plan(p, true);
      const k = p.planK;
      if (k === 'turn' || k === 'xP') {
        this._enterArm(p, p.planArm, p.planSide);
        if (k === 'xP') { p.planK = 'cross'; p.planSx = this._xwalkS(p.planArm); } else p.planK = '';
        return false;
      }
      p.planK = '';
      p.dir = -p.dir;
      return false;
    }
    if (endKind === 'n' && this._nextEdge(p)) return false;
    p.dir = -p.dir; // dead end, or a gap in the sidewalk: walk back
    p.planK = '';
    return false;
  }

  // junction helpers: arm i of node ni for edge e, zebra position on an arm, walkable mouth of an arm side
  _armAt(e, ni) {
    const J = this.roads.junctions?.[ni];
    if (!J?.arms) return -1;
    for (let i = 0; i < J.arms.length; i++) { const A = J.arms[i]; if (A.e === e && (A.fromA ? e.a : e.b) === ni) return i; }
    return -1;
  }

  _xwalkS(A) {
    const tr = this._trimOf(A.e, A.fromA ? 0 : 1);
    if (!tr?.xwalk) return null;
    return A.fromA ? tr.t + XWALK_OFF : A.e.len - tr.t - XWALK_OFF;
  }

  _mouth(A, side) {
    const w = this._walk(A.e, side);
    if (!w) return null;
    return A.fromA ? (w.endA === 'j' ? w.a : null) : (w.endB === 'j' ? w.b : null);
  }

  _enterArm(p, A, side) {
    p.e = A.e; p.side = side; p.s = this._mouth(A, side) ?? (A.fromA ? 0.5 : A.e.len - 0.5);
    p.dir = A.fromA ? 1 : -1; p.sp.k = 0; p.shift = 0;
    // rounding the corner (urban corners span up to ~20 m): no resnap until the ped is there
    const q = this.sidewalkPoint(p.e, p.s, side, this._tmp);
    p.rsT = Math.min(20, Math.hypot(q.x - p.x, q.z - p.z) / 0.8 + 3);
  }

  /**
   * What to do at the junction ahead (urban junctions: corner pieces + zebras):
   *   turn: round the corner into the neighbouring arm on this side;
   *   xP:   round the corner, then cross that arm at its zebra (= straight on through the junction);
   *   xA:   cross this arm at its zebra; back: turn around.
   */
  _plan(p, noCross = false) {
    const e = p.e, ni = p.dir > 0 ? e.b : e.a;
    const J = this.roads.junctions?.[ni], i = this._armAt(e, ni);
    p.planK = 'back';
    if (i < 0) return;
    const arms = J.arms, n = arms.length, A = arms[i];
    const sOut = A.fromA ? p.side : -p.side; // +1: left of the arm's outward direction
    const k = sOut > 0 ? (i + 1) % n : (i + n - 1) % n;
    const P = k !== i ? arms[k] : null;
    const pSide = P ? (P.fromA ? -sOut : sOut) : 0; // partner's edge side on this corner
    const canTurn = !!P && P.e !== e && this._mouth(P, pSide) !== null && this._cornerOk(ni, A, p.side, P, pSide);
    const sxA = noCross ? null : this._xwalkS(A);
    const canXA = sxA !== null && (sxA - p.s) * p.dir > -0.3 && this._mouth(A, -p.side) !== null && this._waiting(ni, e) < 3;
    const sxP = canTurn && !noCross ? this._xwalkS(P) : null;
    const canXP = sxP !== null && this._mouth(P, -pSide) !== null && this._waiting(ni, P.e) < 3;
    const wT = canTurn ? 1 : 0, wP = canXP ? 1.1 : 0, wA = canXA ? 0.55 : 0, wB = wT + wP + wA > 0 ? 0.05 : 1;
    let r = Math.random() * (wT + wP + wA + wB);
    if ((r -= wT) < 0) { p.planK = 'turn'; p.planArm = P; p.planSide = pSide; return; }
    if ((r -= wP) < 0) { p.planK = 'xP'; p.planArm = P; p.planSide = pSide; p.planNi = ni; return; }
    if ((r -= wA) < 0) { p.planK = 'xA'; p.planSx = sxA; p.planNi = ni; }
  }

  // the straight walk round a corner (mouth to mouth) must stay off the asphalt: reflex corners (Y junctions, bends
  // > 180°) and far-apart mouths are not walkable (cached per corner)
  _cornerOk(ni, A, side, P, pSide) {
    const key = `${ni}:${A.e.i}:${side}:${P.e.i}:${pSide}`;
    const M = (this._corners ||= new Map());
    const got = M.get(key);
    if (got !== undefined) return got;
    const qa = this.sidewalkPoint(A.e, this._mouth(A, side), side, this._tmp), ax = qa.x, az = qa.z, ay = qa.y - 0.2;
    const qb = this.sidewalkPoint(P.e, this._mouth(P, pSide), pSide, this._tmp), bx = qb.x, bz = qb.z;
    const L = Math.hypot(bx - ax, bz - az);
    let ok = L < 40;
    for (let k = 1; ok && k * 1.5 < L; k++) {
      const t = (k * 1.5) / L, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      if (this._onCarriageway(x, z, ay) || this.roads.inJunction?.(x, z, ay)) ok = false;
    }
    M.set(key, ok);
    return ok;
  }

  // peds waiting at (or crossing) the zebra of edge e at node ni
  _waiting(ni, e) {
    let n = 0;
    for (const q of this.list) if (q.mode === 'cross' && q.cross.ni === ni && q.cross.e === e) n++;
    return n;
  }

  // walk to the kerb at the zebra of the current arm, wait for a gap / the lights, then cross straight over
  _startCross(p) {
    const e = p.e, ni = p.planNi;
    const c = p.cross || (p.cross = { e: null, ni: 0, s: 0, toSide: 1, x0: 0, z0: 0, y0: 0, x1: 0, z1: 0, y1: 0, ry: 0, len: 1, half: 1, go: false, wait: 0, chk: 0 });
    const A = this.sidewalkPoint(e, p.s, p.side, this._tmp);
    c.x0 = A.x; c.z0 = A.z; c.y0 = A.y;
    const B = this.sidewalkPoint(e, p.s, -p.side, this._tmp);
    c.x1 = B.x; c.z1 = B.z; c.y1 = B.y;
    c.e = e; c.ni = ni; c.s = p.s; c.toSide = -p.side;
    c.len = Math.hypot(c.x1 - c.x0, c.z1 - c.z0) || 1;
    c.half = e.w / 2;
    c.ry = Math.min(c.y0, c.y1) - KERB;
    c.go = false; c.wait = 0; c.chk = 0;
    p.planK = '';
    p.mode = 'cross';
  }

  _crossStep(p, dt) {
    const c = p.cross;
    if (!c.go) {
      const dx = c.x0 - p.x, dz = c.z0 - p.z, d = Math.hypot(dx, dz);
      if (d > 0.3) { this._walkTo(p, c.x0, c.z0, d, dt); smoothY(p, c.y0, dt); return; }
      p.waitX = true; // idle at the kerb, facing the road
      p.yaw += wrapAngle(Math.atan2(-(c.x1 - c.x0), -(c.z1 - c.z0)) - p.yaw) * Math.min(1, dt * 4);
      c.wait += dt;
      if ((c.chk -= dt) <= 0) {
        c.chk = 0.3;
        if (this._canCross(c)) { c.go = true; p.waitX = false; }
      }
      if (!c.go && c.wait > 35) { // gave up: walk on along this side
        p.waitX = false; p.mode = 'path'; p.planK = 'nocross';
        p.dir = c.e.a === c.ni ? -1 : 1;
      }
      smoothY(p, c.y0, dt);
      return;
    }
    const dx = c.x1 - p.x, dz = c.z1 - p.z, d = Math.hypot(dx, dz);
    if (d < 0.3) {
      // on the other kerb: back on the sidewalk path; round the corner on this side or walk on along the arm
      p.mode = 'path'; p.e = c.e; p.side = c.toSide; p.s = c.s; p.sp.k = 0; p.shift = 0; p.rsT = 3;
      const toNode = c.e.a === c.ni ? -1 : 1;
      if (Math.random() < 0.6) { p.dir = toNode; p.planK = 'nocross'; } else { p.dir = -toNode; p.planK = ''; }
      return;
    }
    this._walkTo(p, c.x1, c.z1, d, dt);
    // kerb, road surface, kerb
    const u = ((p.x - c.x0) * (c.x1 - c.x0) + (p.z - c.z0) * (c.z1 - c.z0)) / c.len;
    const off = Math.abs(u - c.len / 2);
    smoothY(p, off < c.half ? c.ry : u < c.len / 2 ? c.y0 : c.y1, dt);
  }

  // lights red for the cars of this arm (or no lights), and no vehicle on the zebra or about to reach it
  _canCross(c) {
    const L = this.game?.traffic?.lights;
    if (L?.nodes?.has?.(c.ni) && !L.brokenNodes?.has?.(c.ni) && L.state(c.ni, c.e.i) !== 0) return false;
    const O = this.obs;
    if (!O) return true;
    const ux = (c.x1 - c.x0) / c.len, uz = (c.z1 - c.z0) / c.len, mx = (c.x0 + c.x1) / 2, mz = (c.z0 + c.z1) / 2;
    const hl = c.len / 2 + 0.6, hw = 1.9;
    for (let i = 0; i < O.n; i++) {
      const b = O.boxes[i];
      if (b.hw < 0 || Math.abs(b.y - (c.ry + 0.9)) > 3) continue;
      const rx = b.x - mx, rz = b.z - mz;
      if (rx * rx + rz * rz > 3600) continue;
      if (b.speed < 0.6) { // standing on the zebra?
        toLocal(b, c.x0, c.z0, _la);
        toLocal(b, c.x1, c.z1, _lb);
        if (segHitsBox(_la.lx, _la.lz, _lb.lx, _lb.lz, b.hw + 0.4, b.hl + 0.4)) return false;
        continue;
      }
      // moving: where its centre goes in the next 3.5 s, in zebra coordinates (u across the road, v along it)
      const u0 = rx * ux + rz * uz, v0 = -rx * uz + rz * ux;
      const ex = rx + b.vx * 3.5, ez = rz + b.vz * 3.5;
      const u1 = ex * ux + ez * uz, v1 = -ex * uz + ez * ux;
      if (segHitsBox(u0, v0, u1, v1, hl + b.hw, hw + b.hl)) return false;
    }
    return true;
  }

  // walk towards (tx, tz) at the ped's speed, detouring around vehicles; returns 0 clear, 1 detour, 2 blocked
  _walkTo(p, tx, tz, d, dt) {
    const st = this._steer(p, tx, tz);
    if (st === 2) {
      p.blockT = (p.blockT || 0) + dt;
      p.blockLim ||= 2.5 + Math.random() * 2;
      return 2;
    }
    p.blockT = 0;
    if (st === 1) { tx = this._st.x; tz = this._st.z; }
    const dx = tx - p.x, dz = tz - p.z;
    const dd = st === 1 ? Math.hypot(dx, dz) : d;
    if (dd > 1e-4) {
      const step = Math.min(dd, p.speed * dt);
      p.x += (dx / dd) * step;
      p.z += (dz / dd) * step;
      if (dd > 0.05) p.yaw += wrapAngle(Math.atan2(-dx, -dz) - p.yaw) * Math.min(1, dt * 7);
    }
    return st;
  }

  // inside any inflated vehicle box near (x, z)? (except one box)
  _insideAny(x, z, y, except, extra = 0) {
    const O = this.obs;
    if (!O) return false;
    const list = O.at(x, z);
    const m = INFLATE + extra;
    for (let n = 0; n < list.length; n++) {
      const b = O.boxes[list[n]];
      if (b === except || b.hw < 0 || Math.abs(b.y - (y + 0.9)) > 2.6) continue;
      toLocal(b, x, z, _la);
      if (Math.abs(_la.lx) < b.hw + m && Math.abs(_la.lz) < b.hl + m) return true;
    }
    return false;
  }

  /**
   * Vehicle on the way to (tx, tz) within 4 m? Picks a tangent detour corner of its inflated box
   * (the reachable corner with the shortest path to the target, not inside another vehicle).
   * @returns {number} 0 clear, 1 detour (this._st = steering point), 2 blocked both ways
   */
  _steer(p, tx, tz) {
    const O = this.obs;
    if (!O || !p.obsOn) return 0;
    const list = O.at(p.x, p.z);
    if (!list.length) return 0;
    const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
    if (d < 1e-4) return 0;
    const L = Math.min(d, 4), ex = p.x + (dx / d) * L, ez = p.z + (dz / d) * L;
    let hit = null, hd = Infinity;
    for (let n = 0; n < list.length; n++) {
      const b = O.boxes[list[n]];
      if (b.hw < 0 || Math.abs(b.y - (p.y + 0.9)) > 2.6) continue;
      const ax = b.hw + INFLATE, az = b.hl + INFLATE;
      toLocal(b, p.x, p.z, _la);
      if (Math.abs(_la.lx) < ax && Math.abs(_la.lz) < az) continue; // inside: the hard push handles it
      toLocal(b, ex, ez, _lb);
      if (!segHitsBox(_la.lx, _la.lz, _lb.lx, _lb.lz, ax, az)) continue;
      const bd = Math.hypot(b.x - p.x, b.z - p.z);
      if (bd < hd) { hd = bd; hit = b; }
    }
    if (!hit) return 0;
    // shortest way around the rectangle: visible corners (not the one we are standing at), then either straight to
    // the target or on via the cheaper adjacent corner
    const b = hit, ax = b.hw + INFLATE + 0.25, az = b.hl + INFLATE + 0.25, sx = ax - 0.3, sz = az - 0.3;
    toLocal(b, p.x, p.z, _la);
    toLocal(b, tx, tz, _lb);
    let k1 = -1, c1 = Infinity, k2 = -1, c2 = Infinity;
    for (let k = 0; k < 4; k++) {
      const cx = k & 1 ? ax : -ax, cz = k & 2 ? az : -az;
      const dpc = Math.hypot(cx - _la.lx, cz - _la.lz);
      if (dpc < 0.35) continue; // already here: go on to the next corner
      if (segHitsBox(_la.lx, _la.lz, cx, cz, sx, sz)) continue; // hidden behind the car
      let cost = dpc;
      if (!segHitsBox(cx, cz, _lb.lx, _lb.lz, sx, sz)) cost += Math.hypot(_lb.lx - cx, _lb.lz - cz);
      else {
        const ex = -cx, ez = -cz; // adjacent corners: (ex, cz) and (cx, ez)
        cost += Math.min(Math.abs(ex - cx) + Math.hypot(_lb.lx - ex, _lb.lz - cz), Math.abs(ez - cz) + Math.hypot(_lb.lx - cx, _lb.lz - ez));
      }
      if (cost < c1) { k2 = k1; c2 = c1; k1 = k; c1 = cost; } else if (cost < c2) { k2 = k; c2 = cost; }
    }
    // sidewalk walkers prefer the corner that keeps them off the asphalt; the road side only if nothing else works
    let road = -1;
    for (let t = 0; t < 2; t++) {
      const k = t ? k2 : k1;
      if (k < 0) continue;
      toWorld(b, k & 1 ? ax : -ax, k & 2 ? az : -az, this._st);
      if (this._insideAny(this._st.x, this._st.z, p.y, b)) continue;
      const G = this.terrain?.G, gr = G ? this.terrain.groundAt(this._st.x, this._st.z) : null;
      if (G && (gr === G.building || gr === G.water)) continue; // no detours through walls or into the sea
      if (p.mode === 'path' && road < 0 && this._onCarriageway(this._st.x, this._st.z, p.y)) { road = k; continue; }
      return 1;
    }
    if (road >= 0) { toWorld(b, road & 1 ? ax : -ax, road & 2 ? az : -az, this._st); return 1; }
    return 2;
  }

  // hard guarantee: a ped centre inside an inflated vehicle box is pushed out along the shortest axis,
  // never faster than the car + 1.5 m/s (smooth over a few frames, no teleports)
  _keepOut(p, dt) {
    const O = this.obs;
    if (!O) return;
    const list = O.at(p.x, p.z);
    for (let n = 0; n < list.length; n++) {
      const b = O.boxes[list[n]];
      if (b.hw < 0 || Math.abs(b.y - (p.y + 0.9)) > 2.6) continue;
      const ax = b.hw + INFLATE, az = b.hl + INFLATE;
      toLocal(b, p.x, p.z, _la);
      const px = ax - Math.abs(_la.lx), pz = az - Math.abs(_la.lz);
      if (px <= 0 || pz <= 0) continue;
      const maxStep = Math.max(2.5, b.speed + 1.5) * dt;
      if (px < pz) {
        const st = Math.min(px, maxStep) * (Math.sign(_la.lx) || 1);
        p.x += b.c * st; p.z -= b.s * st;
      } else {
        const st = Math.min(pz, maxStep) * (Math.sign(_la.lz) || 1);
        p.x += b.s * st; p.z += b.c * st;
      }
    }
  }

  // a car creeping towards someone standing (walking pace): step out of its way
  _shuffleCheck(p) {
    const O = this.obs;
    if (!O) return;
    const list = O.at(p.x, p.z);
    for (let n = 0; n < list.length; n++) {
      const b = O.boxes[list[n]];
      if (b.hw < 0 || b.speed < 0.3 || b.speed > 2.8 || Math.abs(b.y - (p.y + 0.9)) > 2.6) continue;
      if ((p.x - b.x) * b.vx + (p.z - b.z) * b.vz <= 0) continue; // moving away
      toLocal(b, p.x, p.z, _la);
      if (Math.abs(_la.lx) > b.hw + INFLATE + 0.4 || Math.abs(_la.lz) > b.hl + INFLATE + 1.8) continue;
      const side = Math.sign(_la.lx) || (p.id % 2 ? 1 : -1);
      const v = 1.4;
      p.vx = b.c * side * v; p.vz = -b.s * side * v;
      if (p.partner) { p.partner.partner = null; p.partner = null; }
      p.prevState = p.state;
      this._setState(p, 'shuffle', 0.9 + Math.random() * 0.5);
      return;
    }
  }

  _moveFree(p, dt, wantYaw) {
    if (wantYaw !== null) p.yaw += wrapAngle(wantYaw - p.yaw) * Math.min(1, dt * 5);
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    // stay on dry walkable ground (beach / park / pavement)
    const ax = p.x + fx * 2.5, az = p.z + fz * 2.5;
    const G = this.terrain.G, gr = this.terrain.groundAt(ax, az);
    if (p.shore && wantYaw === null) {
      // keep walking along the waterline: hold the ground height around 0.1..0.5 m
      const ha = this.terrain.heightAt(ax, az);
      const lx = p.x + fz * 2, lz = p.z - fx * 2;
      const side = this.terrain.heightAt(lx, lz) > this.terrain.heightAt(p.x - fz * 2, p.z + fx * 2) ? 1 : -1; // +1: left is higher
      const err = ha - 0.3;
      p.yaw += clamp(err * 2.5, -1, 1) * -side * dt * 1.2;
      if (gr !== G.sand && gr !== G.water) p.yaw += dt * 3.0;
    } else if ((p.sandOnly && gr !== G.sand) || this.terrain.heightAt(ax, az) < 0.15 || gr === G.water || gr === G.building || gr === G.wetland) {
      p.yaw += (p.id % 2 ? 1 : -1) * Math.min(1, dt * 3.5);
      if (wantYaw === null) return;
    }
    if (p.obsOn) {
      const st = this._walkTo(p, p.x + fx * 4, p.z + fz * 4, 4, dt);
      if (st === 2 && p.blockT > p.blockLim) { p.yaw += Math.PI; p.blockT = 0; }
    } else { p.x += fx * p.speed * dt; p.z += fz * p.speed * dt; }
    smoothY(p, this._groundAt(p, dt), dt);
  }

  // walkable height under a free-moving ped: terrain on sand, otherwise a (throttled) physics ray so raised
  // sidewalks, bridges and road decks are respected
  _groundAt(p, dt) {
    if (p.sandOnly || !this.game?.world) return Math.max(this.terrain.heightAt(p.x, p.z), 0);
    p.gyT = (p.gyT ?? 0) - dt;
    if (p.gyT <= 0 || p.gyc === undefined) {
      p.gyT = 0.2;
      p.gyc = groundY(this.game, p.x, p.z, p.y + 1.0);
    }
    return Math.max(p.gyc, 0);
  }

  // plain node (no junction): continue on the sidewalk of the next edge, same side of the street; false = none
  _nextEdge(p) {
    const R = this.roads, e0 = p.e, ni = p.dir > 0 ? e0.b : e0.a;
    const cur = this.sidewalkPoint(e0, p.s, p.side, this._tmp);
    const cx = cur.x, cz = cur.z, hx = cur.tx * p.dir, hz = cur.tz * p.dir;
    let best = null, bw = -Infinity, bside = 1;
    for (const ei of R.adj[ni]) {
      const e = R.edges[ei];
      if (e === e0 || e.kind === 1) continue;
      const fromA = e.a === ni;
      for (let sd = -1; sd <= 1; sd += 2) {
        const w = this._walk(e, sd);
        if (!w || (fromA ? w.endA : w.endB) !== 'n') continue;
        const q = this.sidewalkPoint(e, fromA ? w.a : w.b, sd, this._tmp2);
        const gap = Math.hypot(q.x - cx, q.z - cz);
        if (gap > 7) continue; // the other side of the street
        const sc = Math.max(0, hx * q.tx * (fromA ? 1 : -1) + hz * q.tz * (fromA ? 1 : -1)) + Math.random() * 0.8 - gap * 0.15;
        if (sc > bw) { bw = sc; best = e; bside = sd; }
      }
    }
    if (!best) return false;
    const fromA = best.a === ni, w = this._walk(best, bside);
    p.e = best; p.side = bside; p.s = fromA ? w.a : w.b; p.dir = fromA ? 1 : -1; p.sp.k = 0; p.planK = ''; p.rsT = 3;
    return true;
  }

  // back onto the nearest sidewalk run (after free movement, a fall, a push): the ped then walks to it (no snapping)
  _resnap(p, force = false) {
    if (p.mode === 'free' && !p.adopted && !force) return;
    if (p.beach || p.sandOnly) return;
    if (p.park) { this._parkResnap(p); return; }
    const n = this.roads.nearest(p.x, p.z, 60, (e) => this._swWidth(e) > 0 && !e.internal && e.kind !== 1);
    if (!n) { if (p.mode !== 'path') p.mode = 'free'; return; }
    const e = n.edge, s0 = e.cum[n.seg] + n.t * (e.cum[n.seg + 1] - e.cum[n.seg]);
    let bd = Infinity, bs = 0, bside = 0;
    for (let sd = -1; sd <= 1; sd += 2) {
      const w = this._walk(e, sd);
      if (!w) continue;
      const s = Math.min(Math.max(s0, w.a), w.b);
      const q = this.sidewalkPoint(e, s, sd, this._tmp);
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < bd) { bd = d; bs = s; bside = sd; }
    }
    if (!bside) { if (p.mode !== 'path') p.mode = 'free'; return; }
    if (p.mode === 'path' && p.e === e && p.side === bside && Math.abs(p.s - bs) < 3) return;
    p.e = e; p.s = bs; p.side = bside; p.sp.k = 0; p.shift = 0; p.planK = ''; p.rsT = 4;
    if (p.mode !== 'path') p.dir = Math.random() < 0.5 ? -1 : 1;
    p.mode = 'path';
    p.adopted = false;
    p.waitX = false;
  }

  // ---------------- animation ----------------
  _pose(p, dt) {
    const d = p.dims, T = p.T, P = p.P;
    let k = 1 - Math.exp(-dt * 10);
    switch (p.state) {
      case 'ragdoll':
        if (p.rd && !p.rd.released) { this.ragdolls.writeJoints(p.rd, p.W); return; }
        PZ.poseLie(T, p.faceUp, this.time, d, p.seed);
        break;
      case 'walk': case 'wander': case 'flee': case 'limp': case 'stumble': case 'shuffle': {
        if ((p.blockT > 0.3 || p.waitX) && p.speed < 0.35) { PZ.poseIdle(T, this.time, p.seed, d); break; } // waiting: car / kerb
        const sp = Math.max(0.3, p.speed);
        p.phase += (dt * Math.PI * sp) / PZ.stepLength(sp, d);
        const o = this._q;
        o.limp = p.state === 'limp' ? 1 : 0;
        o.carry = p.hold.bagL && p.state !== 'flee' ? 1 : 0;
        o.carryR = p.hold.bagR && p.state !== 'flee' ? 1 : 0;
        o.phoneR = p.hold.phone && p.state === 'walk' ? p.phoneMode : 0;
        o.stumble = p.state === 'stumble' ? 1 : 0;
        o.time = this.time + p.seed;
        PZ.poseGait(T, p.phase, sp, d, o);
        break;
      }
      case 'idle': PZ.poseIdle(T, this.time, p.seed, d); break;
      case 'phone':
        PZ.poseIdle(T, this.time, p.seed, d);
        if (p.phoneMode === 1) PZ.phoneEar(T); else PZ.phoneText(T);
        break;
      case 'chat': PZ.poseIdle(T, this.time, p.seed, d); PZ.poseChat(T, this.time, Math.floor(p.seed)); break;
      case 'cower': PZ.poseCower(T, this.time, d); k = 1 - Math.exp(-dt * 14); break;
      case 'dive': PZ.poseDive(T, Math.min(1, p.t / 0.7), d); k = 1 - Math.exp(-dt * 14); break;
      case 'tumble': {
        const r = P[ROOT + 3];
        PZ.poseTumble(T, this.time, d);
        T[ROOT + 3] = r;
        break;
      }
      case 'down': PZ.poseLie(T, p.faceUp, this.time, d, p.seed); k = 1 - Math.exp(-dt * 5); break;
      case 'getup': { const u0 = p.gu0 || 0; PZ.poseGetUp(T, u0 + (1 - u0) * Math.min(1, p.t / p.dur), p.faceUp, d); k = 1 - Math.exp(-dt * 9); break; }
      case 'sunbathe': PZ.poseSunbathe(T, p.faceUp, p.variant, this.time + p.seed, d); k = 1 - Math.exp(-dt * 4); break;
      case 'sit': PZ.poseSitGround(T, p.variant, this.time + p.seed, d); k = 1 - Math.exp(-dt * 4); break;
      default: PZ.poseIdle(T, this.time, p.seed, d);
    }
    PZ.blendPose(P, T, k);
    pelvisMatrix(_M, p.x, p.y, p.z, p.yaw, P, d);
    fk(p.W, _M, P, d);
  }

  _far(p, dt) {
    const moving = WALKERS.has(p.state) || p.state === 'wander';
    if (moving) p.phase += (dt * Math.PI * p.speed) / 0.75;
    const amp = moving ? Math.min(0.85, 0.3 + p.speed * 0.12) : 0;
    const lying = p.state === 'down' || p.state === 'tumble' || p.state === 'getup' || p.state === 'ragdoll' || p.state === 'sunbathe';
    const tilt = lying ? (p.faceUp ? Math.PI / 2 : -Math.PI / 2) : p.state === 'dive' ? -1.2 : 0;
    const y = lying ? p.y + 0.12 : p.y;
    this.batch.writeFar(p.slot, p.x, y, p.z, p.yaw, p.dims.h, p.phase, amp, tilt);
  }

  dispose() {
    for (const off of this._off || []) off();
    this.clear();
    this.batch.dispose();
    for (const m of [this.towels, this.parasols]) { m.removeFromParent(); m.dispose(); }
  }
}
