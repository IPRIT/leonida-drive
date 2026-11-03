// Cash pickups: spinning bill stacks with a glowing "$", dropped by knocked pedestrians and hidden near landmarks.
// Collected by walking or driving through them -> player.addMoney(n, pos) -> 'money:pickup'.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { groundY } from './util.js';

const RADIUS_FOOT = 2.5, RADIUS_CAR = 3.4;

function colored(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

function stackGeometry() {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const b = new THREE.BoxGeometry(0.34, 0.07, 0.16);
    b.rotateY((i - 1) * 0.18);
    b.translate((i - 1) * 0.02, 0.035 + i * 0.075, 0);
    parts.push(colored(b, i === 1 ? 0x3f9a4f : 0x4fb35f));
    const band = new THREE.BoxGeometry(0.07, 0.075, 0.165);
    band.rotateY((i - 1) * 0.18);
    band.translate((i - 1) * 0.02, 0.035 + i * 0.075, 0);
    parts.push(colored(band, 0xf2ecd0));
  }
  const g = mergeGeometries(parts);
  g.computeVertexNormals();
  return g;
}

function dollarGeometry() {
  // "S": upper arc counter-clockwise into the centre, lower arc clockwise out of it
  const pts = [];
  for (let i = 0; i <= 12; i++) { const a = Math.PI * (0.15 + (1.35 * i) / 12); pts.push(new THREE.Vector3(Math.cos(a) * 0.11, 0.105 + Math.sin(a) * 0.105, 0)); }
  for (let i = 1; i <= 12; i++) { const a = Math.PI * (0.5 - (1.35 * i) / 12); pts.push(new THREE.Vector3(Math.cos(a) * 0.11, -0.105 + Math.sin(a) * 0.105, 0)); }
  const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.035, 5, false);
  const bar = new THREE.CylinderGeometry(0.025, 0.025, 0.62, 5);
  tube.deleteAttribute('uv'); bar.deleteAttribute('uv');
  const g = mergeGeometries([tube.toNonIndexed(), bar.toNonIndexed()]);
  g.computeVertexNormals();
  return g;
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(160,255,170,0.9)');
  g.addColorStop(0.35, 'rgba(90,230,120,0.35)');
  g.addColorStop(1, 'rgba(60,200,90,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Cash {
  /**
   * @param {object} game
   * @param {{max?: number, hidden?: boolean}} [opts]
   */
  constructor(game, { max = 64, hidden = true } = {}) {
    this.game = game;
    this.max = max;
    this.list = [];
    this.time = 0;
    this.stack = new THREE.InstancedMesh(stackGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, flatShading: true, emissive: 0x1a5a24, emissiveIntensity: 0.6 }), max);
    this.sign = new THREE.InstancedMesh(dollarGeometry(), new THREE.MeshStandardMaterial({ color: 0x7dff8f, emissive: 0x3dff6a, emissiveIntensity: 2.2, roughness: 0.4, flatShading: true }), max);
    for (const m of [this.stack, this.sign]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      game.scene.add(m);
    }
    this.stack.castShadow = true;
    const gg = new THREE.BufferGeometry();
    this.glowPos = new Float32Array(max * 3);
    gg.setAttribute('position', new THREE.BufferAttribute(this.glowPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.glow = new THREE.Points(gg, new THREE.PointsMaterial({
      map: typeof document !== 'undefined' ? glowTexture() : null, size: 2.4, sizeAttenuation: true, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffffff,
    }));
    this.glow.frustumCulled = false;
    game.scene.add(this.glow);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3();
    this._e = new THREE.Euler();
    // hidden stashes near landmarks and district centres (seeded, once per session)
    this.spots = [];
    if (hidden) this._makeSpots();
    this.spotTimer = 0;
  }

  _makeSpots() {
    const w = this.game.worldData;
    if (!w) return;
    let s = 1234567;
    const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (const l of w.landmarks || []) {
      const a = r() * Math.PI * 2, d = 5 + r() * 8;
      this.spots.push({ x: l.x + Math.cos(a) * d, z: l.z + Math.sin(a) * d, amount: 250 + Math.round(r() * 15) * 50, taken: false, active: null });
    }
    for (const d of w.districts || []) {
      if (d.type !== 'd') continue;
      const a = r() * Math.PI * 2, dist = d.r * (0.2 + r() * 0.5);
      this.spots.push({ x: d.x + Math.cos(a) * dist, z: d.z + Math.sin(a) * dist, amount: 100 + Math.round(r() * 8) * 50, taken: false, active: null });
    }
  }

  /**
   * Drop money at a world position. Splits into 1..3 stacks that hop outwards and land on the ground.
   * @returns {object[]} pickups
   */
  drop(x, y, z, amount, { scatter = true, expire = 60, hidden = false, reason = 'pickup' } = {}) {
    amount = Math.max(1, Math.round(amount));
    const n = scatter ? Math.min(3, Math.max(1, Math.round(amount / 40))) : 1;
    const out = [];
    let left = amount;
    for (let i = 0; i < n; i++) {
      const a = i === n - 1 ? left : Math.max(1, Math.round(amount / n));
      left -= a;
      if (this.list.length >= this.max) this._remove(this.list[0]);
      const ang = Math.random() * Math.PI * 2, sp = scatter ? 1.2 + Math.random() * 1.6 : 0;
      const p = {
        x, y: y + (scatter ? 0.9 : 0.05), z, vx: Math.cos(ang) * sp, vy: scatter ? 3 + Math.random() * 1.5 : 0, vz: Math.sin(ang) * sp,
        gy: null, amount: a, age: 0, expire: hidden ? Infinity : expire, phase: Math.random() * 6.28, landed: !scatter, hidden, reason,
      };
      if (!scatter) p.gy = y;
      this.list.push(p);
      out.push(p);
    }
    return out;
  }

  _remove(p) {
    const i = this.list.indexOf(p);
    if (i >= 0) this.list.splice(i, 1);
    if (p.spot) p.spot.active = null;
  }

  clear() { while (this.list.length) this._remove(this.list[0]); }

  update(dt, game) {
    this.time += dt;
    const pl = game.player;
    const f = pl?.focus;
    // hidden stashes appear when the player gets close
    this.spotTimer -= dt;
    // stashes are a sandbox/offline bonus: the economy (game.economy / server) owns collectibles
    if (f && this.spotTimer <= 0 && !game.economy && !game.net && !game.online) {
      this.spotTimer = 1;
      for (const s of this.spots) {
        if (s.taken || s.active) continue;
        if (Math.abs(s.x - f.x) > 140 || Math.abs(s.z - f.z) > 140) continue;
        const gy = groundY(game, s.x, s.z) + 0.05;
        const [p] = this.drop(s.x, gy, s.z, s.amount, { scatter: false, hidden: true, reason: 'other' });
        p.spot = s;
        s.active = p;
      }
    }
    const inVeh = pl?.mode === 'vehicle';
    const R = inVeh ? RADIUS_CAR : RADIUS_FOOT;
    const m = this._m, q = this._q, pos = this._p, sc = this._s;
    let n = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.age += dt;
      if (!p.landed) {
        if (p.gy === null) p.gy = groundY(game, p.x + p.vx * 0.6, p.z + p.vz * 0.6, p.y) + 0.04;
        p.vy -= 9.81 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        if (p.y <= p.gy && p.vy < 0) { p.y = p.gy; p.landed = true; }
      }
      if (p.age > p.expire) { this._remove(p); continue; }
      // collect
      if (f && p.age > 0.5 && !(pl.wastedT > 0)) {
        const dx = p.x - f.x, dz = p.z - f.z, dy = p.y - f.y;
        if (dx * dx + dz * dz < R * R && Math.abs(dy) < 3) {
          pl.addMoney?.(p.amount, { x: p.x, y: p.y + 0.5, z: p.z }, p.reason);
          if (p.spot) p.spot.taken = true;
          this._remove(p);
          continue;
        }
      }
    }
    // render
    for (const p of this.list) {
      if (n >= this.max) break;
      const blink = p.expire - p.age < 5 ? (Math.sin(p.age * 18) > 0 ? 1 : 0.001) : 1;
      const big = p.hidden ? 1.35 : 1;
      const bob = Math.sin(this.time * 2.6 + p.phase) * 0.08;
      const spin = this.time * 2.2 + p.phase;
      const y = p.y + (p.landed ? 0.35 + bob : 0);
      const s = big * blink * Math.min(1, p.age * 4 + 0.2);
      q.setFromAxisAngle(pos.set(0, 1, 0), spin);
      m.compose(pos.set(p.x, y, p.z), q, sc.set(s * 1.6, s * 1.6, s * 1.6));
      this.stack.setMatrixAt(n, m);
      m.compose(pos.set(p.x, y + 0.75 * s, p.z), q, sc.set(s * 1.5, s * 1.5, s * 1.5));
      this.sign.setMatrixAt(n, m);
      this.glowPos[n * 3] = p.x; this.glowPos[n * 3 + 1] = y + 0.5; this.glowPos[n * 3 + 2] = p.z;
      n++;
    }
    this.stack.count = this.sign.count = n;
    this.stack.instanceMatrix.needsUpdate = this.sign.instanceMatrix.needsUpdate = true;
    this.glow.geometry.setDrawRange(0, n);
    this.glow.geometry.attributes.position.needsUpdate = true;
    this.glow.material.size = 2.2 + Math.sin(this.time * 4) * 0.3;
  }

  dispose() {
    for (const o of [this.stack, this.sign, this.glow]) { o.removeFromParent(); o.geometry.dispose(); o.material.dispose(); }
  }
}
