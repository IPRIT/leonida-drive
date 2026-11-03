// Boat physics specs. Body frame: x right, y up, -z forward; origin on the static waterline, centre of the hull.
import { G } from '../air/physics/math.js';

// V-hull convex collider: deck at yDeck, keel at yKeel, chines at yChine, pointed bow.
function vHull(L, W, yKeel, yChine, yDeck, bowY = yDeck) {
  const hl = L / 2, hw = W / 2;
  const pts = [
    // stern transom
    -hw, yDeck, hl, hw, yDeck, hl, -hw, yChine, hl, hw, yChine, hl, 0, yKeel, hl,
    // mid section
    -hw, yDeck, 0, hw, yDeck, 0, -hw, yChine, 0, hw, yChine, 0, 0, yKeel, 0,
    // forward shoulder
    -hw * 0.7, yDeck, -hl * 0.65, hw * 0.7, yDeck, -hl * 0.65, 0, yKeel + 0.1, -hl * 0.65,
    // bow tip
    0, bowY, -hl, 0, (yChine + bowY) / 2, -hl + 0.15,
  ];
  return { shape: 'hull', points: pts, friction: 0.55, restitution: 0.08, minFriction: true };
}

export const BOAT_SPECS = {
  boat_speed: {
    kind: 'boat', mass: 2200, com: { x: 0, y: -0.05, z: 0.4 }, inertia: { x: 16700, y: 17700, z: 1600 },
    topSpeedKmh: 112, maxRpm: 6200, idleRpm: 750, crashDv: 18,
    hull: { length: 9.4, width: 2.5, draft: 0.34, bottomY: -0.34, nx: 3, nz: 5, bowTaper: 0.7, keelAft: 1.6 },
    thrustK: 0.65, reverse: 0.4, spool: 0.6, cfLin: 25, heave: 3.4, lateral: 55,
    rudder: 3.0, rudderV: 9, thrustSteer: 1.0, yawDamp: 1.7, bank: 0.22, bankK: 5.5,
    planeV0: 6.5, planeV1: 15, planeLift: 0.22, planeDrop: 0.55, humpPitch: 0.9, trimPitch: 0.12,
    prop: { y: -0.32, z: 4.5 },
    colliders: [vHull(9.4, 2.5, -0.42, -0.12, 0.7, 0.95)],
  },
  boat_jetski: {
    kind: 'boat', mass: 390, com: { x: 0, y: 0.05, z: 0.2 }, inertia: { x: 360, y: 380, z: 70 },
    topSpeedKmh: 96, maxRpm: 7500, idleRpm: 1200, crashDv: 16,
    hull: { length: 3.2, width: 1.1, draft: 0.2, bottomY: -0.2, nx: 2, nz: 4, bowTaper: 0.5, keelAft: 1.2 },
    thrustK: 0.8, reverse: 0.3, spool: 0.35, cfLin: 6, heave: 3.6, lateral: 14,
    rudder: 1.2, rudderV: 8, thrustSteer: 6, yawDamp: 1.6, bank: 0.45, bankK: 8,
    planeV0: 4, planeV1: 10, planeLift: 0.2, planeDrop: 0.5, humpPitch: 1.0, trimPitch: 0.1,
    prop: { y: -0.18, z: 1.5 },
    colliders: [vHull(3.2, 1.1, -0.26, -0.08, 0.45, 0.55)],
  },
  boat_cruiser: {
    kind: 'boat', mass: 7600, com: { x: 0, y: 0.15, z: 0.5 }, inertia: { x: 86000, y: 92000, z: 12000 },
    topSpeedKmh: 66, maxRpm: 3600, idleRpm: 650, crashDv: 20,
    hull: { length: 11.6, width: 3.8, draft: 0.62, bottomY: -0.62, nx: 3, nz: 5, bowTaper: 0.6, keelAft: 1.8 },
    thrustK: 0.3, reverse: 0.45, spool: 1.2, cfLin: 120, heave: 3.0, lateral: 160,
    rudder: 0.9, rudderV: 6, thrustSteer: 0.35, yawDamp: 1.3, bank: 0.06, bankK: 3,
    planeV0: 8, planeV1: 15, planeLift: 0.1, planeDrop: 0.3, humpPitch: 0.35, trimPitch: 0.05,
    prop: { y: -0.6, z: 5.4 },
    colliders: [vHull(11.6, 3.8, -0.72, -0.25, 1.2, 1.5)],
  },
  boat_airboat: {
    kind: 'boat', mass: 680, com: { x: 0, y: 0.25, z: 0.3 }, inertia: { x: 1250, y: 1450, z: 330 },
    topSpeedKmh: 72, maxRpm: 5200, idleRpm: 900, crashDv: 16, skims: true,
    hull: { length: 4.6, width: 2.2, draft: 0.12, bottomY: -0.12, nx: 3, nz: 4, bowTaper: 0.2, keelAft: 0.5 },
    thrustK: 0.48, reverse: 0, spool: 0.8, cfLin: 18, heave: 3.2, lateral: 9,
    rudder: 0.7, rudderV: 8, thrustSteer: 1.5, yawDamp: 1.2, bank: 0.03, bankK: 3,
    planeV0: 3, planeV1: 8, planeLift: 0.15, planeDrop: 0.45, humpPitch: 0.3, trimPitch: 0.04,
    prop: { y: 1.35, z: 1.75, air: true },
    colliders: [{ shape: 'box', hx: 1.1, hy: 0.22, hz: 2.3, x: 0, y: 0.08, z: 0, friction: 0.1, restitution: 0.05, minFriction: true }],
  },
};

/** Derive thrust and hull drag from the top speed. */
export function deriveBoatSpec(base) {
  const s = structuredClone(base);
  s.vTop = s.topSpeedKmh / 3.6;
  s.thrust = s.thrustK * s.mass * G;
  const Ttop = s.thrust * Math.max(0.1, 1 - 1 / 1.35);
  // at top speed: planing (drag reduced), wetted fraction ~0.75
  const wet = 0.86;
  s.cf = Math.max(1, (Ttop - s.cfLin * s.vTop * wet) / (s.vTop * s.vTop * (1 - s.planeDrop) * wet));
  return s;
}

export const BOAT_SPEC = Object.fromEntries(Object.entries(BOAT_SPECS).map(([k, v]) => [k, deriveBoatSpec(v)]));
