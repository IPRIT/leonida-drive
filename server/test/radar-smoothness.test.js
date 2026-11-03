// Minimap blips must move smoothly every frame. Far players arrive as radar summaries every 2 s (position, heading,
// speed along the heading, id); RadarTracks dead-reckons them and blends corrections. This records the blip position per rendered
// frame (60 fps with jitter) for a car driving a circle and checks for steps: the per-frame acceleration of the blip
// stays near the true centripetal acceleration (a 1 m snap at 60 fps would read as ~3,600 m/s²), and handing a player
// over between the 3D interpolation (anchor) and the radar track never jumps either.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RadarTracks } from '../../src/net/RadarTracks.js';
import { encodeGlobal } from '../../src/net/shared/protocol.js';
import * as P from '../../src/net/shared/protocol.js';

const R = 120, V = 28; // circle radius (m), speed (m/s) → true acceleration 6.5 m/s²
const truth = (t) => {
  const a = (V / R) * t;
  return { x: 1000 + R * Math.cos(a), z: 1000 + R * Math.sin(a), vx: -V * Math.sin(a), vz: V * Math.cos(a), yaw: Math.atan2(V * Math.sin(a), -V * Math.cos(a)) };
};
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// quantise like the wire (10-byte radar entry) so the test sees real precision
function wire(e) {
  const dv = new DataView(new ArrayBuffer(P.RADAR_ENTRY + 16));
  const rc = P.radarOf(e.x, e.z);
  P.writeRadarEntry(dv, 0, P.radarWinX0(rc), P.radarWinZ0(rc), e.x, e.z, 3, e.yaw, 1, 77, e.vx, e.vz);
  return P.readRadarEntry(dv, 0, P.radarWinX0(rc), P.radarWinZ0(rc), {});
}

test('radar blips: no steps at 60 fps with summaries every 2 s (jitter, a lost summary)', () => {
  const tr = new RadarTracks(), r = rng(5);
  let t = 0, nextRadar = 0, k = 0;
  const pos = [];
  while (t < 30) {
    const dt = (1 / 60) * (0.85 + r() * 0.3);
    t += dt;
    if (t >= nextRadar) {
      k++;
      // the summary is sampled up to 250 ms before its tick, arrives 20–120 ms late; summary #7 is lost
      const sampleT = nextRadar - r() * 0.25;
      if (k !== 7) tr.ingest(wire(truth(sampleT)), sampleT * 1000, t * 1000, t * 1000);
      nextRadar += 2;
    }
    tr.update(t * 1000, t * 1000, dt);
    const b = tr.byId.get(77);
    if (b) pos.push({ t, x: b.x, z: b.z, yaw: b.yaw, dt });
  }
  let maxAcc = 0, maxErr = 0, maxYawRate = 0;
  for (let i = 2; i < pos.length; i++) {
    const a = pos[i], b = pos[i - 1], c = pos[i - 2];
    const v1x = (a.x - b.x) / a.dt, v1z = (a.z - b.z) / a.dt, v0x = (b.x - c.x) / b.dt, v0z = (b.z - c.z) / b.dt;
    const acc = Math.hypot(v1x - v0x, v1z - v0z) / ((a.dt + b.dt) / 2);
    if (a.t > 3) maxAcc = Math.max(maxAcc, acc);
    const tt = truth(a.t);
    if (a.t > 3) maxErr = Math.max(maxErr, Math.hypot(a.x - tt.x, a.z - tt.z));
    let dy = a.yaw - b.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    if (a.t > 5) maxYawRate = Math.max(maxYawRate, Math.abs(dy) / a.dt);
  }
  console.log(`radar blips: max acceleration ${maxAcc.toFixed(1)} m/s² (true 6.5), max error ${maxErr.toFixed(1)} m, max heading rate ${maxYawRate.toFixed(2)} rad/s`);
  assert.ok(maxAcc < 60, `blip accelerations stay smooth (max ${maxAcc.toFixed(1)} m/s²)`);
  assert.ok(maxErr < 25, `blip stays close to the car (max ${maxErr.toFixed(1)} m)`);
  assert.ok(maxYawRate < 1, `heading eases (max ${maxYawRate.toFixed(2)} rad/s)`);
});

test('radar blips: hand-over between the 3D interpolation and the radar track is seamless', () => {
  const tr = new RadarTracks();
  let t = 0, maxStep = 0, prev = null;
  for (let i = 0; i < 60 * 8; i++) {
    const dt = 1 / 60;
    t += dt;
    const s = truth(t);
    const inView = t < 3 || t > 6; // leaves the interest rings at 3 s, comes back at 6 s
    if (inView) tr.anchor(77, s.x, s.z, s.yaw, s.vx, s.vz, t * 1000, 3, 1, t * 1000);
    if (!inView && Math.abs(t % 2) < dt) tr.ingest(wire(truth(t - 0.1)), (t - 0.1) * 1000, t * 1000, t * 1000);
    tr.update(t * 1000, t * 1000, dt);
    const b = tr.byId.get(77);
    if (prev) maxStep = Math.max(maxStep, Math.hypot(b.x - prev.x, b.z - prev.z));
    prev = { x: b.x, z: b.z };
  }
  // the car moves 28 m/s = 0.47 m per frame; a jump would show as a much larger step
  assert.ok(maxStep < 0.8, `no jump at the hand-over (max step ${maxStep.toFixed(2)} m per frame)`);
});

test('radar blips: a snapping 3D pose (long stall) is blended, not followed', () => {
  const tr = new RadarTracks();
  let t = 0, maxStep = 0, prev = null;
  for (let i = 0; i < 240; i++) {
    const dt = 1 / 60;
    t += dt;
    const s = truth(t);
    const x = i >= 120 ? s.x + 12 : s.x; // the 3D pose jumps 12 m at frame 120 and stays offset
    tr.anchor(77, x, s.z, s.yaw, s.vx, s.vz, t * 1000, 3, 1, t * 1000);
    tr.update(t * 1000, t * 1000, dt);
    const b = tr.byId.get(77);
    if (prev) maxStep = Math.max(maxStep, Math.hypot(b.x - prev.x, b.z - prev.z));
    prev = { x: b.x, z: b.z };
  }
  assert.ok(maxStep < 0.9, `blended (max step ${maxStep.toFixed(2)} m per frame)`);
});

test('radar entries carry the id and the speed along the heading on the wire', () => {
  assert.equal(P.RADAR_ENTRY, 10);
  const yaw = 2, sp = 32; // forward = (-sin yaw, -cos yaw)
  const e = wire({ x: 1234.5, z: -800.25, yaw, vx: -Math.sin(yaw) * sp, vz: -Math.cos(yaw) * sp });
  assert.equal(e.id, 77);
  assert.ok(Math.abs(e.vx + Math.sin(yaw) * sp) <= 1.6 && Math.abs(e.vz + Math.cos(yaw) * sp) <= 1.6);
  assert.ok(encodeGlobal); // module loads
});
