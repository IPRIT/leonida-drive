// Shared knock-down model (pedestrian ragdolls, scripted tumbles, the player): launch velocity and spin from a
// vehicle hit or an explosion. Mostly horizontal along the car's motion, small lift, capped spin, so bodies tumble
// a few metres at city speed and get thrown further (never skywards) at highway speed.

export const KNOCK = {
  maxH: 16, // m/s horizontal launch cap
  liftRatio: 0.22, // vertical <= 22% of horizontal
  maxSpin: 4.2, // rad/s
  slideDecel: 6.5, // m/s^2 ground friction for scripted tumbles (matches the ragdolls)
  pedMass: 80,
};

/**
 * Launch for a pedestrian hit by a vehicle.
 * @param {{vx:number, vz:number}} car velocity of the vehicle (m/s)
 * @param {number} pvx pedestrian velocity
 * @param {number} pvz
 * @param {number} side -1..1 lateral offset of the ped from the car's centre line (glancing hits push sideways)
 * @param {{x,y,z,sx,sy,sz,h,rel}} out velocity (x,y,z), spin (sx,sy,sz), horizontal speed h, relative speed rel
 */
export function vehicleKnock(car, pvx, pvz, side, out = {}) {
  const rvx = car.vx - pvx, rvz = car.vz - pvz;
  const rel = Math.hypot(rvx, rvz);
  const cs = Math.hypot(car.vx, car.vz) || 1;
  const dx = car.vx / cs, dz = car.vz / cs;
  const k = Math.min(1.2, rel / 22);
  const h = Math.min(rel * (0.85 - 0.1 * k), KNOCK.maxH); // close to car speed in town: pushed ahead, not run over
  // glancing: part of the push goes sideways (right of travel = (-dz, dx))
  const lat = Math.max(-1, Math.min(1, side)) * 0.28 * h;
  out.x = dx * h - dz * lat;
  out.z = dz * h + dx * lat;
  out.y = Math.min(0.25 * h, Math.min(KNOCK.liftRatio * h, 0.6 + 2.6 * k) + 0.4); // never more than 25% up
  // legs swept forward, head falls back onto the hood: spin about (dir x up)
  const w = Math.min(KNOCK.maxSpin, 1.6 + 2.4 * k);
  out.sx = -dz * w;
  out.sy = (Math.random() - 0.5) * 1.0;
  out.sz = dx * w;
  out.h = h;
  out.rel = rel;
  // scripted tumbles (no car contact) get the extra push a ragdoll receives from the hood while the car keeps going
  out.carry = Math.min(18, rel * 0.9);
  return out;
}

/** Launch for a body near an explosion: falloff with distance, capped. */
export function blastKnock(dx, dy, dz, radius, power, out = {}) {
  const d = Math.hypot(dx, dy, dz) || 0.01;
  const k = Math.max(0, 1 - d / radius);
  const n = Math.hypot(dx, dz) || 1;
  const h = Math.min(KNOCK.maxH * 0.8, (3 + 10 * k * k) * Math.min(1.5, power));
  out.x = (dx / n) * h;
  out.z = (dz / n) * h;
  out.y = Math.min(0.32 * h, 1.2 + 3 * k);
  const w = Math.min(KNOCK.maxSpin, 1 + 3 * k);
  out.sx = (dz / n) * w;
  out.sy = (Math.random() - 0.5) * 0.8;
  out.sz = -(dx / n) * w;
  out.h = h;
  out.k = k;
  return out;
}

/**
 * The vehicle feels the hit: momentum handed to the pedestrian is taken off the car (a slight slowdown).
 * b: box from util.vehicleBox/agentBox (ref = vehicle or traffic agent, traffic = AI-driven agent).
 */
export function pushVehicle(b, mass, h) {
  const ref = b.ref;
  if (!ref) return;
  const J = mass * h * 0.7;
  const n = b.speed || 1;
  if (b.traffic) { // AI traffic is velocity-driven: take the speed off its controller
    if (typeof ref.v === 'number') ref.v = Math.max(0, ref.v - J / 1400);
    return;
  }
  const body = ref.body;
  if (body?.applyImpulse) body.applyImpulse({ x: -(b.vx / n) * J, y: 0, z: -(b.vz / n) * J }, true);
}

/**
 * Scripted tumble (distant pedestrians without a ragdoll), same arc as a ragdoll: ballistic flight with air drag,
 * then a sliding roll braked by ground friction. t = {x,y,z,vx,vy,vz,air,spin,h0,rot}; gy = ground height here.
 * @returns {boolean} true when the body came to rest
 */
export function tumbleStep(t, dt, gy) {
  const drag = Math.exp(-0.3 * dt);
  t.vx *= drag; t.vz *= drag;
  const h = Math.hypot(t.vx, t.vz);
  if (t.air) {
    t.vy -= 9.81 * dt;
    t.y += t.vy * dt;
    if (t.y <= gy && t.vy < 0) { t.y = gy; t.vy = 0; t.air = false; }
    t.rot += t.spin * dt;
  } else {
    const nh = Math.max(0, h - KNOCK.slideDecel * dt);
    if (h > 1e-4) { t.vx *= nh / h; t.vz *= nh / h; }
    t.y = gy;
    t.rot += t.spin * dt * Math.min(1, nh / t.h0);
  }
  t.x += t.vx * dt; t.z += t.vz * dt;
  return !t.air && h < 0.25;
}

/**
 * Hood ramp for Ragdolls.addRamp in the vehicle body's local frame: from the front bumper top up to the roof.
 * Works for Vehicle (spec.collider) and traffic agents (baked box); null for anything else.
 */
export function hoodRamp(ref) {
  const sp = ref?.spec;
  if (sp?.collider?.cabin && sp.size) {
    const r = sp.wheelRadius ?? 0, c = sp.collider;
    return { hw: Math.min(c.cabin.width, sp.size.width) * 0.48, z0: -sp.size.length / 2 - 0.05, y0: c.belt - r - 0.12, z1: c.cabin.z0 + 0.6, y1: c.cabin.top - r + 0.05 };
  }
  const bk = ref?.type?.baked;
  if (bk && ref.halfH !== undefined) {
    const L = bk.length * 0.47, h = ref.halfH;
    return { hw: bk.width * 0.42, z0: -L - 0.05, y0: -h * 0.1, z1: -L + bk.length * 0.38, y1: h + 0.05 };
  }
  return null;
}
