import * as THREE from 'three';
import { bakeCar, trafficBodyMaterial } from './TrafficModels.js';
import { SIGNAL_UNIFORMS, MAX_SIGNALS, patchFakeLights } from './fakeLights.js';
import { PropField, stopSignGeometry } from './Junctions.js';

// default traffic mix (tier: 0 poor .. 1 rich, w: base frequency); replaced by the full catalog via setCatalog()
const TYPES = [
  { name: 'suv', tier: 0.55, w: 3.0 }, { name: 'pickup', tier: 0.25, w: 2.2 }, { name: 'cruiser', tier: 0.5, w: 0.5 },
  { name: 'muscle', tier: 0.4, w: 1.4 }, { name: 'comet', tier: 0.7, w: 1.2 }, { name: 'super', tier: 0.97, w: 0.35 },
];
const PAINTS = [0xf2f2f2, 0x1b1d22, 0x8c939c, 0xb3202e, 0x234e8f, 0xe8d9b5, 0x2d6b4f, 0xff4fa0, 0x2fd6d0, 0xf5b83d, 0x6b3fa0, 0xc75b2a, 0x9fb7c9, 0x3a3a3a];
const IDM = { a: 2.2, b: 3.2, T: 1.15, s0: 3.2 };
const TMP = new THREE.Vector3();

function lanesFor(e) {
  if (e.oneway) return Math.max(1, Math.min(4, Math.round(e.w / 3.7)));
  if (e.kind === 1) return Math.max(1, Math.min(3, Math.round(e.w / 7.4)));
  if (e.kind === 2) return 1;
  return e.w >= 12.5 ? 2 : 1;
}

const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);
function defaultWheels(tb) {
  const out = [];
  for (let w = 0; w < 4; w++) {
    const front = w < 2, left = w % 2 === 0;
    const tr = tb.track[front ? 0 : 1] / 2;
    out.push({ x: left ? -tr : tr, y: tb.radius, z: front ? -tb.wheelbase / 2 : tb.wheelbase / 2, front, left });
  }
  return out;
}

// minimum distance between 2D segments AB and CD
function segDist(ax, az, bx, bz, cx, cz, dx, dz) {
  const pt = (px, pz, x0, z0, x1, z1) => {
    const ux = x1 - x0, uz = z1 - z0, L2 = ux * ux + uz * uz || 1e-9;
    const t = Math.max(0, Math.min(1, ((px - x0) * ux + (pz - z0) * uz) / L2));
    return Math.hypot(px - x0 - ux * t, pz - z0 - uz * t);
  };
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax), d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx), d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(pt(ax, az, cx, cz, dx, dz), pt(bx, bz, cx, cz, dx, dz), pt(cx, cz, ax, az, bx, bz), pt(dx, dz, ax, az, bx, bz));
}

function wrapAngle(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
// Numeric lane keys avoid thousands of template strings per second. There are at most eight lanes
// per direction in the source graph; keeping a nibble leaves room for future wider roads.
const laneKey = (e, dir, lane) => (e.i * 2 + (dir > 0 ? 1 : 0)) * 16 + lane;

// AI traffic: lane following on the road graph, IDM car-following, traffic lights, crashes become physics.
export class Traffic {
  constructor(opts) {
    const { scene, roads, terrain, RAPIER, world, collisionGroups, max = 56 } = opts;
    this.scene = scene;
    this.roads = roads;
    this.terrain = terrain;
    this.RAPIER = RAPIER;
    this.world = world;
    this.groups = collisionGroups;
    this.groupsCrashed = (((collisionGroups >>> 16) << 16) | 0xffff) >>> 0;
    this.max = max;
    this.agents = [];
    this.uniforms = { uNight: { value: 0 } };
    this.material = patchFakeLights(trafficBodyMaterial(this.uniforms));
    this.wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.6, metalness: 0.3 });
    this.bake = bakeCar;
    this.typeDefs = TYPES;
    this.types = []; // lazily created render types
    this.typeMap = new Map();
    this.game = opts.game;
    this.parkedMax = opts.parkedMax ?? 28;
    this.parkTimer = 0;
    this.lanes = new Map();
    this._laneInfoCache = new WeakMap();
    this._laneRecords = [];
    this._laneRecordN = 0;
    this._visualCounts = new Map();
    this._vPos = new THREE.Vector3();
    this._vQ = new THREE.Quaternion();
    this._vWQ = new THREE.Quaternion();
    this._vWP = new THREE.Vector3();
    this._axisX = new THREE.Vector3(1, 0, 0);
    this._axisY = new THREE.Vector3(0, 1, 0);
    this._linVel = { x: 0, y: 0, z: 0 };
    this._pathPoint = {};
    this._angVel = { x: 0, y: 0, z: 0 };
    this.lights = new TrafficLights(roads, scene);
    this.spawnTimer = 0;
    this.targetCount = 20;
    this.densityTimer = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1, 1, 1);
    this._frustum = new THREE.Frustum();
    this.colliderMap = new Map();
    this.markAirside();
    this.holders = new Map(); // junction node -> agents holding a reservation
    this.clusters = new Map();
    this._pq = new THREE.Quaternion();
    this._sq = new THREE.Quaternion();
    this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this._groundMask = ((0xffff << 16) | 0x0001) >>> 0; // rays hit only GROUND colliders (terrain, road + sidewalk trimesh)
    this._step = 0;
    this.lastTakeOver = null; // { spec, t } of the latest takeOver (DamageSystem hands dents over to the new vehicle)
    this.stats = { settled: 0, maxSink: 0, frozen: 0 };
  }

  // airside edges (runways, taxiways) are flagged by Roads.markAirside: no AI cars there
  markAirside() {
    for (const e of this.roads.edges) if (e.airside) e.noTraffic = true;
  }

  // ---------- geometry helpers ----------
  laneInfo(e) {
    let info = this._laneInfoCache.get(e);
    if (!info) {
      const n = lanesFor(e);
      info = { n, w: (e.oneway ? e.w : e.w / 2) / n };
      this._laneInfoCache.set(e, info);
    }
    return info;
  }

  // point on lane: returns {x,y,z,tx,tz,k}
  lanePoint(e, dir, lane, s, out, kHint = 0) {
    const L = e.len;
    const arc = dir > 0 ? Math.min(Math.max(s, 0), L) : L - Math.min(Math.max(s, 0), L);
    let k = Math.min(Math.max(kHint, 0), e.n - 2);
    while (k < e.n - 2 && e.cum[k + 1] < arc) k++;
    while (k > 0 && e.cum[k] > arc) k--;
    const seg = e.cum[k + 1] - e.cum[k] || 1;
    const t = (arc - e.cum[k]) / seg;
    const ax = e.pts[2 * k], az = e.pts[2 * k + 1], bx = e.pts[2 * k + 2], bz = e.pts[2 * k + 3];
    let tx = (bx - ax) / seg, tz = (bz - az) / seg;
    if (dir < 0) { tx = -tx; tz = -tz; }
    const { w } = this.laneInfo(e);
    // offset to the right of travel; lane 0 is the leftmost (fast) lane in both layouts
    const o = e.oneway ? (lane + 0.5) * w - e.w / 2 : (lane + 0.5) * w;
    out.x = ax + (bx - ax) * t - tz * o;
    out.z = az + (bz - az) * t + tx * o;
    out.y = e.y[k] + (e.y[k + 1] - e.y[k]) * t;
    out.slope = ((e.y[k + 1] - e.y[k]) / seg) * (dir < 0 ? -1 : 1);
    out.tx = tx; out.tz = tz; out.k = k;
    return out;
  }

  nodeRadius(ni) { return this.roads.adj[ni].length >= 3 ? this.roads.nodeR[ni] + 2.5 : 0.5; }

  endNode(a) { return a.dir > 0 ? a.edge.b : a.edge.a; }

  chooseNext(a) {
    const ni = this.endNode(a);
    const adj = this.roads.adj[ni];
    const p = this.lanePoint(a.edge, a.dir, a.lane, a.edge.len - 1, {});
    const opts = [];
    const avoidDirt = Math.random() < 0.8 && adj.some((ei) => this.roads.edges[ei].kind !== 2 && this.roads.edges[ei] !== a.edge);
    for (const ei of adj) {
      const e = this.roads.edges[ei];
      if ((e.kind === 2 && avoidDirt) || e.noTraffic) continue;
      if (e === a.edge && adj.length > 1) continue;
      const dir = e.a === ni ? 1 : -1;
      if (e.a === e.b || !this.roads.allowedFrom(e, ni)) continue;
      const q = this.lanePoint(e, dir, 0, Math.min(8, e.len * 0.5), {});
      const cos = p.tx * q.tx + p.tz * q.tz;
      opts.push({ e, dir, wgt: 0.25 + Math.max(0, cos) * 2.5 + (e.kind === a.edge.kind ? 0.5 : 0) });
    }
    if (!opts.length) return a.edge.oneway ? null : { e: a.edge, dir: -a.dir }; // dead end: U-turn (never against a one-way flow)
    let r = Math.random() * opts.reduce((s, o) => s + o.wgt, 0);
    for (const o of opts) { if ((r -= o.wgt) <= 0) return o; }
    return opts[opts.length - 1];
  }

  vmaxFor(e) {
    if (e.kind === 1) return 24 + Math.random() * 6;
    if (e.kind === 2) return 9;
    return e.w > 12 ? 15 : 12.5;
  }

  // ---------- spawning ----------
  spawnAt(e, dir, s, type) {
    if (this.agents.length >= this.max) return null;
    const { n } = this.laneInfo(e);
    const lane = Math.floor(Math.random() * n);
    const p = this.lanePoint(e, dir, lane, s, {});
    const tdef = type || this.pickType(p.x, p.z);
    const b = tdef.baked;
    const RAPIER = this.RAPIER;
    const halfH = b.height * 0.32, lift = 0.32;
    const yaw = Math.atan2(-p.tx, -p.tz);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(p.x, p.y + lift + halfH, p.z)
      .setRotation(this._q.setFromAxisAngle(TMP.set(0, 1, 0), yaw))
      .enabledRotations(false, true, false)
      .setLinearDamping(0.05).setAngularDamping(1.5).setCcdEnabled(false));
    const cd = this.RAPIER.ColliderDesc.cuboid(b.width * 0.47, halfH, b.length * 0.47)
      .setTranslation(0, 0, 0).setMass(1400).setFriction(0.0).setRestitution(0.1)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(25000);
    if (this.groups !== undefined) cd.setCollisionGroups(this.groups);
    const col = this.world.createCollider(cd, body);
    const a = {
      edge: e, dir, lane, s, v: 0, vmax: this.vmaxFor(e), mode: 'lane', k: p.k, turn: null, next: null,
      type: tdef, paint: new THREE.Color((tdef.palette || PAINTS)[Math.floor(Math.random() * (tdef.palette || PAINTS).length)]),
      body, col, halfH, lift, crashed: false, crashT: 0, gap: 1e9, leadV: 0, brake: 0, spin: 0, err: 0,
      prev: new THREE.Vector3(p.x, p.y, p.z), cur: new THREE.Vector3(p.x, p.y, p.z), pq: new THREE.Quaternion(), cq: new THREE.Quaternion(),
      steer: 0, age: 0, halfLen: b.length * 0.5, pitch: 0, res: -1, resT: 0, plan: null, resv: null,
    };
    a.v = a.vmax * 0.8;
    a.cq.copy(this._q); a.pq.copy(this._q);
    a.next = this.chooseNext(a);
    col.userData = { traffic: a };
    this.colliderMap.set(col.handle, a);
    this.agents.push(a);
    return a;
  }

  // parked car at the kerb (enterable; becomes physics when hit)
  spawnParked(e, s, side) {
    const p = this.roads.pointAt(e, s);
    const off = (e.w / 2 + 0.95) * side;
    const x = p.x - p.tz * off, z = p.z + p.tx * off;
    const y = Math.max(this.terrain.heightAt(x, z), p.y);
    if (y < 0.2) return null;
    if (this.game?.lamps?.scatter?.near(x, z, 4.5).length) return null;
    if (this.agents.some((o) => o.parked && Math.hypot(o.cur.x - x, o.cur.z - z) < 6.5)) return null;
    const T = this.pickType(x, z);
    const b = T.baked;
    const halfH = b.height * 0.32, lift = 0.32;
    // right-hand traffic: a car on the right kerb faces +s, on the left kerb faces -s
    const fx = side > 0 ? p.tx : -p.tx, fz = side > 0 ? p.tz : -p.tz;
    const yaw = Math.atan2(-fx, -fz);
    const RAPIER = this.RAPIER;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y + lift + halfH, z)
      .setRotation(this._q.setFromAxisAngle(TMP.set(0, 1, 0), yaw))
      .enabledRotations(false, true, false).setLinearDamping(0.5).setAngularDamping(2));
    const cd = RAPIER.ColliderDesc.cuboid(b.width * 0.47, halfH, b.length * 0.47).setMass(1400).setFriction(0.0).setRestitution(0.1)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(25000);
    if (this.groups !== undefined) cd.setCollisionGroups(this.groups);
    const col = this.world.createCollider(cd, body);
    const pal = T.palette || PAINTS;
    const a = {
      edge: e, dir: 1, lane: 0, s, v: 0, vmax: 0, mode: 'parked', parked: true, k: 0, anchor: { x, y: y + lift + halfH, z, yaw },
      type: T, paint: new THREE.Color(pal[Math.floor(Math.random() * pal.length)]),
      body, col, halfH, lift, crashed: false, crashT: 0, gap: 1e9, leadV: 0, brake: 0, spin: 0, err: 0,
      prev: new THREE.Vector3(x, y, z), cur: new THREE.Vector3(x, y, z), pq: new THREE.Quaternion().copy(this._q), cq: new THREE.Quaternion().copy(this._q),
      steer: 0, age: 0, fx, fz, halfLen: b.length * 0.5, pitch: 0, res: -1, resT: 0, plan: null,
    };
    col.userData = { traffic: a };
    this.colliderMap.set(col.handle, a);
    this.agents.push(a);
    return a;
  }

  updateParking(dt, focus, camera) {
    this.parkTimer -= dt;
    if (this.parkTimer > 0) return;
    this.parkTimer = 0.25;
    let n = 0;
    for (const a of this.agents) if (a.parked) n++;
    if (n >= this.parkedMax) return;
    this._frustum.setFromProjectionMatrix(this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (let attempt = 0; attempt < 4; attempt++) {
      const ang = Math.random() * Math.PI * 2, r = 110 + Math.random() * 130;
      const q = this.roads.nearest(focus.x + Math.cos(ang) * r, focus.z + Math.sin(ang) * r, 50, (e) => e.lit && e.kind === 0 && !e.br && !e.noTraffic && e.len > 40);
      if (!q) continue;
      const e = q.edge;
      const s = e.cum[q.seg] + q.t * (e.cum[q.seg + 1] - e.cum[q.seg]);
      if (s < 18 || s > e.len - 18) continue;
      TMP.set(q.x, q.y + 1, q.z);
      if (r < 180 && this._frustum.containsPoint(TMP)) continue;
      if (this.spawnParked(e, s, Math.random() < 0.5 ? 1 : -1)) return;
    }
  }

  // switch to an external catalog: entries {id, tier, trafficWeight}; bake(id) → baked model
  setCatalog(entries, bake) {
    this.typeDefs = entries.filter((e) => (e.trafficWeight ?? 1) > 0).map((e) => ({ name: e.id, tier: e.tier ?? 0.5, w: e.trafficWeight ?? 1 }));
    if (bake) this.bake = bake;
  }

  getType(name) {
    let T = this.typeMap.get(name);
    if (T) return T;
    const max = this.max + this.parkedMax;
    const baked = this.bake(name);
    const mesh = new THREE.InstancedMesh(baked.geo, this.material, max);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const tint = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    const brake = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    tint.setUsage(THREE.DynamicDrawUsage); brake.setUsage(THREE.DynamicDrawUsage);
    baked.geo.setAttribute('aTint', tint);
    baked.geo.setAttribute('aBrake', brake);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    const wheelGeo = baked.wheelGeo || baked.wheel;
    const wheels = new THREE.InstancedMesh(wheelGeo, this.wheelMat, max * 6);
    wheels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    wheels.count = 0;
    wheels.frustumCulled = false;
    wheels.castShadow = true;
    this.scene.add(wheels);
    T = { name, def: this.typeDefs.find((d) => d.name === name), baked, mesh, wheels, tint, brake, palette: baked.palette, live: 0 };
    this.typeMap.set(name, T);
    this.types.push(T);
    return T;
  }

  /**
   * Build traffic models ahead of their first use from idle time: a new model costs a bake plus its instanced
   * buffers (3-6 ms) in the frame it is first picked otherwise. Stops before the budget runs out; returns true while
   * some are left. Which model is picked when is unchanged (pickType only looks at live counts).
   */
  prebake(ms = 4, cost = 4) {
    const end = performance.now() + ms;
    for (const d of this.typeDefs) {
      if (this.typeMap.has(d.name)) continue;
      if (end - performance.now() < cost) return true;
      try { this.getType(d.name); } catch (e) { console.warn('[traffic] prebake', d.name, e); this.typeMap.set(d.name, null); }
    }
    return false;
  }

  // vehicle mix depends on the wealth of the district
  pickType(x, z) {
    const wealth = this.game?.world3d?.wealthAt?.(x, z) ?? 0.5;
    let total = 0;
    const ws = this.typeDefs.map((d) => {
      const k = d.w * (0.08 + Math.exp(-((d.tier - wealth) ** 2) / (2 * 0.2 * 0.2)));
      total += k;
      return k;
    });
    // at most MAX_LIVE_TYPES models on screen at once: every model is its own draw call (+ wheels + shadows)
    const MAX_LIVE_TYPES = 14;
    const live = this.types.filter((T) => T.live > 0);
    if (live.length >= MAX_LIVE_TYPES) {
      let lt = 0;
      const lw = live.map((T) => { const k = (T.def?.w ?? 1) * (0.08 + Math.exp(-(((T.def?.tier ?? 0.5) - wealth) ** 2) / (2 * 0.2 * 0.2))); lt += k; return k; });
      let r2 = Math.random() * lt;
      for (let i = 0; i < live.length; i++) if ((r2 -= lw[i]) <= 0) return live[i];
      return live[0];
    }
    let r = Math.random() * total;
    for (let i = 0; i < ws.length; i++) if ((r -= ws[i]) <= 0) return this.getType(this.typeDefs[i].name);
    return this.getType(this.typeDefs[0].name);
  }

  remove(a, keepDebris = true) {
    this.release(a);
    a.wreck?.dispose?.(!keepDebris);
    this.colliderMap.delete(a.col.handle);
    this.world.removeRigidBody(a.body);
    const i = this.agents.indexOf(a);
    if (i >= 0) this.agents.splice(i, 1);
  }

  clear() { while (this.agents.length) this.remove(this.agents[0]); }

  // convert an AI car into a spawn spec for a full-physics vehicle (carjacking, burning wrecks); removes the agent
  takeOver(a) {
    if (!a || !this.agents.includes(a)) return null;
    const fwd = TMP.set(0, 0, -1).applyQuaternion(a.cq);
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    const lv = a.body.linvel();
    const spec = {
      id: a.type.name, yaw, color: a.paint.getHex(), speed: a.v, burning: !!a.burning,
      pos: { x: a.cur.x, y: a.cur.y - (a.lift + a.halfH), z: a.cur.z },
      velocity: { x: lv.x, y: lv.y, z: lv.z },
    };
    // dents, broken lamps / glass and lost panels of a dented car carry over to the full vehicle (DamageSystem.attach)
    const dmg = a.wreck?.snapshot?.();
    if (dmg) spec.damage = dmg;
    this.lastTakeOver = { spec, t: this.game?.time ?? 0, used: false };
    this.remove(a);
    return spec;
  }

  nearestAgent(pos, r = 6, filter) {
    let best = null, bd = r;
    for (const a of this.agents) {
      if (filter && !filter(a)) continue;
      const d = Math.hypot(a.cur.x - pos.x, a.cur.z - pos.z);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  trySpawn(focus, camera) {
    this._frustum.setFromProjectionMatrix(this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (let attempt = 0; attempt < 8; attempt++) {
      const ang = Math.random() * Math.PI * 2;
      const r = 90 + Math.random() * 230;
      const x = focus.x + Math.cos(ang) * r, z = focus.z + Math.sin(ang) * r;
      const n = this.roads.nearest(x, z, 60, (e) => e.kind !== 2 && e.len > 30 && !e.noTraffic);
      if (!n) continue;
      const e = n.edge;
      const arc = e.cum[n.seg] + n.t * (e.cum[n.seg + 1] - e.cum[n.seg]);
      const dir = e.oneway || (Math.random() < 0.5 ? 1 : -1);
      const s = dir > 0 ? arc : e.len - arc;
      const rA = this.nodeRadius(dir > 0 ? e.a : e.b), rB = this.nodeRadius(dir > 0 ? e.b : e.a);
      if (s < rA + 3 || s > e.len - rB - 6) continue;
      TMP.set(n.x, n.y + 2, n.z);
      if (r < 260 && this._frustum.containsPoint(TMP)) continue;
      // keep spacing on the same edge
      if (this.agents.some((o) => (o.edge === e && Math.abs(o.s - s) < 25 && o.dir === dir) || Math.hypot(o.cur.x - n.x, o.cur.z - n.z) < 14)) continue;
      return this.spawnAt(e, dir, s);
    }
    return null;
  }

  estimateDensity(focus) {
    // lane metres within ~350 m, sampled on the road spatial grid
    const R = 300, c = this.roads.cell;
    let len = 0;
    const seen = new Set();
    for (let i = Math.floor((focus.x - R) / c); i <= Math.floor((focus.x + R) / c); i++) {
      for (let j = Math.floor((focus.z - R) / c); j <= Math.floor((focus.z + R) / c); j++) {
        const l = this.roads.grid.get(i * 100003 + j);
        if (!l) continue;
        for (let q = 0; q < l.length; q += 2) {
          const key = l[q] * 4096 + l[q + 1];
          if (seen.has(key)) continue;
          seen.add(key);
          const e = this.roads.edges[l[q]];
          if (e.kind === 2) continue;
          const k = l[q + 1];
          len += (e.cum[k + 1] - e.cum[k]) * lanesFor(e) * 2;
        }
      }
    }
    return len;
  }

  // ---------- per-frame logic ----------
  update(dt, focus, camera, player, peds) {
    this.uniforms.uNight.value = this.night ?? 0;
    this.lights.update(dt, focus, camera);
    this.densityTimer -= dt;
    if (this.densityTimer <= 0) {
      this.densityTimer = 1.5;
      this.targetCount = Math.max(6, Math.min(this.max, Math.round(this.estimateDensity(focus) / 70)));
    }
    this.spawnTimer -= dt;
    this.updateParking(dt, focus, camera);
    let drivingCount = 0;
    for (const a of this.agents) if (!a.crashed && !a.parked) drivingCount++;
    if (this.spawnTimer <= 0 && drivingCount < this.targetCount) {
      this.spawnTimer = 0.12;
      this.trySpawn(focus, camera);
    }
    // despawn
    for (let i = this.agents.length - 1; i >= 0; i--) {
      const a = this.agents[i];
      const d = Math.hypot(a.cur.x - focus.x, a.cur.z - focus.z);
      a.age += dt;
      if (!a.parked && !a.crashed) { a.stall = a.v < 0.2 ? (a.stall || 0) + dt : 0; if (a.stall > 35 && !a.lost) { a.lost = true; this._recycled = (this._recycled || 0) + 1; } }
      if (d > (a.parked ? 300 : 420) || (a.crashed && (a.crashT += dt) > 45 && d > 60) || a.cur.y < -20 || (a.lost && d > 80)) { this.remove(a); continue; }
      // a wreck far from the player is frozen in place: the road / terrain colliders under it may stream out
      if (a.crashed && (d > 230) !== !!a.frozen && (!a.frozen || d < 200)) this.freeze(a, !a.frozen);
    }
    // lane occupancy lists for leader search
    const lanes = this.lanes;
    for (const l of lanes.values()) l.length = 0;
    this._laneRecordN = 0;
    const push = (key, a, s) => {
      let l = lanes.get(key); if (!l) lanes.set(key, (l = []));
      const n = this._laneRecordN++;
      const rec = this._laneRecords[n] || (this._laneRecords[n] = [0, null]);
      rec[0] = s; rec[1] = a; l.push(rec);
    };
    for (const a of this.agents) {
      if (a.crashed || a.parked) continue;
      if (a.mode === 'lane') push(laneKey(a.edge, a.dir, a.lane), a, a.s);
      else {
        const t = a.turn;
        push(laneKey(a.edge, a.dir, a.lane), a, a.edge.len - this.nodeRadius(this.endNode(a)) + t.u);
        push(laneKey(t.e, t.dir, t.lane), a, t.sStart - (t.L - t.u));
      }
    }
    for (const l of lanes.values()) l.sort((p, q) => p[0] - q[0]);
    const wrecks = this._wrecks || (this._wrecks = []);
    wrecks.length = 0;
    for (const a of this.agents) if (a.crashed) wrecks.push(a);
    // gaps
    const pp = player.position, pv = player.velocity;
    for (const a of this.agents) {
      if (a.crashed || a.parked) continue;
      let gap = 1e9, leadV = 0;
      const key = a.mode === 'lane' ? laneKey(a.edge, a.dir, a.lane) : laneKey(a.turn.e, a.turn.dir, a.turn.lane);
      const sMe = a.mode === 'lane' ? a.s : a.turn.sStart - (a.turn.L - a.turn.u);
      const l = lanes.get(key);
      if (l) {
        for (const [s, o] of l) {
          if (o !== a && s > sMe + 0.1) { gap = s - sMe - a.halfLen - o.halfLen; leadV = o.v; break; }
        }
      }
      if (a.mode === 'turn') {
        const la = lanes.get(laneKey(a.edge, a.dir, a.lane));
        const s0 = a.edge.len - this.nodeRadius(this.endNode(a)) + a.turn.u;
        if (la) for (const [s, o] of la) {
          if (o !== a && s > s0 + 0.1) { const g = s - s0 - a.halfLen - o.halfLen; if (g < gap) { gap = g; leadV = o.v; } break; }
        }
      }
      if (a.mode === 'lane') {
        const e = a.edge;
        const sStop = e.len - this.nodeRadius(this.endNode(a));
        // next lane's last car (close to its start)
        if (gap > 1e8 && a.next) {
          const nl = lanes.get(laneKey(a.next.e, a.next.dir, Math.min(a.lane, this.laneInfo(a.next.e).n - 1)));
          if (nl && nl.length) { gap = e.len - a.s + nl[0][0] - a.halfLen - nl[0][1].halfLen - 1; leadV = nl[0][1].v; }
        }
        // traffic light, then a junction reservation: enter only if my path through the node conflicts with no
        // car that already holds it (cars from the same approach just follow each other)
        const ni = this.endNode(a);
        const st = this.lights.state(ni, e.i);
        // where to wait: the painted stop bar (Roads.stopDist, src/world/Junctions.js) with the front bumper ~0.6 m
        // short of it (IDM keeps s0 to the stop point), else the edge of the junction box
        const sb = this.roads.stopDist?.(e, ni);
        const sBar = sb != null ? e.len - Math.max(sb, this.nodeRadius(ni)) : sStop;
        const dStop = sb != null ? sBar - a.s - a.halfLen - 0.6 + IDM.s0 : sStop - a.s - 2.4;
        const before = sb != null ? a.s + a.halfLen < sBar + 1.0 : a.s < sStop + 0.5;
        const isJunction = this.roads.adj[ni].length >= 3;
        const ctl = this.roads.control?.[ni];
        const stopSign = st === 2 && ctl && ctl.type !== 'signal' && ctl.stop?.has(e.i * 2 + (e.a === ni ? 0 : 1));
        if (st < 2 && before && a.res !== ni) {
          const canStop = st === 1 ? dStop > a.v * a.v / (2 * IDM.b * 1.4) : true;
          if (canStop && dStop < gap) { gap = Math.max(0, dStop); leadV = 0; }
        } else if (stopSign && before && a.stopDone !== ni && a.res !== ni) {
          // stop sign: a full stop at the bar (~0.7 s), then on through the reservation like any junction
          if (dStop < gap) { gap = Math.max(0, dStop); leadV = 0; }
          if (dStop - IDM.s0 < 1.5 && a.v < 0.5) { a.stopT = (a.stopT || 0) + dt; if (a.stopT > 0.7) { a.stopDone = ni; a.stopT = 0; } }
        } else if (isJunction && a.res !== ni && a.next && dStop < Math.max(14, (a.v * a.v) / (2 * IDM.b) + 8)) {
          if (!this.reserve(a, ni) && dStop < gap) { gap = Math.max(0, dStop); leadV = 0; }
        }
      }
      // player car and pedestrians ahead
      const fwdx = a.fx || 0, fwdz = a.fz || -1;
      const obstacle = (ox, oz, ov, w) => {
        const dx = ox - a.cur.x, dz = oz - a.cur.z;
        const f = dx * fwdx + dz * fwdz;
        if (f < 1 || f > 45) return;
        const lat = Math.abs(dx * -fwdz + dz * fwdx);
        if (lat > w) return;
        const g = f - a.halfLen - 2.6;
        if (g < gap) { gap = Math.max(0, g); leadV = ov; }
      };
      if (pp) obstacle(pp.x, pp.z, Math.max(0, (pv?.x ?? 0) * fwdx + (pv?.z ?? 0) * fwdz), 2.3);
      for (const w of wrecks) obstacle(w.cur.x, w.cur.z, 0, 2.6);
      if (peds) for (const p of peds) obstacle(p.x, p.z, 0, 1.6);
      a.gap = gap;
      a.leadV = leadV;
    }
  }

  // ---------- fixed-step control ----------
  // velocity an agent enters the physics step with (a.v0; a.v1 = after the step): DamageSystem turns the difference
  // into impacts. Driving / parked cars: the commanded velocity; crashed ones: the current one (so impulses applied
  // between steps, blasts and crash kicks, never count as a hit).
  _v0(a, x, y, z) {
    const o = a.v0 || (a.v0 = { x: 0, y: 0, z: 0, ok: false });
    o.x = x; o.y = y; o.z = z; o.ok = true;
  }

  _driveVelocity(a, x, y, z) {
    const o = this._linVel; o.x = x; o.y = y; o.z = z;
    a.body.setLinvel(o, true); // Rapier copies the vector synchronously
    this._v0(a, x, y, z);
  }

  fixedUpdate(dt) {
    const P = this._pathPoint;
    for (const a of this.agents) {
      if (a.burning && !a.crashed) this.crash(a);
      const b = a.body;
      if (a.crashed) {
        if (!a.frozen) { const lv = b.linvel(); this._v0(a, lv.x, lv.y, lv.z); }
        continue;
      }
      if (a.parked) {
        const t = b.translation();
        const vx = (a.anchor.x - t.x) * 4, vy = (a.anchor.y - t.y) * 6, vz = (a.anchor.z - t.z) * 4;
        this._driveVelocity(a, vx, vy, vz);
        const av = this._angVel; av.x = 0; av.y = 0; av.z = 0; b.setAngvel(av, true);
        a.err = Math.hypot(a.anchor.x - t.x, a.anchor.z - t.z);
        if (a.err > 2.5) this.crash(a);
        continue;
      }
      // IDM
      const v = a.v;
      const dv = v - a.leadV;
      const sStar = IDM.s0 + Math.max(0, v * IDM.T + (v * dv) / (2 * Math.sqrt(IDM.a * IDM.b)));
      let vLim = a.vmax;
      if (a.mode === 'turn') vLim = Math.min(vLim, a.turn.vmax);
      else {
        // slow down before a sharp upcoming turn
        const dEnd = a.edge.len - this.nodeRadius(this.endNode(a)) - a.s;
        if (a.next && dEnd < 40) vLim = Math.min(vLim, 7 + dEnd * 0.35 + (a.next.straight ? 8 : 0));
      }
      const speedRatio = v / Math.max(vLim, 0.5);
      const speedRatio2 = speedRatio * speedRatio;
      const gapRatio = sStar / Math.max(a.gap, 0.1);
      let acc = IDM.a * (1 - speedRatio2 * speedRatio2 - gapRatio * gapRatio);
      acc = Math.max(-9, Math.min(IDM.a, acc));
      // blocked (pushed away from path): wait
      if (a.err > 1.6) acc = Math.min(acc, -4);
      a.brake = acc < -1.0 || a.v < 0.3 ? 1 : 0;
      a.v = Math.max(0, v + acc * dt);
      // advance along path
      let step = a.v * dt;
      if (a.mode === 'lane') {
        const e = a.edge;
        const sEnd = e.len - this.nodeRadius(this.endNode(a));
        a.s += step;
        if (a.s >= sEnd) {
          const ni = this.endNode(a);
          if (this.roads.adj[ni].length >= 3 && a.res !== ni && !this.reserve(a, ni)) { a.s = sEnd; a.v = 0; }
          else this.beginTurn(a, a.s - sEnd);
        }
      } else {
        a.turn.u += step;
        if (a.turn.u >= a.turn.L) this.endTurn(a, a.turn.u - a.turn.L);
      }
      // target point
      let px, py, pz, tx, tz;
      if (a.mode === 'lane') {
        this.lanePoint(a.edge, a.dir, a.lane, a.s, P, a.k);
        a.k = P.k;
        px = P.x; py = P.y; pz = P.z; tx = P.tx; tz = P.tz;
        a.pitch += (Math.atan(P.slope) - a.pitch) * 0.12;
      } else {
        const t = a.turn;
        const u = Math.min(1, t.u / t.L);
        const m = 1 - u;
        px = m * m * t.p0.x + 2 * m * u * t.p1.x + u * u * t.p2.x;
        py = m * m * t.p0.y + 2 * m * u * t.p1.y + u * u * t.p2.y;
        pz = m * m * t.p0.z + 2 * m * u * t.p1.z + u * u * t.p2.z;
        tx = 2 * m * (t.p1.x - t.p0.x) + 2 * u * (t.p2.x - t.p1.x);
        tz = 2 * m * (t.p1.z - t.p0.z) + 2 * u * (t.p2.z - t.p1.z);
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        a.pitch += (Math.atan((t.p2.y - t.p0.y) / t.L) - a.pitch) * 0.12;
      }
      a.fx = tx; a.fz = tz;
      if (a.mode === 'turn' || a.res < 0) a.resT = 0;
      else if ((a.resT += dt) > 8) this.release(a); // held a reservation but never got going
      const pos = b.translation();
      const ty = py + a.lift + a.halfH;
      const ex = px - pos.x, ey = ty - pos.y, ez = pz - pos.z;
      a.err = Math.hypot(ex, ez);
      if (a.err > 9) { a.lost = true; const lv = b.linvel(); this._v0(a, lv.x, lv.y, lv.z); continue; }
      const vx = tx * a.v + ex * 6, vy = ey * 8, vz = tz * a.v + ez * 6;
      this._driveVelocity(a, vx, vy, vz);
      const yaw = Math.atan2(-tx, -tz);
      const r = b.rotation();
      const cy = 2 * Math.atan2(r.y, r.w);
      const yerr = wrapAngle(yaw - cy);
      const av = this._angVel; av.x = 0; av.y = yerr * 9; av.z = 0; b.setAngvel(av, true);
      a.steer += (THREE.MathUtils.clamp(yerr * 4, -0.5, 0.5) - a.steer) * 0.2;
    }
  }

  // turn geometry from the current lane into `nx` (quadratic Bézier p0-p1-p2) + a sampled polyline for conflict tests
  planTurn(a, nx) {
    const e2 = nx.e, dir2 = nx.dir;
    const n2 = this.laneInfo(e2).n;
    const lane2 = Math.min(a.lane, n2 - 1);
    const r2 = this.nodeRadius(dir2 > 0 ? e2.a : e2.b);
    const sStart = Math.min(r2, e2.len * 0.4);
    const p0 = this.lanePoint(a.edge, a.dir, a.lane, a.edge.len - this.nodeRadius(this.endNode(a)), {});
    const p2 = this.lanePoint(e2, dir2, lane2, sStart, {});
    const d = Math.hypot(p2.x - p0.x, p2.z - p0.z);
    const c1x = p0.x + p0.tx * d * 0.5, c1z = p0.z + p0.tz * d * 0.5;
    const c2x = p2.x - p2.tx * d * 0.5, c2z = p2.z - p2.tz * d * 0.5;
    const p1 = { x: (c1x + c2x) / 2, y: (p0.y + p2.y) / 2, z: (c1z + c2z) / 2 };
    const pts = new Float32Array(14);
    let L = 0;
    for (let i = 0; i <= 6; i++) {
      const u = i / 6, m = 1 - u;
      pts[2 * i] = m * m * p0.x + 2 * m * u * p1.x + u * u * p2.x;
      pts[2 * i + 1] = m * m * p0.z + 2 * m * u * p1.z + u * u * p2.z;
      if (i) L += Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
    }
    const cos = p0.tx * p2.tx + p0.tz * p2.tz;
    const vmax = cos > 0.92 ? 30 : cos > 0.5 ? 9 : 6;
    return { e: e2, dir: dir2, lane: lane2, sStart, p0, p1, p2, L: Math.max(0.5, L), vmax, pts, from: (a.edge.i * 2 + (a.dir > 0 ? 1 : 0)) * 8 + a.lane };
  }

  // paths through the same node clash if they merge into one lane or pass closer than a car width
  conflict(P, Q) {
    if (!Q) return false;
    if (P.from === Q.from) return false; // same lane of the same approach: IDM keeps them apart
    if (P.e === Q.e && P.dir === Q.dir && P.lane === Q.lane) return true;
    const A = P.pts, B = Q.pts;
    for (let i = 0; i < 12; i += 2) for (let j = 0; j < 12; j += 2) {
      if (segDist(A[i], A[i + 1], A[i + 2], A[i + 3], B[j], B[j + 1], B[j + 2], B[j + 3]) < 2.5) return true;
    }
    return false;
  }

  // Reserve the move through junction ni. If the exit is a short link into another junction (no room to wait
  // in between), the next move is reserved atomically too: never stop inside a junction box.
  reserve(a, ni) {
    if (a.res === ni) return true;
    if (!a.next) return true; // dead end: let it proceed and get lost
    const moves = [];
    let st = a, nx = a.next, node = ni;
    for (let depth = 0; depth < 3; depth++) {
      const plan = depth === 0 && a.plan && a.plan.e === nx.e && a.plan.dir === nx.dir ? a.plan : this.planTurn(st, nx);
      moves.push({ ni: node, plan, next: nx });
      const e2 = nx.e, far = nx.dir > 0 ? e2.b : e2.a;
      if (this.roads.adj[far].length < 3) break;
      if (e2.len - this.nodeRadius(far) - plan.sStart > 2 * a.halfLen + 3) break;
      if (this.lights.state(far, e2.i) < 2) return false;
      const st2 = { edge: e2, dir: nx.dir, lane: plan.lane };
      const nx2 = this.chooseNext(st2);
      if (!nx2) break;
      st = st2; nx = nx2; node = far;
    }
    for (const m of moves) for (const nj of this.cluster(m.ni)) {
      const l = this.holders.get(nj);
      if (l) for (const h of l) if (h.a !== a && this.conflict(m.plan, h.plan)) return false;
    }
    this.release(a);
    for (const m of moves) {
      let l = this.holders.get(m.ni);
      if (!l) this.holders.set(m.ni, (l = []));
      l.push({ a, plan: m.plan });
    }
    a.resv = moves;
    a.res = ni;
    a.plan = moves[0].plan;
    a.resT = 0;
    return true;
  }

  // drop the reservation of the junction just cleared; returns the chained next move, if any
  releaseFirst(a) {
    const m = a.resv?.shift();
    if (m) this.unhold(m.ni, a);
    const n = a.resv?.[0];
    a.res = n ? n.ni : -1;
    a.plan = n ? n.plan : null;
    return n || null;
  }

  unhold(ni, a) {
    const l = this.holders.get(ni);
    if (!l) return;
    for (let i = l.length - 1; i >= 0; i--) if (l[i].a === a) l.splice(i, 1);
    if (!l.length) this.holders.delete(ni);
  }

  // junction nodes within 36 m of ni (a tight cluster behaves like one big intersection)
  cluster(ni) {
    let c = this.clusters.get(ni);
    if (c) return c;
    c = [ni];
    const [x, z] = this.roads.nodes[ni];
    const R = this.roads;
    for (let nj = 0; nj < R.nodes.length; nj++) {
      if (nj === ni || R.adj[nj].length < 3) continue;
      const dx = R.nodes[nj][0] - x, dz = R.nodes[nj][1] - z;
      if (dx * dx + dz * dz < 36 * 36 && Math.abs(R.nodeY[nj] - R.nodeY[ni]) < 3) c.push(nj);
    }
    this.clusters.set(ni, c);
    return c;
  }

  release(a) {
    if (a.resv) for (const m of a.resv) this.unhold(m.ni, a);
    a.resv = null;
    a.res = -1;
  }

  beginTurn(a, over) {
    const nx = a.next || this.chooseNext(a);
    if (!nx) { a.lost = true; a.s = a.edge.len - this.nodeRadius(this.endNode(a)); a.v = 0; return; }
    const plan = a.plan && a.plan.e === nx.e && a.plan.dir === nx.dir ? a.plan : this.planTurn(a, nx);
    a.mode = 'turn';
    a.turn = { e: plan.e, dir: plan.dir, lane: plan.lane, sStart: plan.sStart, p0: plan.p0, p1: plan.p1, p2: plan.p2, L: plan.L, u: over, vmax: plan.vmax };
  }

  endTurn(a, over) {
    const t = a.turn;
    const chained = this.releaseFirst(a);
    a.edge = t.e; a.dir = t.dir; a.lane = t.lane;
    a.s = t.sStart + over; a.k = 0;
    a.mode = 'lane';
    a.turn = null;
    a.stopDone = -1; // the next stop sign is a new one (even back at the same junction)
    a.vmax = this.vmaxFor(a.edge) * (a.vmaxK ?? 1); // vmaxK < 1: dented, limping on
    a.next = chained ? chained.next : this.chooseNext(a);
    if (a.next) {
      const p = this.lanePoint(a.edge, a.dir, 0, a.edge.len - 2, {});
      const q = this.lanePoint(a.next.e, a.next.dir, 0, 3, {});
      a.next.straight = p.tx * q.tx + p.tz * q.tz > 0.92;
    }
  }

  crash(a, dir) {
    if (a.crashed) return;
    this.release(a);
    a.crashed = true;
    a.crashT = 0;
    a.brake = 0;
    const b = a.body;
    b.setEnabledRotations(true, true, true, true);
    b.setAngularDamping(0.4);
    b.enableCcd(true); // a wreck can be punted hard: never tunnel through the thin road / sidewalk trimesh
    a.col.setFriction(0.8);
    a.col.setCollisionGroups(this.groupsCrashed);
    this.groundBox(a);
    if (dir) b.applyImpulse({ x: dir.x * 2500, y: 600, z: dir.z * 2500 }, true);
  }

  // The driving box floats `lift` above the tyre contact (wheels are not colliders) and stops short of the roof.
  // A crashed car rests on its own collider, so it becomes the whole car: ground to roof (no sinking `lift` into the
  // road, no roof through the asphalt when it lies upside down). Body origin and visual offset stay the same.
  groundBox(a) {
    if (a.box) return;
    const bk = a.type.baked;
    const hx = bk.width * 0.47, hz = bk.length * 0.47, hy = Math.max(a.halfH, bk.height * 0.5);
    const cy = -(a.lift + a.halfH) + hy;
    a.col.setHalfExtents({ x: hx, y: hy, z: hz });
    a.col.setTranslationWrtParent({ x: 0, y: cy, z: 0 });
    a.box = { hx, hy, hz, cy };
  }

  // far wrecks: kinematic (frozen where they lie) until the player comes back
  freeze(a, on) {
    const RT = this.RAPIER.RigidBodyType;
    a.frozen = on;
    a.body.setBodyType(on ? RT.KinematicPositionBased : RT.Dynamic, !on);
    if (on) this.stats.frozen++;
    else { a.body.setLinvel({ x: 0, y: 0, z: 0 }, true); a.body.setAngvel({ x: 0, y: 0, z: 0 }, true); }
  }

  // Safety net for crashed bodies (the same idea as VehicleManager.postStep for player vehicles): if the lowest point
  // of the box is below the drivable surface under it (ray down on GROUND: road / sidewalk trimesh or terrain), put
  // it back on top and drop the downward velocity.
  settle(a) {
    const box = a.box;
    if (!box || a.frozen) return;
    const t = a.cur, q = a.cq;
    const ryx = 2 * (q.x * q.y + q.z * q.w), ryy = 1 - 2 * (q.x * q.x + q.z * q.z), ryz = 2 * (q.y * q.z - q.x * q.w);
    const low = t.y + ryy * box.cy - (Math.abs(ryx) * box.hx + Math.abs(ryy) * box.hy + Math.abs(ryz) * box.hz);
    const ray = this._ray;
    ray.origin.x = t.x; ray.origin.y = Math.max(low + 0.9, t.y + 0.5); ray.origin.z = t.z;
    let hit = null;
    try { hit = this.world.castRay(ray, 8, true, undefined, this._groundMask); } catch { hit = null; }
    if (!hit || hit.timeOfImpact < 0.05) return; // nothing below, or the ray started inside something (tunnel hill)
    const surf = ray.origin.y - hit.timeOfImpact;
    const sink = surf - low;
    if (sink < 0.04 || sink > 1.6) return;
    const b = a.body;
    const up = sink + 0.005;
    b.setTranslation({ x: t.x, y: t.y + up, z: t.z }, true);
    const lv = b.linvel();
    if (lv.y < 0) b.setLinvel({ x: lv.x * 0.9, y: 0, z: lv.z * 0.9 }, true);
    t.y += up;
    this.stats.settled++;
    this.stats.maxSink = Math.max(this.stats.maxSink, sink);
  }

  // after physics: sample transforms for interpolation
  postStep() {
    const net = (++this._step & 1) === 0;
    for (const a of this.agents) {
      a.prev.copy(a.cur);
      a.pq.copy(a.cq);
      const b = a.body;
      const t = b.translation(), r = b.rotation(), lv = b.linvel();
      a.cur.set(t.x, t.y, t.z);
      a.cq.set(r.x, r.y, r.z, r.w);
      const v1 = a.v1 || (a.v1 = { x: 0, y: 0, z: 0 });
      v1.x = lv.x; v1.y = lv.y; v1.z = lv.z;
      if (net && a.crashed) this.settle(a);
    }
  }

  // render
  updateVisual(alpha, dt, night) {
    this.night = night;
    const counts = this._visualCounts; counts.clear();
    const pos = this._vPos, q = this._vQ, wq = this._vWQ, wp = this._vWP;
    const m = this._m, one = this._s;
    const axisX = this._axisX, axisY = this._axisY;
    const bodies = this._bodies || (this._bodies = new Map());
    bodies.clear();
    for (const a of this.agents) {
      const T = a.type, i = counts.get(T) || 0;
      counts.set(T, i + 1);
      pos.lerpVectors(a.prev, a.cur, alpha);
      q.slerpQuaternions(a.pq, a.cq, alpha);
      if (!a.crashed && a.pitch) q.multiply(this._pq.setFromAxisAngle(axisX, a.pitch));
      if (!a.crashed) pos.y += 0.06; // asphalt ribbon sits slightly above the lane centreline
      // a dented car (DamageSystem / TrafficWreck) draws its own copy of the body at the same pose: body centre
      if (a.wreck && !a.wreck.disposed) a.wreck.sync(pos, q, a.paint, a.brake);
      // model origin is at ground level, body centre is lift+halfH above
      TMP.set(0, -(a.lift + a.halfH), 0).applyQuaternion(q);
      pos.add(TMP);
      if (!a.wreck || a.wreck.disposed) {
        const bi = bodies.get(T) || 0;
        bodies.set(T, bi + 1);
        m.compose(pos, q, one);
        T.mesh.setMatrixAt(bi, m);
        T.tint.setXYZ(bi, a.paint.r, a.paint.g, a.paint.b);
        T.brake.setX(bi, a.brake);
      }
      // wheels
      const sp = a.crashed ? a.body.linvel() : null;
      const v = a.crashed ? Math.hypot(sp.x, sp.z) : a.v;
      a.spin = (a.spin + (v * dt) / T.baked.radius) % (Math.PI * 2);
      const tb = T.baked;
      const W = tb.wheels || defaultWheels(tb);
      for (let w = 0; w < W.length && w < 6; w++) {
        const wh = W[w];
        wp.set(wh.x, wh.y ?? tb.radius, wh.z).applyQuaternion(q).add(pos);
        wq.setFromAxisAngle(axisY, (wh.left ? Math.PI : 0) + (wh.front ? a.steer : 0));
        const sq = this._sq.setFromAxisAngle(axisX, wh.left ? a.spin : -a.spin);
        wq.premultiply(q).multiply(sq);
        m.compose(wp, wq, one);
        T.wheels.setMatrixAt(i * 6 + w, m);
      }
      for (let w = W.length; w < 6; w++) T.wheels.setMatrixAt(i * 6 + w, ZERO_M);
    }
    this.types.forEach((T) => {
      const c = counts.get(T) || 0, cb = bodies.get(T) || 0;
      T.live = c;
      T.mesh.count = cb;
      T.wheels.count = c * 6;
      T.mesh.visible = cb > 0; // skip empty models entirely (no draw call, no shadow pass)
      T.wheels.visible = c > 0;
      T.mesh.instanceMatrix.needsUpdate = true;
      T.wheels.instanceMatrix.needsUpdate = true;
      T.tint.needsUpdate = true;
      T.brake.needsUpdate = true;
    });
    this.lights.render(night);
    this.lights.uploadSignals(this.game?.camera, night);
  }

  onContact(handle, otherIsPlayer, force, dir) {
    const a = this.colliderMap.get(handle);
    if (!a) return;
    if (otherIsPlayer && force > 60000) this.crash(a, dir);
  }
}

// ---------------- traffic lights ----------------
const CYCLE = 34;
class TrafficLights {
  constructor(roads, scene) {
    this.roads = roads;
    this.t = 0;
    this.nodes = new Map(); // ni -> {offset, groupOf: Map(edgeIndex -> 0|1), approaches: [{x,y,z,yaw,ei}]}
    for (let ni = 0; ni < roads.nodes.length; ni++) {
      const adj = roads.adj[ni];
      if (adj.length < 3) continue;
      const es = adj.map((ei) => roads.edges[ei]);
      if (roads.isSignalised ? !roads.isSignalised(ni) : !es.some((e) => e.lit) || es.every((e) => e.kind === 1)) continue;
      // pole spots on the kerbed corners (Roads.signalSpots: far-side mast arms, src/world/Junctions.js)
      const spots = roads.signalSpots?.get(ni);
      const [nx, nz] = roads.nodes[ni];
      const dirs = es.map((e) => {
        const fromA = e.a === ni;
        const k = fromA ? Math.min(2, e.n - 1) : Math.max(0, e.n - 3);
        const dx = e.pts[2 * k] - nx, dz = e.pts[2 * k + 1] - nz;
        const l = Math.hypot(dx, dz) || 1;
        return [dx / l, dz / l];
      });
      const groupOf = new Map();
      const approaches = [];
      es.forEach((e, i) => {
        const c = Math.abs(dirs[i][0] * dirs[0][0] + dirs[i][1] * dirs[0][1]);
        groupOf.set(e.i, c > 0.7 ? 0 : 1);
        const sp = spots?.get(e.i);
        if (sp) { approaches.push({ x: sp.x, z: sp.z, y: sp.y, yaw: sp.yaw, ei: e.i, key: `${ni}:${i}` }); return; }
        // light pole at the right kerb of the incoming lane, at the stop line
        const r = roads.nodeR[ni] + 2.5;
        const [dx, dz] = dirs[i];
        const inx = -dx, inz = -dz; // incoming travel direction
        const rx = -inz, rz = inx; // right of travel
        const off = e.w / 2 + 1.2;
        approaches.push({ x: nx + dx * r + rx * off, z: nz + dz * r + rz * off, y: roads.nodeY[ni], yaw: Math.atan2(-inx, -inz), ei: e.i, key: `${ni}:${i}` });
      });
      this.nodes.set(ni, { offset: Math.random() * CYCLE, groupOf, approaches });
    }
    // instanced poles with 3-lamp heads, state per instance
    const geo = trafficLightGeometry();
    this.state01 = new THREE.InstancedBufferAttribute(new Float32Array(1200), 1);
    this.state01.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aState', this.state01);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.6, metalness: 0.3 });
    this.uni = { uNight: { value: 0 } };
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uNight = this.uni.uNight;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aState; attribute float aLamp; varying float vState; varying float vLamp;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvState = aState; vLamp = aLamp;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight; varying float vState; varying float vLamp;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          if (vLamp > 0.5) {
            float on = 1.0 - step(0.5, abs(vLamp - 1.0 - vState));
            vec3 lc = vLamp < 1.5 ? vec3(1.0, 0.08, 0.05) : vLamp < 2.5 ? vec3(1.0, 0.6, 0.05) : vec3(0.1, 1.0, 0.45);
            totalEmissiveRadiance += lc * on * (2.0 + 4.0 * uNight);
            diffuseColor.rgb = mix(diffuseColor.rgb * 0.3, lc, on * 0.6);
          }`);
    };
    mat.customProgramCacheKey = () => 'tlight';
    this.mesh = new THREE.InstancedMesh(geo, mat, 1200);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    scene.add(this.mesh);
    this.visible = [];
    this.refresh = 0;
    this.colliders = new Map(); // key -> collider
    this.broken = new Map(); // key -> { body, holder, t }
    this.brokenNodes = new Set();
    this.sigTimer = 0;
    // stop signs at the stop-controlled approaches (Roads.signSpots), instanced around the focus; retroreflective
    // faces read at night (a touch of emission scaled by night, no light)
    if (roads.signSpots?.length) {
      const sm = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.55, metalness: 0.15 });
      sm.onBeforeCompile = (sh) => {
        sh.uniforms.uNight = this.uni.uNight;
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight;')
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.22 * uNight;');
      };
      sm.customProgramCacheKey = () => 'stopsign-v1';
      this.signs = new PropField(stopSignGeometry(), sm, roads.signSpots, scene, 300);
    }
  }

  // 0 red, 1 yellow, 2 green (uncontrolled = 2; a knocked-down signal leaves its junction uncontrolled)
  state(ni, ei) {
    const n = this.nodes.get(ni);
    if (!n || this.brokenNodes.has(ni)) return 2;
    const g = n.groupOf.get(ei) ?? 0;
    const t = (this.t + n.offset) % CYCLE;
    const half = CYCLE / 2;
    const tt = g === 0 ? t : (t + half) % CYCLE;
    if (tt < half - 4) return 2;
    if (tt < half - 1) return 1;
    return 0;
  }

  update(dt, focus) {
    this.t += dt;
    this.signs?.update(dt, focus);
    this.refresh -= dt;
    if (this.refresh <= 0) {
      this.refresh = 0.5;
      this.visible = [];
      for (const [ni, n] of this.nodes) {
        const [x, z] = this.roads.nodes[ni];
        if (Math.abs(x - focus.x) > 600 || Math.abs(z - focus.z) > 600) continue;
        for (const ap of n.approaches) if (!this.broken.has(ap.key)) this.visible.push([ni, ap]);
      }
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1);
      const count = Math.min(this.visible.length, 1200);
      for (let i = 0; i < count; i++) {
        const ap = this.visible[i][1];
        m.compose(TMP.set(ap.x, ap.y, ap.z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ap.yaw), s);
        this.mesh.setMatrixAt(i, m);
      }
      this.mesh.count = count;
      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // stream breakable pole colliders near the player
  updateColliders(RAPIER, world, x, z, radius, groups) {
    const need = new Set();
    for (const [ni, n] of this.nodes) {
      const [nx, nz] = this.roads.nodes[ni];
      if (Math.abs(nx - x) > radius || Math.abs(nz - z) > radius) continue;
      for (const ap of n.approaches) {
        if (this.broken.has(ap.key)) continue;
        need.add(ap.key);
        if (this.colliders.has(ap.key)) continue;
        const desc = RAPIER.ColliderDesc.cylinder(3.0, 0.2).setTranslation(ap.x, ap.y + 3.0, ap.z)
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(2500);
        if (groups !== undefined) desc.setCollisionGroups(groups);
        const c = world.createCollider(desc);
        c.userData = { tlight: ap.key, ni };
        this.colliders.set(ap.key, c);
      }
    }
    for (const [k, c] of this.colliders) if (!need.has(k)) { world.removeCollider(c, false); this.colliders.delete(k); }
  }

  // knock a signal pole over (dynamic body + dark copy of the pole), junction becomes uncontrolled
  breakLight(RAPIER, world, scene, key, dir, groups, deadMat) {
    if (this.broken.has(key)) return null;
    const c = this.colliders.get(key);
    if (c) { world.removeCollider(c, false); this.colliders.delete(key); }
    const ni = +key.split(':')[0];
    const ap = this.nodes.get(ni)?.approaches.find((a) => a.key === key);
    if (!ap) return null;
    this.brokenNodes.add(ni);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ap.yaw);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(ap.x, ap.y + 3.0, ap.z).setRotation(q));
    const cd = RAPIER.ColliderDesc.cuboid(0.2, 3.0, 0.2).setDensity(160);
    if (groups !== undefined) cd.setCollisionGroups(groups);
    world.createCollider(cd, body);
    body.applyImpulse({ x: dir.x * 1100, y: 250, z: dir.z * 1100 }, true);
    body.applyTorqueImpulse({ x: dir.z * 2200, y: 0, z: -dir.x * 2200 }, true);
    const mesh = new THREE.Mesh(this.mesh.geometry, deadMat || this.mesh.material);
    mesh.castShadow = true;
    mesh.position.y = -3.0;
    const holder = new THREE.Group();
    holder.add(mesh);
    scene.add(holder);
    this.broken.set(key, { body, holder, t: 0 });
    this.refresh = 0; // drop it from the instanced batch now
    return { x: ap.x, y: ap.y, z: ap.z };
  }

  syncBroken(dt, world, scene) {
    for (const b of this.broken.values()) {
      if (!b.body) continue;
      const t = b.body.translation(), r = b.body.rotation();
      b.holder.position.set(t.x, t.y, t.z);
      b.holder.quaternion.set(r.x, r.y, r.z, r.w);
      b.t += dt;
      if (b.t > 25) { world.removeRigidBody(b.body); scene.remove(b.holder); b.body = null; }
    }
  }

  // signal heads with their current colour for the ground light map: [x, z, r, g, b]
  signalHeads() {
    const out = this._heads || (this._heads = []);
    out.length = 0;
    const n = this.mesh.count;
    for (let i = 0; i < n; i++) {
      const [ni, ap] = this.visible[i];
      const st = this.state(ni, ap.ei);
      // glow falls on the lane under the head (arm reaches 3.9 m over the road), a bit ahead of the stop line
      const hx = ap.x - Math.cos(ap.yaw) * 3.9 - Math.sin(ap.yaw) * 1.5, hz = ap.z + Math.sin(ap.yaw) * 3.9 - Math.cos(ap.yaw) * 1.5;
      out.push([hx, hz, st === 2 ? 0.1 : 1.0, st === 2 ? 1.0 : st === 1 ? 0.6 : 0.08, st === 2 ? 0.45 : 0.05]);
    }
    return out;
  }

  // nearest signal heads -> fake light uniforms (coloured glow on the road and on cars / people)
  uploadSignals(camera, night) {
    const U = SIGNAL_UNIFORMS;
    if (night < 0.05 || !camera) { U.uSigCount.value = 0; return; }
    const cx = camera.position.x, cz = camera.position.z;
    const best = this._sigBest || (this._sigBest = []);
    best.length = 0;
    for (let i = 0; i < this.mesh.count; i++) {
      const [ni, ap] = this.visible[i];
      const hx = ap.x - Math.cos(ap.yaw) * 3.9, hz = ap.z + Math.sin(ap.yaw) * 3.9; // head over the lane
      const d = (hx - cx) ** 2 + (hz - cz) ** 2;
      if (d > 140 * 140) continue;
      best.push([d, hx, ap.y + 5.4, hz, this.state(ni, ap.ei)]);
    }
    best.sort((a, b) => a[0] - b[0]);
    const n = Math.min(best.length, MAX_SIGNALS);
    for (let i = 0; i < n; i++) {
      const [, x, y, z, st] = best[i];
      U.uSig.value[i].set(x, y, z, night);
      U.uSigCol.value[i].set(st === 2 ? 0.1 : 1.0, st === 2 ? 1.0 : st === 1 ? 0.6 : 0.08, st === 2 ? 0.45 : 0.05);
    }
    U.uSigCount.value = n;
  }

  render(night) {
    this.uni.uNight.value = night;
    const n = this.mesh.count;
    for (let i = 0; i < n; i++) {
      const [ni, ap] = this.visible[i];
      this.state01.setX(i, this.state(ni, ap.ei));
    }
    this.state01.needsUpdate = true;
  }
}

function trafficLightGeometry() {
  const parts = [];
  const add = (g, color, lamp = 0) => {
    const ng = g.toNonIndexed();
    const n = ng.attributes.position.count;
    const c = new THREE.Color(color);
    const col = new Float32Array(n * 3), lp = new Float32Array(n);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; lp[i] = lamp; }
    ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
    ng.setAttribute('aLamp', new THREE.BufferAttribute(lp, 1));
    ng.deleteAttribute('uv');
    parts.push(ng);
  };
  const pole = new THREE.CylinderGeometry(0.1, 0.13, 6.2, 6); pole.translate(0, 3.1, 0); add(pole, 0x3a3d42);
  // arm reaches over the lanes (local -x = towards the road centre), lamps face approaching cars (+z)
  const arm = new THREE.BoxGeometry(4.2, 0.12, 0.12); arm.translate(-2.0, 5.9, 0); add(arm, 0x3a3d42);
  const box = new THREE.BoxGeometry(0.42, 1.25, 0.36); box.translate(-3.9, 5.25, 0); add(box, 0x1f2124);
  [[1, 5.66, 0xff2a20], [2, 5.25, 0xffaa10], [3, 4.84, 0x30ff80]].forEach(([id, y, c]) => {
    const l = new THREE.BoxGeometry(0.26, 0.26, 0.05); l.translate(-3.9, y, 0.2); add(l, c, id);
  });
  const g = mergeAll(parts);
  return g;
}

function mergeAll(parts) {
  let total = 0;
  for (const p of parts) total += p.attributes.position.count;
  const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3), col = new Float32Array(total * 3), lamp = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array, o * 3);
    nrm.set(p.attributes.normal.array, o * 3);
    col.set(p.attributes.color.array, o * 3);
    lamp.set(p.attributes.aLamp.array, o);
    o += p.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aLamp', new THREE.BufferAttribute(lamp, 1));
  g.computeBoundingSphere();
  return g;
}
