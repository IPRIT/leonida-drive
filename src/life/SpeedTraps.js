import * as THREE from 'three';
import { Instancer } from './Instancer.js';
import { propMaterial, glowMaterial } from './materials.js';
import { speedCamGeo, flashGeo } from './geometry.js';
import { tr, earn, granted, money, restore, persist, ecoProgress, hash2, PointGrid, LAND_KINDS } from './util.js';
import { speedTrapPay } from '../economy/rules.js';

const STORE = 'leonida.speedtraps';
const MIN_KMH = 120; // slower passes are not "speed trap" events
const C_IDLE = new THREE.Color(0x2a1010), C_FLASH = new THREE.Color(0xffffff);

// Speed cameras on straight highway sections. Crossing one at >= 120 km/h records the speed and pays through
// game.economy.speedTrap(id, kmh) ($100 + $6 x max(0, kmh - 150), x2 for a personal best, combo; docs/ECONOMY.md).
// Emits 'speedtrap' {id, speedKmh, best, record, reward, position}.
export class SpeedTraps {
  constructor(game, root, hud, colliders) {
    this.game = game;
    this.hud = hud;
    this.traps = place(game);
    this.best = restore(game, STORE, {}) || {};
    const merge = () => { for (const [id, v] of Object.entries(ecoProgress(game)?.traps || {})) if (v > (this.best[id] || 0)) this.best[id] = v; };
    merge();
    game.events.on('economy:change', (e) => { if (!e || e.reason === 'sync' || e.reason === 'load') merge(); });
    const n = Math.max(1, this.traps.length);
    const mat = propMaterial();
    const flashMat = glowMaterial({ day: 6, night: 6, key: 'flash' });
    this.materials = [mat, flashMat];
    this.poles = new Instancer(root, speedCamGeo(), mat, { capacity: n, radius: 1500, castShadow: true, name: 'life-speedcams', moveStep: 60 });
    for (const t of this.traps) {
      this.poles.add(t.px, t.py, t.pz, t.yaw);
      colliders.cyl(t.px, t.py + 3.1, t.pz, 0.2, 3.1);
    }
    this.poles.finalize();
    this.flash = new THREE.InstancedMesh(flashGeo(), flashMat, n);
    this.flash.name = 'life-speedcam-flash';
    this.flash.frustumCulled = false;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    this.traps.forEach((t, i) => {
      m.compose(p.set(t.px, t.py, t.pz), q.setFromAxisAngle(up, t.yaw), one);
      this.flash.setMatrixAt(i, m);
      this.flash.setColorAt(i, C_IDLE);
    });
    this.flash.count = this.traps.length;
    root.add(this.flash);
    this.flashT = new Float32Array(n);
    this.side = new Float32Array(n).fill(NaN);
    this.cool = new Float32Array(n);
  }

  update(dt, game) {
    const p = game.player;
    const v = p?.mode === 'vehicle' ? p.controllable : null;
    const f = p?.focus;
    let dirty = false;
    for (let i = 0; i < this.traps.length; i++) {
      if (this.flashT[i] > 0) {
        this.flashT[i] -= dt;
        this.flash.setColorAt(i, this.flashT[i] > 0 && (this.flashT[i] > 0.18 || this.flashT[i] < 0.08) ? C_FLASH : C_IDLE);
        dirty = true;
      }
      if (this.cool[i] > 0) this.cool[i] -= dt;
      const t = this.traps[i];
      if (!f) continue;
      const rx = f.x - t.x, rz = f.z - t.z;
      if (rx * rx + rz * rz > 90 * 90) { this.side[i] = NaN; continue; }
      const along = rx * t.tx + rz * t.tz;
      const prev = this.side[i];
      this.side[i] = along;
      if (!v || !LAND_KINDS.has(v.kind) || Number.isNaN(prev) || this.cool[i] > 0) continue;
      if ((prev < 0) === (along < 0)) continue;
      const lateral = Math.abs(rx * t.tz - rz * t.tx);
      if (lateral > t.w / 2 + 6) continue;
      this.trigger(i, Math.abs(v.telemetry?.speedKmh ?? 0));
      dirty = true;
    }
    if (dirty && this.flash.instanceColor) this.flash.instanceColor.needsUpdate = true;
  }

  trigger(i, kmh) {
    const g = this.game, t = this.traps[i];
    this.cool[i] = 10; // same per-trap cooldown as the economy
    if (kmh < MIN_KMH) return;
    this.flashT[i] = 0.35;
    const prev = this.best[t.id] || 0;
    const record = kmh > prev + 0.5;
    if (record) { this.best[t.id] = Math.round(kmh); if (!g.economy) persist(g, STORE, this.best); }
    const pos = { x: t.x, y: t.py, z: t.z }, eco = g.economy;
    const paid = eco?.speedTrap ? granted(g, eco.speedTrap(t.id, kmh, pos), pos, 'speedtrap')
      : earn(g, 'speedtrap', speedTrapPay(kmh, record), pos, { id: t.id, kmh: Math.round(kmh) });
    const mph = g.settings?.units === 'mph';
    const val = mph ? Math.round(kmh * 0.621371) : Math.round(kmh);
    const unit = mph ? tr(g, 'hud.mph', 'MPH') : tr(g, 'hud.kmh', 'KM/H');
    const bestV = this.best[t.id] ? (mph ? Math.round(this.best[t.id] * 0.621371) : this.best[t.id]) : null;
    const sub = record ? tr(g, 'life.trap.record', 'NEW RECORD') : bestV ? `${tr(g, 'life.trap.best', 'Best')} ${bestV} ${unit}` : '';
    this.hud.pop(tr(g, 'life.trap.title', 'SPEED TRAP'), `${val} ${unit}`, sub, paid ? `+${money(g, paid)}` : '', 2.6, record ? '#ff3fa4' : '#29f0e0');
    g.events.emit('speedtrap', { id: t.id, speedKmh: kmh, best: this.best[t.id] || 0, record, reward: paid, position: { x: t.x, y: t.py, z: t.z } });
  }

  updateVisual(cam, dt) { this.poles.update(cam.x, cam.z, dt); }

  blips(out = []) { for (const t of this.traps) out.push({ x: t.x, z: t.z, color: '#29f0e0', kind: 'speedtrap' }); return out; }
}

function place(game) {
  const { roads, terrain } = game;
  const out = [];
  const grid = new PointGrid(512);
  // prefer highways around Vice City (where players drive most), with some randomness
  const score = (e) => { const m = Math.floor(e.n / 2); return Math.hypot(e.pts[2 * m] + 600, e.pts[2 * m + 1] + 300) / 4000 + hash2(e.i, 3, 91); };
  // never on a runway / taxiway (highway-wide edges the landmarks draw as airfield pavement): a camera arm over the
  // VCIA runway was in the way of every take-off
  const hidden = game.landmarks?.hidden;
  const edges = roads.edges.filter((e) => e.kind === 1 && e.len > 260 && !e.runway && !e.airside && !hidden?.has(e.i))
    .map((e) => [score(e), e]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  for (const e of edges) {
    if (out.length >= 14) break;
    for (let s = 120; s < e.len - 120; s += 180) {
      const p = roads.pointAt(e, s);
      if (e.br && (e.br[p.k] || e.br[p.k + 1])) continue;
      if (grid.any(p.x, p.z, 1200)) continue;
      const a = roads.pointAt(e, s - 70), b = roads.pointAt(e, s + 70);
      if (a.tx * b.tx + a.tz * b.tz < 0.992) continue;
      // pole on the right-hand side, arm over the road (+x local = towards the road centre)
      const off = e.w / 2 + 2.6;
      const nx = p.tz, nz = -p.tx; // right of travel direction
      const px = p.x + nx * off, pz = p.z + nz * off;
      const h = terrain.heightAt(px, pz);
      if (h < 0.3 || Math.abs(h - p.y) > 3) continue;
      if (game.buildings?.query && game.buildings.query(px, pz, 12).length) continue;
      // local +x must point from the pole towards the road: yaw so that R(yaw)·(1,0,0) = (-nx, -nz)
      const yaw = Math.atan2(nz, -nx);
      out.push({ id: `trap_${Math.round(p.x)}_${Math.round(p.z)}`, x: p.x, z: p.z, tx: p.tx, tz: p.tz, w: e.w, px, py: h, pz, yaw });
      grid.add(p.x, p.z);
      break;
    }
  }
  return out;
}
