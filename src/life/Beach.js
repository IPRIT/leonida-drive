import { Instancer } from './Instancer.js';
import { propMaterial } from './materials.js';
import { analyzeCoast } from './coast.js';
import { quality } from './util.js';
import {
  umbrellaGeo, loungerGeo, towerGeo, netGeo, hutGeo, kioskGeo, pierModuleGeo, pierRampGeo, pierEndGeo,
  yachtGeo, sailboatGeo, buoyGeo,
} from './geometry.js';

// Beach & coast props: umbrellas, loungers, art-deco lifeguard towers, volleyball nets, palm-frond huts, beach bars,
// wooden piers (drivable) and bobbing yachts / buoys in marinas. Everything instanced and distance-streamed.
export class Beach {
  constructor(game, root, colliders) {
    this.game = game;
    const plan = analyzeCoast(game);
    this.plan = plan;
    const q = (quality(game).vegRadius ?? 1) * (game.settings?.drawDist ?? 1);
    this.q = q;
    const mat = propMaterial();
    const bob = propMaterial({ bob: true });
    this.materials = [mat, bob];
    const mk = (geo, m, n, radius, o = {}) => new Instancer(root, geo, m, { capacity: Math.max(1, n), radius: radius * q, name: o.name, castShadow: !!o.shadow, refresh: o.refresh ?? 1.0, moveStep: o.moveStep ?? 25 });
    this.sets = {
      umbrellas: mk(umbrellaGeo(), mat, plan.umbrellas.length, 560, { shadow: true, name: 'life-umbrellas' }),
      loungers: mk(loungerGeo(), mat, plan.loungers.length, 340, { name: 'life-loungers' }),
      towers: mk(towerGeo(), mat, plan.towers.length, 1500, { shadow: true, name: 'life-towers', moveStep: 60 }),
      nets: mk(netGeo(), mat, plan.nets.length, 520, { name: 'life-nets' }),
      huts: mk(hutGeo(), mat, plan.huts.length, 950, { shadow: true, name: 'life-huts', moveStep: 40 }),
      kiosks: mk(kioskGeo(), mat, plan.kiosks.length, 1200, { shadow: true, name: 'life-kiosks', moveStep: 50 }),
      pierRamp: mk(pierRampGeo(), mat, plan.piers.length, 2400, { shadow: true, name: 'life-pier-ramp', moveStep: 80 }),
      pierMod: mk(pierModuleGeo(), mat, plan.piers.reduce((s, p) => s + p.N, 0), 2400, { shadow: true, name: 'life-pier', moveStep: 80 }),
      pierEnd: mk(pierEndGeo(), mat, plan.piers.length, 2400, { shadow: true, name: 'life-pier-end', moveStep: 80 }),
      yachts: mk(yachtGeo(), bob, plan.yachts.filter((y) => !y.sail).length, 1700, { shadow: true, name: 'life-yachts', moveStep: 60 }),
      sails: mk(sailboatGeo(), bob, plan.yachts.filter((y) => y.sail).length, 1900, { shadow: true, name: 'life-sailboats', moveStep: 60 }),
      buoys: mk(buoyGeo(), bob, plan.buoys.length, 800, { name: 'life-buoys' }),
    };
    const S = this.sets;
    for (const u of plan.umbrellas) S.umbrellas.add(u.x, u.y - 0.15, u.z, u.yaw, 1, 1, 1, u.color, null, 0, u.tilt);
    for (const l of plan.loungers) S.loungers.add(l.x, l.y - 0.05, l.z, l.yaw, 1, 1, 1, l.color);
    for (const t of plan.towers) {
      S.towers.add(t.x, t.y - 0.1, t.z, t.yaw, 1, 1, 1, t.color);
      colliders.box(t.x, t.y + 2.8, t.z, 1.8, 2.85, 1.95, t.yaw);
    }
    for (const n of plan.nets) S.nets.add(n.x, n.y - 0.05, n.z, n.yaw);
    for (const h of plan.huts) S.huts.add(h.x, h.y - 0.1, h.z, h.yaw);
    for (const k of plan.kiosks) {
      S.kiosks.add(k.x, k.y - 0.08, k.z, k.yaw, 1, 1, 1, k.color);
      colliders.box(k.x, k.y + 1.35, k.z, 2.05, 1.4, 1.55, k.yaw);
    }
    for (const p of plan.piers) this.addPier(p, colliders);
    for (const y of plan.yachts) {
      const s = y.scale;
      (y.sail ? S.sails : S.yachts).add(y.x, 0, y.z, y.yaw, s, s, s, y.color);
      if (y.sail) colliders.box(y.x, 0.6 * s, y.z, 1.5 * s, 1.6 * s, 5.4 * s, y.yaw);
      else colliders.box(y.x, 0.9 * s, y.z, 2.1 * s, 2.0 * s, 7.3 * s, y.yaw);
    }
    for (const b of plan.buoys) S.buoys.add(b.x, 0, b.z, 0, 1, 1, 1, b.color);
    for (const s of Object.values(S)) s.finalize();
    this.list = Object.values(S);
  }

  addPier(p, colliders) {
    const S = this.sets;
    const { x0, z0, dx, dz, Y, yaw, N } = p;
    const rx = dz, rz = -dx; // local +x in world
    const at = (d) => [x0 + dx * d, z0 + dz * d];
    let [x, z] = at(4);
    S.pierRamp.add(x, Y, z, yaw);
    colliders.box(x, Y - 0.85, z, 2.0, 0.1, 4.1, yaw, -0.197, 'ground');
    for (let i = 0; i < N; i++) {
      [x, z] = at(8 + 3 + i * 6);
      S.pierMod.add(x, Y, z, yaw);
    }
    const L = N * 6;
    [x, z] = at(8 + L / 2);
    colliders.box(x, Y - 0.1, z, 2.0, 0.1, L / 2, yaw, 0, 'ground');
    for (const s of [-1, 1]) colliders.box(x + rx * s * 1.95, Y + 0.55, z + rz * s * 1.95, 0.06, 0.55, L / 2, yaw);
    [x, z] = at(8 + L + 5);
    S.pierEnd.add(x, Y, z, yaw, 1, 1, 1, 0x9fe3d6);
    colliders.box(x, Y - 0.1, z, 7.0, 0.1, 5.0, yaw, 0, 'ground');
    for (const s of [-1, 1]) colliders.box(x + rx * s * 6.95, Y + 0.55, z + rz * s * 6.95, 0.06, 0.55, 5.0, yaw);
    colliders.box(x + dx * 4.95, Y + 0.55, z + dz * 4.95, 7.0, 0.55, 0.06, yaw);
    for (const s of [-1, 1]) colliders.box(x + rx * s * 4.6 - dx * 4.95, Y + 0.55, z + rz * s * 4.6 - dz * 4.95, 2.4, 0.55, 0.06, yaw);
    colliders.box(x - rx * 4.5 - dx * 2.5, Y + 1.3, z - rz * 4.5 - dz * 2.5, 1.6, 1.3, 1.3, yaw);
    p.end = { x, y: Y, z };
  }

  // stream visuals around the camera; at most two sets repack per frame (spreads the cost)
  update(cam, dt, force = false) {
    updateSets(this.list, cam, dt, force, 2);
  }
}

export function updateSets(list, cam, dt, force, maxRefresh = 2) {
  let budget = force ? 1e9 : maxRefresh;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (budget <= 0) { s._timer -= dt; continue; }
    if (s.update(cam.x, cam.z, dt, force)) budget--;
  }
}
