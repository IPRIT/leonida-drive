import * as THREE from 'three';
import { Instancer } from './Instancer.js';
import { ColliderField } from './colliders.js';
import { propMaterial } from './materials.js';
import { updateSets } from './Beach.js';
import { planStreets, STREET_TYPES, STREET_PHYS } from './streetPlan.js';
import {
  binGeo, benchGeo, hydrantGeo, shelterGeo, newsBoxGeo, mailboxGeo, meterGeo, planterPalmGeo, planterShrubGeo, rackGeo, cafeGeo,
} from './streetGeo.js';
import { quality } from './util.js';

const POOL = 20; // tumbling pieces alive at once
const LIFE_S = 20; // a knocked-over prop despawns after this, then respawns once the camera is far away
const RESPAWN_DIST = 90;
const GEO = { bin: binGeo, bench: benchGeo, hydrant: hydrantGeo, shelter: shelterGeo, news: newsBoxGeo, mail: mailboxGeo, meter: meterGeo, palm: planterPalmGeo, shrub: planterShrubGeo, rack: rackGeo, cafe: cafeGeo };
const RADIUS = { bin: 260, bench: 320, hydrant: 220, shelter: 650, news: 240, mail: 260, meter: 220, palm: 480, shrub: 380, rack: 240, cafe: 320 };
const SHADOW = { bench: true, shelter: true, palm: true, shrub: true, cafe: true };
const MATERIAL = { bin: 'plastic', hydrant: 'metal', news: 'metal', mail: 'metal', meter: 'metal', rack: 'metal', cafe: 'wood', bench: 'wood', palm: 'concrete', shrub: 'concrete', shelter: 'glass' };

// Street furniture along the raised sidewalks: bins, benches, hydrants, bus shelters, news boxes, mailboxes, parking
// meters, planters, bike racks and café sets. One InstancedMesh per type (11 draw calls), streamed by distance.
// Static colliders streamed around the player (80 m); light props are knocked over by any real hit (the car keeps
// 96–98 % of its speed), heavy ones break loose above a force threshold. Tumbling pieces: pooled dynamic bodies
// (max 20) drawn through the same instanced meshes; recycled after 20 s, the prop respawns when the camera is away.
export class StreetProps {
  constructor(game, root, beachGrid = null) {
    this.game = game;
    const plan = planStreets(game, { beachGrid });
    this.plan = plan;
    const q = (quality(game).vegRadius ?? 1) * (game.settings?.drawDist ?? 1);
    const mat = propMaterial();
    this.material = mat;
    this.field = new ColliderField(game, { radius: 80, budget: 16, interval: 0.15, maxDrop: 24 });
    this.sets = {};
    // flat per-prop arrays
    const total = STREET_TYPES.reduce((s, t) => s + plan.props[t].length, 0);
    this.n = total;
    this.type = new Uint8Array(total);
    this.inst = new Int32Array(total);
    this.col = new Int32Array(total);
    this.pos = new Float32Array(total * 4); // x, y, z, yaw
    this.color = new Float32Array(total * 3); // linear, for the tumbling copies
    const col = new THREE.Color();
    this.state = new Uint8Array(total); // 0 standing, 1 tumbling, 2 gone (waiting to respawn)
    let id = 0;
    STREET_TYPES.forEach((t, ti) => {
      const list = plan.props[t];
      const set = new Instancer(root, GEO[t](), mat, {
        capacity: Math.max(1, list.length), dynamic: POOL, radius: RADIUS[t] * q, castShadow: !!SHADOW[t], name: `life-street-${t}`,
        moveStep: 30, refresh: 1.2,
      });
      this.sets[t] = set;
      const ph = STREET_PHYS[t];
      for (const p of list) {
        this.type[id] = ti;
        this.inst[id] = set.add(p.x, p.y, p.z, p.yaw, 1, 1, 1, p.color);
        const tag = { prop: id };
        const ev = ph.light ? 900 : ph.thr * 0.6;
        if (ph.shape === 'cyl') this.col[id] = this.field.cyl(p.x, p.y + ph.h, p.z, ph.r, ph.h, 'static', { tag, ev });
        else this.col[id] = this.field.box(p.x, p.y + ph.hy, p.z, ph.hx, ph.hy, ph.hz, p.yaw, 0, 'static', { tag, ev });
        this.pos[id * 4] = p.x; this.pos[id * 4 + 1] = p.y; this.pos[id * 4 + 2] = p.z; this.pos[id * 4 + 3] = p.yaw;
        col.set(p.color); this.color[id * 3] = col.r; this.color[id * 3 + 1] = col.g; this.color[id * 3 + 2] = col.b;
        id++;
      }
      set.finalize();
    });
    this.list = Object.values(this.sets);
    // tumbling piece pool
    this.pieces = [];
    for (let i = 0; i < POOL; i++) this.pieces.push({ active: false, body: null, prop: -1, t: 0 });
    this.gone = []; // props waiting to respawn
    this._respawnT = 0;
    this._dynN = new Int32Array(STREET_TYPES.length);
    this.stats = { broken: 0 };
    this._off = game.events.on('contact', (c) => this.onContact(c));
  }

  get counts() { return this.plan.counts; }

  // every Rapier contact-force event (bootstrap drainEvents → 'contact'); runs before the damage system's postStep,
  // so damage.byHandle(...).pl still holds the pre-impact velocity
  onContact(c) {
    const a = c.c1?.userData?.prop, b = c.c2?.userData?.prop;
    if (a === undefined && b === undefined) return;
    const id = a !== undefined ? a : b;
    if (this.state[id] !== 0) return;
    const other = a !== undefined ? c.c2 : c.c1;
    const ob = other?.parent?.();
    if (!ob || ob.isFixed() || ob.isKinematic?.()) return;
    const ph = STREET_PHYS[STREET_TYPES[this.type[id]]];
    if (!ph.light && c.force < ph.thr) return;
    this.knock(id, ob, c.force);
  }

  // ob: the body that hit it (null for a blast); blast: launch velocity {x,y,z} of the piece
  knock(id, ob, force = 0, blast = null) {
    const g = this.game, { RAPIER, world } = g;
    const t = STREET_TYPES[this.type[id]], ph = STREET_PHYS[t];
    this.state[id] = 1;
    this.field.disable(this.col[id]);
    this.sets[t].setHidden(this.inst[id], true);
    this.stats.broken++;
    // keep the car going: restore the previous step's velocity (minus a little)
    const st = ob ? g.damage?.byHandle?.get?.(ob.handle) : null;
    let vx, vy, vz;
    if (!ob) { vx = blast?.x || 0; vy = blast?.y || 0; vz = blast?.z || 0; } else if (st?.hasPrev && st.pl) { vx = st.pl.x; vy = st.pl.y; vz = st.pl.z; } else { const v = ob.linvel(); vx = v.x; vy = v.y; vz = v.z; }
    if (st?.hasPrev && st.pl) {
      const keep = ph.light ? (ph.mass > 30 ? 0.96 : 0.985) : t === 'shelter' ? 0.8 : 0.88; // bins, benches, mailboxes barely slow the car
      ob.setLinvel({ x: vx * keep, y: vy * keep, z: vz * keep }, true);
      st.suppress = 2;
    }
    // a pooled dynamic body takes over the prop
    let slot = null, oldest = null;
    for (const p of this.pieces) { if (!p.active) { slot = p; break; } if (!oldest || p.t > oldest.t) oldest = p; }
    if (!slot) { this.recycle(oldest); slot = oldest; }
    const x = this.pos[id * 4], y = this.pos[id * 4 + 1], z = this.pos[id * 4 + 2], yaw = this.pos[id * 4 + 3];
    const hy = ph.shape === 'cyl' ? ph.h : ph.hy;
    if (RAPIER && world) {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y + hy + 0.02, z).setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
        .setLinearDamping(0.25).setAngularDamping(0.6).setCcdEnabled(true));
      const cd = ph.shape === 'cyl' ? RAPIER.ColliderDesc.cylinder(ph.h, ph.r) : RAPIER.ColliderDesc.cuboid(ph.hx, ph.hy, ph.hz);
      const vol = ph.shape === 'cyl' ? Math.PI * ph.r * ph.r * ph.h * 2 : ph.hx * ph.hy * ph.hz * 8;
      cd.setDensity(ph.mass / vol).setFriction(0.7).setRestitution(0.15);
      const G = g.groups?.GROUPS;
      // pieces bounce off the ground, buildings, props and people, never back into vehicles (no second slowdown)
      if (G) cd.setCollisionGroups(g.groups.groups(G.PROP, G.GROUND | G.STATIC | G.PROP | G.CHARACTER));
      world.createCollider(cd, body);
      const sp = Math.hypot(vx, vz) || 1, k = ob ? (ph.light ? 1.15 : 0.7) : 1;
      const up = ob ? (ph.light ? 2.2 + Math.min(4, sp * 0.12) : 1.2) : vy;
      body.setLinvel({ x: vx * k + (Math.random() - 0.5) * 2, y: up, z: vz * k + (Math.random() - 0.5) * 2 }, true);
      const spin = ph.light ? 6 : 2;
      body.setAngvel({ x: (Math.random() - 0.5) * spin + (vz / sp) * spin, y: (Math.random() - 0.5) * spin, z: (Math.random() - 0.5) * spin - (vx / sp) * spin }, true);
      slot.body = body;
    }
    slot.active = true; slot.prop = id; slot.t = 0;
    const pos = { x, y: y + hy, z };
    g.events.emit('impact', { position: pos, strength: ph.light ? 0.25 : 0.5, kind: 'prop', material: MATERIAL[t], source: ob });
    g.events.emit('prop:broken', { type: t, id, position: pos, force });
    const fx = g.fx;
    if (fx) {
      if (ph.water) {
        fx.splash?.({ x, y: y + 0.6, z }, 1.2);
        // the destruction module answers prop:broken with a real water jet; plain steam column otherwise
        if (!g.damage?.destruction?.jets) fx.smoke?.({ x, y: y + 0.4, z }, { color: 'steam', size: 0.9, rate: 22, duration: 9, velocity: { x: 0, y: 7, z: 0 } });
      }
      else if (!ph.light) fx.bits?.({ x, y: y + hy, z }, { material: t === 'bench' || t === 'cafe' ? 'wood' : 'concrete', count: 10, speed: 4 });
    }
  }

  /** Explosion: throw every standing prop in reach (radial launch, heavier props fly less far). */
  blast(pos, Pw, R) {
    const R2 = R * R;
    let n = 0;
    for (let id = 0; id < this.n && n < POOL; id++) {
      if (this.state[id] !== 0) continue;
      const dx = this.pos[id * 4] - pos.x, dz = this.pos[id * 4 + 2] - pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > R2) continue;
      const d = Math.sqrt(d2) || 0.5, f = Math.pow(1 - d / R, 1.2);
      const ph = STREET_PHYS[STREET_TYPES[this.type[id]]];
      const dv = 24 * Pw * f * Math.min(1.8, Math.sqrt(40 / ph.mass));
      if (dv < 2.5) continue;
      this.knock(id, null, 0, { x: (dx / d) * dv, y: 1.5 + dv * 0.5, z: (dz / d) * dv });
      n++;
    }
    return n;
  }

  recycle(p) {
    if (!p?.active) return;
    if (p.body) { try { this.game.world.removeRigidBody(p.body); } catch { /* already gone */ } }
    p.body = null;
    p.active = false;
    this.state[p.prop] = 2;
    this.gone.push(p.prop);
    p.prop = -1;
  }

  update(dt) {
    this.field.update(dt);
    // tumbling pieces → dynamic instance slots of their type
    const N = this._dynN;
    N.fill(0);
    for (let i = 0; i < POOL; i++) {
      const p = this.pieces[i];
      if (!p.active) continue;
      p.t += dt;
      if (p.t > LIFE_S || !p.body) { this.recycle(p); continue; }
      const ti = this.type[p.prop], set = this.sets[STREET_TYPES[ti]];
      const k = N[ti]++;
      writeBody(set.dynM, k, p.body, STREET_PHYS[STREET_TYPES[ti]]);
      const C = this.color, ci = p.prop * 3;
      set.dynC[k * 3] = C[ci]; set.dynC[k * 3 + 1] = C[ci + 1]; set.dynC[k * 3 + 2] = C[ci + 2];
    }
    for (let ti = 0; ti < STREET_TYPES.length; ti++) this.sets[STREET_TYPES[ti]].setDynamic(N[ti]);
    // respawn knocked-over props out of sight
    this._respawnT -= dt;
    if (this._respawnT <= 0 && this.gone.length) {
      this._respawnT = 1;
      const cam = this.game.camera.position, f = this.game.player?.focus || cam;
      for (let i = this.gone.length - 1; i >= 0; i--) {
        const id = this.gone[i], x = this.pos[id * 4], z = this.pos[id * 4 + 2];
        if (Math.hypot(x - cam.x, z - cam.z) < RESPAWN_DIST || Math.hypot(x - f.x, z - f.z) < RESPAWN_DIST) continue;
        this.state[id] = 0;
        this.field.enable(this.col[id]);
        this.sets[STREET_TYPES[this.type[id]]].setHidden(this.inst[id], false);
        this.gone[i] = this.gone[this.gone.length - 1];
        this.gone.pop();
      }
    }
  }

  visual(cam, dt, force) { updateSets(this.list, cam, dt, force, 2); }

  dispose() {
    this._off?.();
    for (const p of this.pieces) this.recycle(p);
    this.field.dispose();
  }
}

// instance matrix (column-major) from a Rapier body; the body origin is the collider centre, the mesh origin its base
function writeBody(M, k, body, ph) {
  const t = body.translation(), r = body.rotation();
  const x = r.x, y = r.y, z = r.z, w = r.w;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  const o = k * 16;
  M[o] = 1 - (yy + zz); M[o + 1] = xy + wz; M[o + 2] = xz - wy; M[o + 3] = 0;
  M[o + 4] = xy - wz; M[o + 5] = 1 - (xx + zz); M[o + 6] = yz + wx; M[o + 7] = 0;
  M[o + 8] = xz + wy; M[o + 9] = yz - wx; M[o + 10] = 1 - (xx + yy); M[o + 11] = 0;
  const hy = ph.shape === 'cyl' ? ph.h : ph.hy; // shift down by hy along the body's local up
  M[o + 12] = t.x - M[o + 4] * hy; M[o + 13] = t.y - M[o + 5] * hy; M[o + 14] = t.z - M[o + 6] * hy; M[o + 15] = 1;
}
