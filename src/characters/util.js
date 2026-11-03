// Small helpers shared by the player controller, pedestrians and cash pickups.
import * as THREE from 'three';
import { GROUPS, groups } from '../vehicle/groups.js';

// user-visible text: i18n key with an English fallback ({name} placeholders)
export function tr(game, key, en, params) {
  const fill = (s) => (params ? s.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined ? m : String(params[k]))) : s);
  const i = game?.i18n;
  if (!i?.t) return fill(en);
  const MISSING = '\u0000';
  const s = i.t(key, { ...(params || {}), default: MISSING });
  return s === MISSING || s === key ? fill(en) : s;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ---------- seats ----------
const SEAT_POSE = { car: 'car', truck: 'car', bike: 'bike', bus: 'car', van: 'car', small: 'car', motorcycle: 'bike', bike: 'bike', bicycle: 'bicycle', heli: 'heli', plane: 'plane', boat: 'boat' };
const _box = new THREE.Box3(), _q0 = new THREE.Quaternion(), _p0 = new THREE.Vector3();

// local bounding box of a controllable's model (cached)
export function localBox(v) {
  if (v.__lbox) return v.__lbox;
  const o = v.object3d;
  _q0.copy(o.quaternion); _p0.copy(o.position);
  o.quaternion.identity(); o.position.set(0, 0, 0);
  o.updateMatrixWorld(true);
  _box.setFromObject(o);
  o.quaternion.copy(_q0); o.position.copy(_p0);
  o.updateMatrixWorld(true);
  v.__lbox = _box.isEmpty() ? new THREE.Box3(new THREE.Vector3(-1, -0.5, -2), new THREE.Vector3(1, 1, 2)) : _box.clone();
  return v.__lbox;
}

/**
 * Driver seat of a controllable in its local frame.
 * @returns {{pos:THREE.Vector3, exit:THREE.Vector3, pose:string, recline:number, doors:boolean}}
 *   pos = hip-joint (pelvis) position, exit = standing point beside the door (feet)
 */
export function seatFor(v, dims) {
  if (v.__seat) return v.__seat;
  const kind = v.kind || 'car';
  let pose = SEAT_POSE[kind] || 'car';
  const s0 = v.seats?.[0];
  let seat;
  if (s0?.pos) {
    if (s0.pose) pose = SEAT_POSE[s0.pose] || s0.pose;
    const pos = new THREE.Vector3(s0.pos.x, s0.pos.y, s0.pos.z);
    const exit = s0.exit ? new THREE.Vector3(s0.exit.x, s0.exit.y, s0.exit.z) : new THREE.Vector3(pos.x - 1.2, pos.y - 0.45, pos.z);
    let recline = s0.recline ?? (pose === 'car' ? (s0.pose === 'truck' ? 0.08 : 0.22) : 0.06);
    // fit the head under the roof: recline first, then sink the seat (seat points may be cushion height)
    const r = v.spec?.wheelRadius ?? 0;
    const roof = v.spec?.collider?.cabin ? v.spec.collider.cabin.top - r : v.dims?.height ? v.dims.height - r : null;
    if (roof !== null && pose === 'car') {
      const torso = 0.485 * (dims?.h ?? 1.8);
      const avail = roof - 0.13 - pos.y; // roofs slope down towards the windscreen; keep hair inside
      if (avail < torso * Math.cos(recline)) recline = clamp(Math.acos(clamp(avail / torso, -1, 1)), recline, 0.5);
      const need = torso * Math.cos(recline);
      if (avail < need) {
        const floor = (v.spec?.collider?.clearance ?? 0.15) + 0.1 - r;
        pos.y = Math.max(floor, roof - 0.13 - need);
      }
    }
    seat = { pos, exit, pose, recline };
  } else if (v.spec?.collider && pose === 'car') {
    const s = v.spec, c = s.collider, cab = c.cabin, r = s.wheelRadius;
    const torso = 0.485 * (dims?.h ?? 1.8);
    const hipY = Math.max(c.clearance + 0.13, 0.27) + Math.max(0, c.belt - 0.9) * 0.55;
    const headroom = cab.top - hipY - 0.04;
    const recline = clamp(Math.acos(clamp(headroom / torso, 0.5, 1)), 0.1, 0.62);
    const x = -Math.min(0.4, cab.width * 0.25);
    const z = cab.z0 + (cab.z1 - cab.z0) * 0.4;
    seat = {
      pos: new THREE.Vector3(x, hipY - r, z),
      exit: new THREE.Vector3(-(s.size.width / 2 + 0.5), -r, z - 0.1),
      pose, recline,
    };
  } else {
    const b = localBox(v);
    const size = b.getSize(new THREE.Vector3());
    const cz = (b.min.z + b.max.z) / 2;
    let y = b.min.y + size.y * 0.42, x = 0, z = cz;
    if (pose === 'bike' || pose === 'bicycle') { y = b.min.y + Math.min(0.92, size.y * 0.62); z = cz + size.z * 0.06; }
    else if (pose === 'boat') { y = b.min.y + size.y * 0.35 + 0.95; z = cz + size.z * 0.1; }
    else if (pose === 'heli' || pose === 'plane') { x = pose === 'heli' ? size.x * 0.1 : 0; z = cz - size.z * (pose === 'plane' ? 0.08 : 0.15); y = b.min.y + size.y * 0.3 + 0.35; }
    seat = { pos: new THREE.Vector3(x, y, z), exit: new THREE.Vector3(b.min.x - 0.6, b.min.y, z), pose, recline: 0.08 };
  }
  seat.doors = pose === 'car';
  // hip-to-floor drop (for foot placement in the seated pose)
  const rr = v.spec?.wheelRadius ?? 0;
  const floor = v.spec?.collider ? v.spec.collider.clearance + 0.08 - rr : seat.pos.y - 0.45;
  seat.legDrop = Math.max(0.12, seat.pos.y - floor);
  v.__seat = seat;
  return seat;
}

// ---------- moving obstacles (vehicles, traffic) ----------
const _fwd = new THREE.Vector3();
const _qq = new THREE.Quaternion();
// fills out = {x,y,z,yaw,hw,hl,vx,vy,vz,speed}; returns out
export function vehicleBox(v, out = {}) {
  const t = v.body.translation(), r = v.body.rotation(), lv = v.body.linvel();
  _fwd.set(0, 0, -1).applyQuaternion(_qq.set(r.x, r.y, r.z, r.w));
  if (v.__hw === undefined) {
    if (v.spec?.size) { v.__hw = v.spec.size.width / 2; v.__hl = v.spec.size.length / 2; } else {
      const b = localBox(v);
      v.__hw = (b.max.x - b.min.x) / 2; v.__hl = (b.max.z - b.min.z) / 2;
    }
  }
  out.x = t.x; out.y = t.y; out.z = t.z;
  out.yaw = Math.atan2(-_fwd.x, -_fwd.z);
  out.hw = v.__hw; out.hl = v.__hl;
  out.vx = lv.x; out.vy = lv.y; out.vz = lv.z;
  out.speed = Math.hypot(lv.x, lv.z);
  out.ref = v;
  return out;
}

export function agentBox(a, out = {}) {
  const b = a.type?.baked;
  out.x = a.cur.x; out.y = a.cur.y; out.z = a.cur.z;
  const q = a.cq;
  _fwd.set(0, 0, -1).applyQuaternion(q);
  out.yaw = Math.atan2(-_fwd.x, -_fwd.z);
  out.hw = (b?.width ?? 1.9) / 2; out.hl = (b?.length ?? 4.5) / 2;
  if (a.crashed && a.body?.linvel && (!a.body.isValid || a.body.isValid())) { const lv = a.body.linvel(); out.vx = lv.x; out.vy = lv.y; out.vz = lv.z; } else {
    out.vx = (a.fx ?? 0) * a.v; out.vy = 0; out.vz = (a.fz ?? -1) * a.v;
  }
  out.speed = Math.hypot(out.vx, out.vz);
  out.ref = a;
  return out;
}

// point (px,pz) in the box frame: {lx, lz} where lz < 0 is in front
export function boxLocal(b, px, pz, out = {}) {
  const dx = px - b.x, dz = pz - b.z;
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  out.lx = dx * c - dz * s;
  out.lz = dx * s + dz * c;
  return out;
}

// ---------- traffic takeover (fallback until Traffic.takeOver lands) ----------
export function takeOverTraffic(game, agent) {
  const tr = game.traffic;
  if (tr?.takeOver) return tr.takeOver(agent);
  const t = agent.body.translation(), r = agent.body.rotation();
  _fwd.set(0, 0, -1).applyQuaternion(_qq.set(r.x, r.y, r.z, r.w));
  const yaw = Math.atan2(-_fwd.x, -_fwd.z);
  const name = agent.type?.name;
  const id = game.vehicles?.byId?.has(name) ? name : 'comet';
  const spec = {
    id, yaw, color: agent.paint?.getHex?.() ?? 0xffffff,
    pos: { x: t.x, y: t.y - (agent.lift ?? 0.32) - (agent.halfH ?? 0.5), z: t.z },
  };
  tr?.remove?.(agent);
  return spec;
}

// ---------- ground ----------
const _ray = { origin: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: -1, z: 0 } };
let _rapierRay = null;
// highest walkable surface below (x, fromY, z): physics ray, falls back to the terrain height
export function groundY(game, x, z, fromY = null, mask = GROUPS.GROUND | GROUPS.STATIC) {
  const th = game.terrain.heightAt(x, z);
  if (!game.world || !game.RAPIER) return th;
  if (!_rapierRay) _rapierRay = new game.RAPIER.Ray(_ray.origin, _ray.dir);
  const y0 = (fromY ?? th + 60) + 1.2;
  _rapierRay.origin = { x, y: y0, z };
  _rapierRay.dir = { x: 0, y: -1, z: 0 };
  const hit = game.world.castRay(_rapierRay, 400, true, undefined, groups(0xffff, mask));
  return hit ? y0 - hit.timeOfImpact : th;
}

export function surfaceAt(terrain, x, z) {
  const G = terrain.G, g = terrain.groundAt(x, z);
  if (g === G.sand) return 'sand';
  if (g === G.water) return terrain.heightAt(x, z) < -0.15 ? 'water' : 'sand';
  if (g === G.grass || g === G.park || g === G.farm || g === G.sport) return 'grass';
  if (g === G.dirt) return 'dirt';
  if (g === G.wetland) return 'mud';
  return 'concrete';
}

// a standing point on the sidewalk next to the nearest road
export function sidewalkSpawn(game, x, z) {
  const { roads, terrain } = game;
  let n = roads.nearest(x, z, 800, (e) => e.kind !== 1 && !e.br);
  if (!n) n = roads.nearest(x, z, 6000);
  if (!n) return { x, z, y: Math.max(terrain.heightAt(x, z), 0), yaw: 0 };
  const [dx, dz] = n.dir;
  const off = n.edge.w / 2 + 1.8;
  const sx = n.x - dz * off, sz = n.z + dx * off;
  return { x: sx, z: sz, y: Math.max(terrain.heightAt(sx, sz), n.y), yaw: Math.atan2(-dx, -dz) };
}

// ---------- hospitals (respawn points) ----------
const HOSPITAL_DISTRICTS = ['Ocean Beach', 'Washington Beach', 'Downtown', 'Little Cuba', 'Tequesta', 'Crosstown', 'Southside',
  'Salton', 'Bayside', 'Port Gellhorn', 'Hamlet', 'Key Lento', 'Ambrosia', 'Capri', 'Belville', 'Peregrine Bay'];
export function hospitals(game) {
  if (game.__hospitals) return game.__hospitals;
  const ds = game.worldData?.districts || [];
  const out = [];
  for (const name of HOSPITAL_DISTRICTS) {
    const d = ds.find((x) => x.name === name);
    if (d) out.push({ name, x: d.x, z: d.z });
  }
  if (!out.length) out.push({ name: 'Leonida', x: 1745, z: -640 });
  game.__hospitals = out;
  return out;
}

export function nearestHospital(game, x, z) {
  let best = null, bd = Infinity;
  for (const h of hospitals(game)) {
    const d = Math.hypot(h.x - x, h.z - z);
    if (d < bd) { bd = d; best = h; }
  }
  return best;
}
