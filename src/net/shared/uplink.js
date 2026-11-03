// Uplink send-on-deviation (client → server), shared by the browser and the load-test bots. The client samples its
// state at 20 Hz but only uploads when what the server would extrapolate from the last upload (the same yaw-rate arc
// the whole pipeline uses) is off by more than a few centimetres / a fraction of a degree, when something discrete
// changed (model, flags, turret), or as a 4 Hz heartbeat. The thresholds are well inside the server's broadcast
// thresholds, so remote smoothness is unchanged; a parked or cruising car uploads 4 times a second instead of 20.
import { drArc } from './dr.js';

export const UPLINK = Object.freeze({
  heartbeatMs: 250, // the hub treats a sample older than 450 ms as a stalled sender
  pos: 0.05, // m
  yaw: 0.012, // rad (0.7°)
  vel: 0.25, // m/s
  yawRate: 0.08, // rad/s
  rot: 0.03, // pitch / roll, rad
  steer: 0.04, // rad
  turret: 0.015, // rad
});

const _d = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0 };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** last = the last uploaded state (or null), s = the current sample, dtMs = ms since that upload → send now? */
export function uplinkDue(last, s, dtMs) {
  if (!last || dtMs >= UPLINK.heartbeatMs) return true;
  if (s.model !== last.model || s.flags !== last.flags || s.ext !== last.ext) return true;
  const d = drArc(_d, last.x, last.y, last.z, last.vx, last.vy, last.vz, last.yaw, last.yawRate, dtMs / 1000);
  const ex = d.x - s.x, ey = d.y - s.y, ez = d.z - s.z;
  if (ex * ex + ey * ey + ez * ez > UPLINK.pos * UPLINK.pos) return true;
  const evx = d.vx - s.vx, evy = d.vy - s.vy, evz = d.vz - s.vz;
  if (evx * evx + evy * evy + evz * evz > UPLINK.vel * UPLINK.vel) return true;
  if (Math.abs(wrap(d.yaw - s.yaw)) > UPLINK.yaw) return true;
  if (Math.abs(last.yawRate - s.yawRate) > UPLINK.yawRate) return true;
  if (Math.abs(last.pitch - s.pitch) > UPLINK.rot || Math.abs(wrap(last.roll - s.roll)) > UPLINK.rot) return true;
  if (Math.abs(last.steer - s.steer) > UPLINK.steer) return true;
  if (s.ext && (Math.abs(wrap(last.turret - s.turret)) > UPLINK.turret || Math.abs(last.barrel - s.barrel) > UPLINK.turret)) return true;
  if (Math.abs(last.health - s.health) > 0.02) return true;
  return false;
}

/** Copy the fields uplinkDue compares (reuse `into`). */
export function rememberUplink(s, into = {}) {
  into.x = s.x; into.y = s.y; into.z = s.z; into.vx = s.vx; into.vy = s.vy; into.vz = s.vz; into.yaw = s.yaw; into.yawRate = s.yawRate;
  into.pitch = s.pitch; into.roll = s.roll; into.steer = s.steer; into.model = s.model; into.flags = s.flags; into.ext = !!s.ext;
  into.turret = s.turret || 0; into.barrel = s.barrel || 0; into.health = s.health ?? 1;
  return into;
}
