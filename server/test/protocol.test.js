// Wire protocol: encode/decode round trips, quantisation bounds, strict size checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../src/net/shared/protocol.js';
import * as C from '../../src/net/shared/constants.js';
import { nickName, nickCode, randomNickCode, validNickCode, ADJECTIVES, NOUNS } from '../../src/net/shared/nicknames.js';
import { worldClock } from '../../src/net/shared/worldclock.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (±${eps})`);

const rec = (o) => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, vx: 0, vy: 0, vz: 0, yawRate: 0, steer: 0, model: 0, flags: 0, age: 0, turret: 0, barrel: 0, ...o });

test('entity record: 19-byte motion part + optional parts, quantisation within bounds, dequantised mirror matches the decoder', () => {
  const dv = new DataView(new ArrayBuffer(64));
  const cell = P.cellOf(1745.37, -640.81);
  const x0 = P.cellX0(cell), z0 = P.cellZ0(cell);
  const deq = new Float64Array(8);
  const src = rec({ x: 1745.37, y: 12.34, z: -640.81, yaw: 2.5, pitch: 0.3, roll: -0.7, vx: 33.21, vy: -1.5, vz: -12.06, yawRate: 0.8, steer: 0.31, model: 42, flags: 0x0f25, age: 37 });
  const end = P.writeRecord(dv, 0, 0xabcdef, x0, z0, src, C.REC_ALL, deq);
  assert.equal(C.REC_SIZE, 19);
  assert.equal(end, 25, 'motion 19 + model/flags 3 + pitch/roll 2 + steer 1');
  assert.equal(P.recSize(C.REC_ALL, 0x0f25), 25);
  const r = P.readRecord(dv, 0, x0, z0, {});
  assert.equal(r.id, 0xabcdef); assert.equal(r.parts, C.REC_ALL); assert.equal(r.size, 25);
  near(r.x, 1745.37, 1 / C.Q_POS, 'x'); near(r.z, -640.81, 1 / C.Q_POS, 'z'); near(r.y, 12.34, 0.05, 'y');
  near(r.yaw, 2.5, 1e-4, 'yaw'); near(r.pitch, 0.3, 0.013, 'pitch'); near(r.roll, -0.7, 0.025, 'roll');
  near(r.vx, 33.21, 0.006, 'vx'); near(r.vy, -1.5, 0.5 / C.Q_VY, 'vy'); near(r.vz, -12.06, 0.006, 'vz');
  near(r.yawRate, 0.8, 1 / 32, 'yawRate'); near(r.steer, 0.31, 1 / 256, 'steer');
  assert.equal(r.model, 42); assert.equal(r.flags, 0x0f25); assert.equal(r.age, 74);
  // motion only (what a cruising car costs on most updates): 19 bytes, the optional fields stay unset
  P.writeRecord(dv, 0, 5, x0, z0, src, 0, null);
  const m = P.readRecord(dv, 0, x0, z0, {});
  assert.equal(m.size, 19); assert.equal(m.parts, 0); assert.equal(m.model, undefined); assert.equal(m.pitch, undefined); assert.equal(m.steer, undefined);
  near(m.vx, 33.21, 0.006, 'motion-only vx');
  // parts can be combined freely; the decoder walks them in order
  P.writeRecord(dv, 0, 6, x0, z0, src, C.REC_STEER, null);
  const st = P.readRecord(dv, 0, x0, z0, {});
  assert.equal(st.size, 20); near(st.steer, 0.31, 1 / 256, 'steer only'); assert.equal(st.model, undefined);
  // the sender's mirror must equal exactly what the receiver decodes (dead reckoning stays in lockstep)
  assert.equal(deq[0], r.x); assert.equal(deq[1], r.y); assert.equal(deq[2], r.z); assert.equal(deq[3], r.yaw);
  assert.equal(deq[4], r.vx); assert.equal(deq[5], r.vy); assert.equal(deq[6], r.vz); assert.equal(deq[7], r.yawRate);
});

test('record clamps out-of-range values instead of wrapping (hysteresis margin, extreme speeds, NaN)', () => {
  const dv = new DataView(new ArrayBuffer(32));
  const cell = P.cellOf(0, 0), x0 = P.cellX0(cell), z0 = P.cellZ0(cell);
  P.writeRecord(dv, 0, 1, x0, z0, rec({ x: x0 - 3, y: 5000, z: z0 + C.CELL + 3, yaw: NaN, pitch: 9, roll: -9, vx: 9999, vy: -9999, vz: NaN, yawRate: 99, steer: -99, model: 7, age: 999 }), C.REC_ALL, null);
  const r = P.readRecord(dv, 0, x0, z0, {});
  near(r.x, x0 - 3, 0.01, 'x inside the hysteresis margin'); near(r.z, z0 + C.CELL + 3, 0.01, 'z inside margin');
  assert.ok(r.y < 3200 && r.y > 3000, 'y clamped');
  assert.equal(r.yaw, 0); assert.ok(Math.abs(r.vx) <= 327.67 && Math.abs(r.vy) <= 127 / C.Q_VY); assert.equal(r.vz, 0);
  assert.ok(r.vy < 0, 'vy clamped, not wrapped');
  assert.equal(r.age, 510);
});

test('client STATE (38 bytes): round trip and strict size', () => {
  const dv = new DataView(new ArrayBuffer(C.STATE_SIZE));
  const s = { seq: 65535, t: 4294967295, serverClock: true, x: -9000.12, y: 350.5, z: 9500.99, yaw: -3.1, pitch: -1.2, roll: 3, vx: 300, vy: -300, vz: 0.01, yawRate: -7.9, steer: -0.99, model: 254, tpc: 3, flags: 0xffff, health: 0.5 };
  P.writeState(dv, s);
  const o = {};
  assert.ok(P.readState(dv, o));
  near(o.x, s.x, 0.01, 'x'); near(o.y, s.y, 0.01, 'y'); near(o.z, s.z, 0.01, 'z'); near(o.vx, 300, 0.01, 'vx');
  assert.equal(o.seq, 65535); assert.equal(o.t, 4294967295); assert.equal(o.serverClock, true); assert.equal(o.tpc, 3); assert.equal(o.model, 254);
  assert.equal(o.flags, C.F_CLIENT_MASK, 'server-owned flag bits are stripped'); near(o.health, 0.5, 0.003, 'health');
  assert.equal(P.readState(new DataView(new ArrayBuffer(37)), {}), false);
  assert.equal(P.readState(new DataView(new ArrayBuffer(39)), {}), false);
});

test('claims, economy requests and replies', () => {
  const c = P.decodeClaim(new DataView(P.encodeClaim({ reason: C.CLAIM.DELIVERY, seq: 9, amount: 1234, x: 10.25, z: -20.5, meta: 0xfeedbeef, p1: 1500, p2: 90, combo: 3.5, tier: 80, p3: 7 })));
  assert.deepEqual({ ...c }, { reason: 9, seq: 9, amount: 1234, x: 10.25, z: -20.5, meta: 0xfeedbeef, p1: 1500, p2: 90, combo: 3.5, tier: 80, p3: 7 });
  assert.equal(P.decodeClaim(new DataView(new ArrayBuffer(27))), null);
  const e = P.decodeEcon(new DataView(P.encodeEcon(C.ECON.SELL, 77, 12, 55)));
  assert.deepEqual({ ...e }, { op: 2, reqId: 77, model: 12, param: 55 });
  const r = P.decodeEconReply(new DataView(P.encodeEconReply(1, 77, C.ECON_RESULT.FUNDS, 12, 1e9, -5000)));
  assert.deepEqual({ ...r }, { op: 1, reqId: 77, result: 1, model: 12, money: 1e9, delta: -5000 });
  const w = P.decodeWallet(new DataView(P.encodeWallet(C.WALLET.CLAMPED, 5, 123456, 789, C.CLAIM.DRIFT, 2.5, 200000)));
  assert.deepEqual({ ...w }, { result: 1, seq: 5, balance: 123456, delta: 789, reason: 1, combo: 2.5, worth: 200000 });
  const o = P.decodeOwned(new DataView(P.encodeOwned([1, 2, 200, 255, 0, 300], 4321)));
  assert.deepEqual(o.owned, [1, 2, 200, 255]); assert.equal(o.worth, 4321);
  assert.deepEqual(P.decodeProgress(new DataView(P.encodeProgress({ c: [1, 2], dd: '2026-11-03' }))), { c: [1, 2], dd: '2026-11-03' });
});

test('welcome carries token, restore and the vehicle table', () => {
  const token = new Uint8Array(32).map((_, i) => i * 7);
  const w = P.decodeWelcome(new DataView(P.encodeWelcome({
    tickHz: 20, netId: 0x123456, nickCode: 0x1fffff, color: 5, nearR: 1, farR: 2, spawnCooldownS: 8, money: 5000, serverTime: 1.7e12 + 0.5,
    tick: 123456, restore: { x: 1, y: 2, z: -3, yaw: 1, model: 3, health: 0.75, paint: 0xff00aa }, claimsFrozen: true, token,
    models: [{ id: 'pip', vclass: 1 }, { id: 'plane_jet', vclass: 4 }],
  })));
  assert.equal(w.netId, 0x123456); assert.equal(w.money, 5000); assert.equal(w.serverTime, 1.7e12 + 0.5); assert.equal(w.tick, 123456);
  assert.deepEqual([...w.token], [...token]); assert.equal(w.claimsFrozen, true);
  assert.equal(w.restore.model, 3); near(w.restore.health, 0.75, 0.004, 'health'); assert.equal(w.restore.paint, 0xff00aa);
  assert.deepEqual(w.models, [{ id: 'pip', vclass: 1 }, { id: 'plane_jet', vclass: 4 }]);
  assert.equal(w.name, '');
  const w2 = P.decodeWelcome(new DataView(P.encodeWelcome({ tickHz: 20, netId: 1, nickCode: 1, color: 1, nearR: 1, farR: 2, spawnCooldownS: 8, money: 0, serverTime: 0, tick: 0, models: [], name: 'Vasya' })));
  assert.equal(w2.name, 'Vasya');
});

test('turret records and states, combat, services, outfits, nicknames, scoreboard pages', () => {
  // a tank record always carries the turret part (F_EXT), others never do
  const dv = new DataView(new ArrayBuffer(64));
  const x0 = P.cellX0(P.cellOf(100, 100)), z0 = P.cellZ0(P.cellOf(100, 100));
  const tank = rec({ x: 100, y: 5, z: 100, yaw: 0.5, vx: 1, vz: 2, model: 9, flags: C.F_EXT, turret: -2.5, barrel: 0.3 });
  const o1 = P.writeRecord(dv, 0, 77, x0, z0, tank, C.REC_ALL, null);
  assert.equal(o1, 25 + C.REC_EXT);
  const r = P.readRecord(dv, 0, x0, z0, {});
  assert.equal(r.size, 28); near(r.turret, -2.5, 1e-3, 'turret'); near(r.barrel, 0.3, 0.006, 'barrel'); assert.ok(r.parts & C.REC_TURRET);
  assert.equal(P.writeRecord(dv, 0, 77, x0, z0, tank, 0, null), C.REC_SIZE + C.REC_EXT, 'turret even on motion-only updates');
  assert.equal(P.writeRecord(dv, 0, 77, x0, z0, rec({ ...tank, flags: 0 }), C.REC_ALL | C.REC_TURRET, null), 25, 'no turret without F_EXT');
  assert.equal(P.readRecord(dv, 0, x0, z0, {}).size, 25);
  const sb = new DataView(new ArrayBuffer(C.STATE_EXT_SIZE));
  P.writeState(sb, { seq: 1, t: 5, x: 1, y: 2, z: 3, yaw: 0, pitch: 0, roll: 0, vx: 0, vy: 0, vz: 0, yawRate: 0, steer: 0, model: 3, flags: 0, health: 1, turret: 1.25, barrel: -0.1 });
  const st = {};
  assert.equal(P.readState(sb, st), true); assert.equal(st.ext, true); near(st.turret, 1.25, 1e-3, 'state turret'); near(st.barrel, -0.1, 0.006, 'state barrel');
  assert.equal(P.readState(new DataView(new ArrayBuffer(40)), {}), false, 'only 38 or 41 bytes');
  // fire, fx, damage, hit
  const f = P.decodeFire(new DataView(P.encodeFire({ weapon: 1, seq: 9, t: 123456789, x: 10.5, y: 2.25, z: -30, yaw: 2, pitch: 0.12, clear: 340 })));
  assert.equal(f.weapon, 1); assert.equal(f.seq, 9); assert.equal(f.t, 123456789); near(f.x, 10.5, 0.01, 'fx'); near(f.yaw, 2, 1e-3, 'fyaw'); near(f.pitch, 0.12, 1e-3, 'fpitch'); assert.equal(f.clear, 340);
  assert.equal(P.decodeFire(new DataView(new ArrayBuffer(27))), null);
  const fx = new DataView(new ArrayBuffer(P.FX_SIZE));
  P.writeFx(fx, 0, C.FX.BOOM, 5, 0x123456, 1.8e12 + 0.25, 1, 2, 3, 0.5, -0.2, 1);
  const rf = P.readFx(fx);
  assert.equal(rf.kind, C.FX.BOOM); assert.equal(rf.weapon, 1); assert.equal(rf.netId, 0x123456); assert.equal(rf.t, 1.8e12 + 0.25);
  const dmg = new DataView(new ArrayBuffer(P.DAMAGE_SIZE));
  P.writeDamage(dmg, 0, C.DMG.CRUSH, 3, 0x654321, 0.5, 4, 5, 6, 1, true);
  const rd = P.readDamage(dmg);
  assert.equal(rd.kind, C.DMG.CRUSH); assert.equal(rd.attacker, 0x654321); assert.equal(rd.amount, 0.5); assert.equal(rd.destroyed, true);
  const hit = new DataView(new ArrayBuffer(P.HIT_SIZE));
  P.writeHit(hit, 0, 8, 0x111, 0.34, false);
  assert.equal(hit.getUint8(1) & 15, C.FX.HIT); near(P.readHit(hit).damage, 0.34, 1e-6, 'hit');
  // services / outfit / list / nick
  const sv = P.decodeService(new DataView(P.encodeService(C.SERVICE.respray, 4, 12, 2, 0xff8800, 0)));
  assert.deepEqual({ ...sv }, { op: C.SERVICE.respray, reqId: 4, model: 12, opt: 2, item: 0, rgb: 0xff8800 });
  assert.deepEqual(P.decodeOutfit(new DataView(P.encodeOutfit([1, 2, 65000]))), [1, 2, 65000]);
  assert.equal(P.decodeOutfit(new DataView(new ArrayBuffer(3))), null);
  assert.deepEqual({ ...P.decodeList(new DataView(P.encodeList(1, 7, 99999))) }, { order: 1, reqId: 7, cursor: 99999 });
  const nr = P.decodeNickReq(new DataView(P.encodeNickReq(C.NICK_OP.CUSTOM, 3, 'Ace_Pilot')));
  assert.deepEqual({ ...nr }, { op: 2, reqId: 3, name: 'Ace_Pilot' });
  const evil = new Uint8Array(P.encodeNickReq(C.NICK_OP.CUSTOM, 3, 'Ace<b>'));
  assert.equal(P.decodeNickReq(new DataView(evil.buffer)), null, 'markup never decodes');
  const nk = P.decodeNick(new DataView(P.encodeNick(0, 3, 77, 600, 'Sixteen_Chars_16', 12345, 2, C.NICK_OP.CUSTOM)));
  assert.equal(nk.name, 'Sixteen_Chars_16'); assert.equal(nk.money, 12345); assert.equal(nk.cooldownS, 600); assert.equal(nk.rerolls, 2); assert.equal(nk.op, C.NICK_OP.CUSTOM);
  const lb = new DataView(new ArrayBuffer(P.LIST_HDR + 2 * P.LIST_ENTRY));
  let o = P.writeListHeader(lb, 2, 5, 123, 4000);
  o = P.writeListEntry(lb, o, { netId: 1, nickCode: 2, color: 3, vclass: 1, model: 4, visible: true, worth: 5e6, x: 1745, z: -640, onlineS: 99, name: 'Zed' });
  P.writeListEntry(lb, o, { netId: 9, nickCode: 8, color: 7, vclass: 0, model: 0, visible: false, worth: 0, x: -9000, z: 9000, onlineS: 1, name: '' });
  const page = P.decodeListPage(lb);
  assert.equal(page.next, 123); assert.equal(page.online, 4000); assert.equal(page.players.length, 2);
  assert.equal(page.players[0].name, 'Zed'); assert.equal(page.players[0].x, 1750); assert.equal(page.players[1].visible, false);
});

test('global, radar, info, hello, info request', () => {
  const dv = new DataView(new ArrayBuffer(512));
  const n = P.encodeGlobal({ online: 100000, total: 2e6, serverTime: 1.8e12, tick: 9, hour: 17.5, timeScale: 1 / 120, weatherIndex: 5, prevIndex: 4, transition: 0.25, transitionS: 90, top: Array.from({ length: 12 }, (_, i) => ({ netId: i, nickCode: i * 3, color: i, money: 1e6 - i })) }, dv);
  assert.equal(n, P.GLOBAL_HDR + 10 * P.TOP_SIZE, 'top is capped at 10');
  const g = P.decodeGlobal(new DataView(dv.buffer, 0, n));
  assert.equal(g.online, 100000); assert.equal(g.top.length, 10); assert.equal(g.top[9].money, 1e6 - 9); near(g.hour, 17.5, 1e-5, 'hour');
  const n2 = P.encodeGlobal({ online: 1, total: 1, serverTime: 0, tick: 0, hour: 0, timeScale: 0, weatherIndex: 0, prevIndex: 0, transition: 0, transitionS: 0, top: [{ netId: 1, nickCode: 2, color: 3, money: 4, name: 'Custom_Name16chr' }] }, dv);
  assert.equal(P.decodeGlobal(new DataView(dv.buffer, 0, n2)).top[0].name, 'Custom_Name16chr');
  const rv = new DataView(new ArrayBuffer(64));
  const rc = P.radarOf(1745, -640);
  P.writeRadarHeader(rv, 0, rc, 5, 1, 300);
  assert.equal(P.RADAR_ENTRY, 10);
  // 40 m/s forward along yaw 1.0 (forward = -sin, -cos)
  const fvx = -Math.sin(1.0) * 40, fvz = -Math.cos(1.0) * 40;
  assert.equal(P.writeRadarEntry(rv, P.RADAR_HDR, P.radarWinX0(rc), P.radarWinZ0(rc), 1745, -640, 7, 1.0, 4, 0xabcdef, fvx, fvz), P.RADAR_HDR + 10);
  const e = P.readRadarEntry(rv, P.RADAR_HDR, P.radarWinX0(rc), P.radarWinZ0(rc), {});
  near(e.x, 1745, 0.05, 'radar x'); near(e.z, -640, 0.05, 'radar z'); near(e.yaw, 1.0, 0.03, 'radar yaw'); assert.equal(e.vclass, 4); assert.equal(e.color, 7);
  assert.equal(e.id, 0xabcdef); near(e.vx, fvx, 1.6, 'radar vx'); near(e.vz, fvz, 1.6, 'radar vz');
  // reversing at 10 m/s keeps its sign
  P.writeRadarEntry(rv, P.RADAR_HDR, P.radarWinX0(rc), P.radarWinZ0(rc), 1745, -640, 7, 1.0, 4, 1, -fvx / 4, -fvz / 4);
  const back4 = P.readRadarEntry(rv, P.RADAR_HDR, P.radarWinX0(rc), P.radarWinZ0(rc), {});
  near(back4.vx, -fvx / 4, 1.3, 'reverse vx'); near(back4.vz, -fvz / 4, 1.3, 'reverse vz');
  const iv = new DataView(new ArrayBuffer(P.INFO_MAX + 2));
  const info = { netId: 0x20001, nickCode: 1234, color: 3, infoVer: 7, vclass: 2, neon: 4, paint: 0xabcdef, finish: 2, tint: true, horn: 3, model: 17, armor: true, worth: 1234567, name: 'Night_Rider-9', outfit: [17, 300 * 16 + 3, 65535, 1, 2, 3, 4, 5, 6, 7, 8], wreck: null, damage: null, away: false };
  const end = P.writeInfo(iv, 2, info);
  const back = {};
  assert.equal(P.readInfo(iv, 2, back), end);
  assert.deepEqual(back, info);
  const plain = {};
  P.readInfo(iv, P.writeInfo(iv, 2, { netId: 1, nickCode: 2, color: 0, infoVer: 1, vclass: 0, neon: null, horn: null, name: '', outfit: [] }) * 0 + 2, plain);
  assert.equal(plain.neon, null); assert.equal(plain.horn, null); assert.equal(plain.name, ''); assert.deepEqual(plain.outfit, []);
  assert.equal(end - 2, P.INFO_FIXED + 1 + 'Night_Rider-9'.length + 1 + 2 * 11 + 1, 'an 11-item outfit costs 22 bytes, an empty trailer 1');
  // visual state trailer: wreck seed + age, damage bytes; unknown tags are skipped (forward compatible)
  const vis = { ...info, wreck: { seed: 0x7abcdef1, short: true, ageMs: 1200 }, damage: { ver: 9, data: Uint8Array.of(1, 2, 3, 250) } };
  const e2 = P.writeInfo(iv, 2, vis);
  const vb = {};
  assert.equal(P.readInfo(iv, 2, vb), e2);
  assert.deepEqual(vb.wreck, vis.wreck); assert.equal(vb.damage.ver, 9); assert.deepEqual([...vb.damage.data], [1, 2, 3, 250]);
  const big = new DataView(new ArrayBuffer(P.INFO_MAX + 2));
  const e3 = P.writeInfo(big, 2, { ...vis, damage: { ver: 1, data: new Uint8Array(C.VIS_MAX).fill(7) } });
  assert.ok(e3 <= P.INFO_MAX + 2, 'the largest record fits INFO_MAX');
  const u8 = new Uint8Array(big.buffer);
  const t0 = 2 + P.INFO_FIXED + 1 + 13 + 1 + 22; // the trailer's length byte (record at 2, 13-char name, 11 codes)
  u8[t0 + 1] = 99; // first tag (wreck) becomes unknown: skipped, the damage block still parses
  const skip = {};
  assert.equal(P.readInfo(big, 2, skip), e3);
  assert.equal(skip.wreck, null); assert.equal(skip.damage.data.length, C.VIS_MAX);
  const vm = P.decodeVis(new DataView(P.encodeVis(C.VIS.DAMAGE, Uint8Array.of(5, 6))));
  assert.equal(vm.kind, C.VIS.DAMAGE); assert.deepEqual([...vm.data], [5, 6]);
  assert.equal(P.decodeVis(new DataView(new ArrayBuffer(3 + C.VIS_MAX + 1))), null, 'oversize');
  const h = P.decodeHello(new DataView(P.encodeHello(new Uint8Array(32).fill(9), C.HF_TOKEN | C.HF_RESUME, 3, 754)));
  assert.equal(h.proto, C.PROTO_VERSION); assert.equal(h.flags, 3); assert.equal(h.token[31], 9); assert.equal(h.build, 3); assert.equal(h.offlineS, 754);
  assert.equal(C.PROTO_VERSION, 5);
  const qm = P.decodeQueue(new DataView(P.encodeQueue(12345, 20000, 754, 1000)));
  assert.deepEqual(qm, { position: 12345, waiting: 20000, etaSec: 754, capacity: 1000 });
  assert.equal(P.decodeQueue(new DataView(P.encodeQueue(1, 1, null, 1))).etaSec, null, "unknown ETA");
  assert.equal(new Uint8Array(P.encodeAdmit())[0], C.S_ADMIT);
  // cell header (8 bytes, 16-bit tick unwrapped against a recent full tick) and the 5 s pulse
  const ch = new DataView(new ArrayBuffer(P.CELL_HDR));
  assert.equal(P.writeCellHeader(ch, 0, 1, 4321, 0x2fffe, 17, 3), 8);
  assert.equal(ch.getUint8(0), C.S_CELL); assert.equal(ch.getUint8(6), 17); assert.equal(ch.getUint8(7), 3);
  assert.equal(P.unwrapTick(ch.getUint16(4, true), 0x2fff0), 0x2fffe);
  assert.equal(P.unwrapTick(ch.getUint16(4, true), 0x30005), 0x2fffe, 'unwraps backwards across the 16-bit boundary');
  assert.equal(P.unwrapTick(0x0003, 0x2fffe), 0x30003, 'and forwards');
  const pv = new DataView(new ArrayBuffer(P.PULSE_SIZE));
  P.writePulse(pv, 0, 70001, 123456, 7654321, 99999);
  assert.deepEqual(P.readPulse(pv), { boardVer: 70001 & 0xffff, online: 123456, total: 7654321, tick: 99999 });
  assert.equal(P.decodeHello(new DataView(new ArrayBuffer(39))), null);
  const ids = new Uint32Array(32);
  assert.equal(P.decodeInfoReq(new DataView(P.encodeInfoReq([1, 0xffffff, 77])), ids), 3);
  assert.equal(ids[1], 0xffffff);
  assert.equal(P.decodeInfoReq(new DataView(new ArrayBuffer(2 + 33 * 3)), ids), -1, 'max 32 ids');
  const bad = new DataView(new ArrayBuffer(5)); bad.setUint8(1, 2);
  assert.equal(P.decodeInfoReq(bad, ids), -1, 'length must match the count');
});

test('grid helpers cover the world and are inverse-consistent', () => {
  for (const [x, z] of [[C.WORLD.x0, C.WORLD.z0], [C.WORLD.x1 - 0.01, C.WORLD.z1 - 0.01], [1745, -640], [-1e9, 1e9]]) {
    const c = P.cellOf(x, z);
    assert.ok(c >= 0 && c < C.GRID_CELLS);
    const cx = Math.min(Math.max(x, C.WORLD.x0), C.WORLD.x1 - 0.01), cz = Math.min(Math.max(z, C.WORLD.z0), C.WORLD.z1 - 0.01);
    assert.ok(cx >= P.cellX0(c) && cx < P.cellX0(c) + C.CELL && cz >= P.cellZ0(c) && cz < P.cellZ0(c) + C.CELL);
  }
  assert.ok(C.GRID_CELLS < 65536, 'cell ids fit u16');
});

test('nicknames: codes are stable, valid and decode to clean names', () => {
  assert.equal(ADJECTIVES.length, 128); assert.equal(NOUNS.length, 128);
  assert.equal(nickName(nickCode(0, 1, 42)), 'NeonDrifter42');
  assert.equal(nickName(nickCode(1, 0)), 'SunsetGator');
  for (let i = 0; i < 2000; i++) {
    const c = randomNickCode();
    assert.ok(validNickCode(c));
    assert.match(nickName(c), /^[A-Za-z]+\d{0,2}$/);
  }
  assert.equal(validNickCode(-1), false); assert.equal(validNickCode(nickCode(0, 0, 100)), false);
});

test('world clock: deterministic, continuous hour, valid weather', () => {
  const a = { ...worldClock(Date.UTC(2026, 10, 3, 12)) }, b = { ...worldClock(Date.UTC(2026, 10, 3, 12)) };
  assert.deepEqual(a, b);
  const h1 = worldClock(1.8e12).hour, h2 = worldClock(1.8e12 + 1000).hour;
  near(((h2 - h1 + 24) % 24), 1 / 120, 1e-6, '1 real second = 1/120 h');
  for (let t = 0; t < 864e5; t += 3e5) { const w = worldClock(1.79e12 + t); assert.ok(w.weatherIndex >= 0 && w.transition >= 0 && w.transition <= 1); }
});
