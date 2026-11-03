// game.services — what the shop's "Service" items do to vehicles (the economy owns prices, inventory and persistence):
// neon underglow (instanced emissive quads under the cars, no real lights), window tint, horn variant, respray and
// finish, armour plating (−30% vehicle damage until the next repair), fire extinguisher, nitro refill, insurance
// replacements at the nearest service point, and the garage gate for destroyed (wrecked) models.
//
// Vehicle hooks used — native methods win when A/E provide them (src/economy/INTEGRATION.md → "A and E"):
//   v.setWindowTint?(0..1), v.setColor(hex), v.setPaintFinish?(finish), v.hornType, v.refillBoost?(),
//   v.physics.boostLevel, v.damage.{applyImpact, repair, mats, burning}, game.damage.{repair, extinguish?, rebase?}
import * as THREE from 'three';
import * as R from './rules.js';
import { tr, fmt } from './Economy.js';

const MAX_GLOW = 16;
const _m = new THREE.Matrix4();
const _c = new THREE.Color();

// soft elliptic glow: a disc, bright in the middle, fading to black at the rim (additive → black adds nothing)
function glowGeometry(seg = 28) {
  const pos = [0, 0, 0], col = [1, 1, 1], idx = [];
  const rings = [[0.55, 0.8], [1, 0]];
  for (const [r, c] of rings) {
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
      col.push(c, c, c);
    }
  }
  for (let i = 0; i < seg; i++) {
    const a = 1 + i, b = 1 + ((i + 1) % seg);
    idx.push(0, b, a);
    const o = 1 + seg;
    idx.push(a, b, o + i, b, o + ((i + 1) % seg), o + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Update E's material snapshot so a repair restores the customised look (not the factory one). */
function rebase(game, v, m) {
  if (!m) return;
  if (game.damage?.rebase) { game.damage.rebase(v, m); return; }
  const s = v.damage?.mats?.get?.(m);
  if (!s) return;
  s.color = m.color.getHex();
  if (m.roughness !== undefined) s.roughness = m.roughness;
  if (m.metalness !== undefined) s.metalness = m.metalness;
}

export class VehicleServices {
  constructor(game) {
    this.game = game;
    this.order = 63;
    this.list = []; // { v, local: Matrix4, color, index }
    this.night = -1;
    this._ext = null; // pending auto-extinguish { v, t }
    this._replace = [];
    if (game.scene) {
      this.glowMat = new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
        side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      });
      this.glow = new THREE.InstancedMesh(glowGeometry(), this.glowMat, MAX_GLOW);
      this.glow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < MAX_GLOW; i++) this.glow.setColorAt(i, _c.setRGB(0, 0, 0));
      this.glow.count = 0;
      this.glow.frustumCulled = false;
      this.glow.renderOrder = 4;
      this.glow.name = 'economy-underglow';
      game.scene.add(this.glow);
    }
    const ev = game.events;
    this._off = [
      ev.on('vehicle:spawn', (e) => this.apply(e?.vehicle)),
      ev.on('vehicle:despawn', (e) => this._drop(e?.vehicle)),
      ev.on('vehicle:burning', (e) => this._onBurning(e?.vehicle)),
    ];
    for (const v of game.vehicles?.active || []) this.apply(v);
    this._wrapSpawn();
  }

  // ---------------------------------------------------------------- cosmetics / armour
  /** Apply the persisted customisation of an owned model to a vehicle instance (spawn, purchase, server sync). */
  apply(v) {
    const eco = this.game.economy;
    if (!v || !eco || v.fromTraffic) return;
    const c = eco.custom(v.catalogId);
    if (!c && !v.__eco) return;
    v.__eco = true;
    const own = eco.owned.has(v.catalogId);
    this.setNeon(v, own && c?.neonKit && c.neon != null ? R.NEON_COLORS[c.neon] : null);
    this.setTint(v, !!(own && c?.tint));
    if (own && c?.horn) v.hornType = c.horn;
    if (own && c?.paint != null) this.repaint(v, c.paint, c.finish || 'color');
    this.setArmor(v, !!(own && c?.armor) && !R.isArmoured(eco.priceClass(v.catalogId), v.kind));
  }

  /** Re-apply to every live vehicle (after a server sync of the customs). */
  refreshAll() { for (const v of this.game.vehicles?.active || []) this.apply(v); }

  setNeon(v, color) {
    let rec = this.list.find((r) => r.v === v);
    if (color == null) { if (rec) this._drop(v); return; }
    if (!this.glow) return;
    if (!rec) {
      if (this.list.length >= MAX_GLOW) return;
      const dims = v.dims || v.spec?.size || { length: 4.4, width: 1.8 };
      const r = v.spec?.wheelRadius ?? 0.33;
      const local = new THREE.Matrix4().makeScale((dims.width || 1.8) * 0.78, 1, (dims.length || 4.4) * 0.62);
      local.setPosition(0, -r + 0.05, 0);
      rec = { v, local, color: 0 };
      this.list.push(rec);
      this.glow.count = this.list.length;
    }
    rec.color = color;
    this.night = -1; // recolour on the next update
  }

  _drop(v) {
    const i = this.list.findIndex((r) => r.v === v);
    if (i < 0) return;
    this.list.splice(i, 1);
    if (this.glow) { this.glow.count = this.list.length; this.night = -1; }
  }

  setTint(v, on) {
    if (v.setWindowTint) { v.setWindowTint(on ? 1 : 0); return; }
    const m = v.materials?.glass;
    if (!m) return;
    const b = (m.userData.__ecoBase ||= { color: m.color.getHex(), roughness: m.roughness, metalness: m.metalness });
    if (on) { m.color.setHex(0x040506); m.roughness = 0.04; m.metalness = 0.85; } else if (m.userData.__ecoTint) {
      m.color.setHex(b.color); m.roughness = b.roughness; m.metalness = b.metalness;
    }
    m.userData.__ecoTint = on;
    rebase(this.game, v, m);
  }

  repaint(v, hex, finish = 'color') {
    if (hex != null) { if (v.setColor) v.setColor(hex); else v.materials?.paint?.color?.setHex(hex); }
    if (v.setPaintFinish) { v.setPaintFinish(finish); return; }
    const m = v.materials?.paint;
    if (!m) return;
    const b = (m.userData.__ecoBase ||= { roughness: m.roughness, metalness: m.metalness });
    if (finish === 'metallic') { m.metalness = 0.75; m.roughness = 0.3; } else if (finish === 'pearl') { m.metalness = 0.45; m.roughness = 0.16; } else { m.metalness = b.metalness; m.roughness = b.roughness; }
    rebase(this.game, v, m);
  }

  /** −30% vehicle damage until the next repair (E: `damage.damageScale` when supported, else a per-instance wrap). */
  setArmor(v, on) {
    const d = v?.damage;
    v.armored = !!on;
    if (!d) return false;
    if (d.supportsDamageScale) d.damageScale = on ? R.ARMOR.damageScale : 1;
    else if (on && !d.__ecoImpact) {
      const orig = d.applyImpact;
      d.__ecoImpact = orig;
      d.applyImpact = function (p, i, e, info) { return orig.call(this, p, i, e * R.ARMOR.damageScale, info); };
    } else if (!on && d.__ecoImpact) { d.applyImpact = d.__ecoImpact; delete d.__ecoImpact; }
    // any repair (body shop, menu, respawn) ends the plating
    if (on && !d.__ecoRepair) {
      const rep = d.repair, svc = this;
      d.__ecoRepair = rep;
      d.repair = function () { rep.call(this); svc.setArmor(v, false); svc.game.economy?._armorGone?.(v.catalogId); };
    } else if (!on && d.__ecoRepair) { d.repair = d.__ecoRepair; delete d.__ecoRepair; }
    return true;
  }

  // ---------------------------------------------------------------- consumables
  nitroLevel(v) {
    if (!v) return null;
    if (typeof v.boostLevel === 'number') return v.boostLevel;
    const p = v.physics;
    return p && typeof p.boostLevel === 'number' && p.spec?.boost ? p.boostLevel : null;
  }

  refillNitro(v) {
    if (!v) return false;
    if (v.refillBoost) { v.refillBoost(); return true; }
    const p = v.physics;
    if (!p || typeof p.boostLevel !== 'number') return false;
    p.boostLevel = 1;
    p.boostCooldown = 0;
    return true;
  }

  /** Put out a burning vehicle (E: damage.extinguish when available). → true when it was burning. */
  extinguish(v) {
    const g = this.game, d = v?.damage;
    if (!d || !d.burning) return false;
    if (g.damage?.extinguish) { if (g.damage.extinguish(v) === false) return false; } else if (d.extinguish) d.extinguish();
    else {
      d.state = 'ok';
      d.burnT = 0;
      d.fuse = 0;
      d.upsideT = 0;
      d.engine = Math.max(d.engine, 0.3); // smoking but drivable; below 0.15 it would re-ignite
      d._killFx?.();
      const paint = v.materials?.paint, base = d.mats?.get?.(paint);
      if (paint?.emissive && base?.emissive != null) paint.emissive.setHex(base.emissive);
    }
    const p = v.object3d?.position;
    if (p && g.fx?.smoke) {
      const h = g.fx.smoke({ x: p.x, y: p.y + 1, z: p.z }, { color: 'light', size: 1.4 });
      setTimeout(() => h?.stop?.(1.5), 900);
    }
    g.events.emit('vehicle:extinguished', { vehicle: v });
    return true;
  }

  _onBurning(v) {
    const g = this.game, eco = g.economy;
    if (!v || v !== g.player?.controllable || !eco || !(eco.inventory.extinguisher > 0)) return;
    if (g.settings?.autoExtinguish === false) return;
    this._ext = { v, t: 0.8 }; // let the flames show for a moment
  }

  // ---------------------------------------------------------------- insurance / wrecked models
  /** Insured replacement: a fresh copy of the model parked at the service point (body shop) nearest to the player. */
  deliverReplacement(id) { this._replace.push({ id, t: 2.5 }); }

  _deliver(id) {
    const g = this.game;
    const f = g.player?.focus || { x: 0, z: 0 };
    const shops = g.jobs?.shops || [];
    let best = null, bd = Infinity;
    for (const s of shops) { const d = Math.hypot(s.x - f.x, s.z - f.z); if (d < bd) { bd = d; best = s; } }
    const name = g.vehicles?.byId?.get?.(id)?.name || id;
    let where = '';
    if (best && g.vehicles?.spawn) {
      const yaw = best.yaw ?? 0;
      const x = best.x + Math.cos(yaw) * 7, z = best.z - Math.sin(yaw) * 7; // beside the ring
      const c = g.economy?.custom(id);
      g.vehicles.spawn(id, { x, y: Math.max(best.y, g.terrain?.heightAt?.(x, z) ?? 0) + 0.4, z }, yaw, c?.paint != null ? { color: c.paint } : {});
      where = best.name;
      if (!g.player?.waypoint) g.player?.setWaypoint?.({ x, z });
    }
    const text = tr(g, 'eco.insured', 'Insurance: a new {name} is waiting at {place}', { name, place: where || tr(g, 'eco.garage', 'the garage') });
    if (g.ui?.feed) g.ui.feed({ kind: 'garage', icon: 'shield', text, seconds: 7 }); else g.ui?.notify?.(text, 7);
  }

  // the garage call of a destroyed (uninsured) model charges the $1,000 claim; a respray colour is the default paint
  _wrapSpawn() {
    const g = this.game;
    if (!g.spawnForPlayer || g.spawnForPlayer.__eco) return;
    const orig = g.spawnForPlayer;
    const wrapped = (id, opts = {}) => {
      const eco = g.economy;
      if (eco?.isWrecked(id)) {
        const chk = eco.spawnCheck(id);
        if (!chk.ok) {
          g.ui?.toast?.(tr(g, 'eco.claimTitle', 'INSURANCE CLAIM'), tr(g, 'eco.claimFunds', 'Replacing it costs {amount}', { amount: fmt(g, chk.fee) }), 3);
          return null;
        }
        eco.buyService('claim', id);
        if (chk.fee > 0) g.ui?.hud?.moneyPop?.(-chk.fee);
      }
      const c = eco?.custom(id);
      if (opts.color === undefined && c?.paint != null && eco.owned.has(id)) opts = { ...opts, color: c.paint };
      return orig(id, opts);
    };
    wrapped.__eco = true;
    g.spawnForPlayer = wrapped;
  }

  // ---------------------------------------------------------------- per frame
  update(dt, game) {
    if (this._ext) {
      this._ext.t -= dt;
      if (this._ext.t <= 0) {
        const { v } = this._ext;
        this._ext = null;
        if (game.economy?.useExtinguisher(v)) {
          game.ui?.toast?.(tr(game, 'eco.extinguished', 'FIRE EXTINGUISHED'), tr(game, 'eco.extLeft', '{n} extinguisher(s) left', { n: game.economy.inventory.extinguisher }), 2.5);
        }
      }
    }
    if (this._replace.length) {
      for (let i = this._replace.length - 1; i >= 0; i--) {
        const r = this._replace[i];
        if ((game.player?.wastedT ?? 0) > 0) continue; // after the respawn
        r.t -= dt;
        if (r.t <= 0) { this._replace.splice(i, 1); this._deliver(r.id); }
      }
    }
    if (!this.glow || !this.list.length) return;
    // brighter at night; recolour only when it changes noticeably
    const night = Math.round((game.sky?.night ?? 0) * 10) / 10;
    if (night !== this.night) {
      this.night = night;
      const k = 0.45 + 0.6 * night;
      for (let i = 0; i < this.list.length; i++) this.glow.setColorAt(i, _c.setHex(this.list[i].color).multiplyScalar(k));
      this.glow.instanceColor.needsUpdate = true;
    }
    for (let i = 0; i < this.list.length; i++) {
      const r = this.list[i], v = r.v;
      const o = v.object3d;
      if (!o || v.destroyed || v.damage?.destroyed || (v.telemetry?.submerged ?? 0) > 0.4) _m.makeScale(0, 0, 0);
      else _m.multiplyMatrices(o.matrixWorld, r.local);
      this.glow.setMatrixAt(i, _m);
    }
    this.glow.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const off of this._off) off?.();
    if (this.glow) { this.game.scene.remove(this.glow); this.glow.geometry.dispose(); this.glowMat.dispose(); }
  }
}
