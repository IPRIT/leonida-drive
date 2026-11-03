import * as THREE from 'three';

// Instanced low-poly pedestrians walking on sidewalks of lit (urban) streets.
// Six instanced parts (torso, head, 2 legs, 2 arms) = 6 draw calls for the whole crowd.
const SHIRTS = [0xff4f9a, 0x2fd6d0, 0xffffff, 0xf5c84c, 0x6b8cff, 0xff8a3d, 0x8fe38a, 0xd94f4f, 0x222831, 0xb38cff, 0x67c3ff, 0xffd6e8];
const PANTS = [0x2b3445, 0x1d1f24, 0xe6dcc6, 0x3d5a80, 0x6b4f3a, 0xf2f2f2, 0x2f4f3f, 0x7a7a80];
const SKIN = [0xf1c9a5, 0xe0ac7e, 0xc68c5c, 0x8d5a3b, 0x5c3a24, 0xf6d7bf];
const HAIR = [0x1d1612, 0x3b2a1e, 0x6b4a2b, 0xd8b56a, 0x111111, 0x8a8a8a];
const PARTS = ['torso', 'head', 'legL', 'legR', 'armL', 'armR', 'hair'];

function partGeo(name) {
  let g;
  switch (name) {
    case 'torso': g = new THREE.CylinderGeometry(0.2, 0.16, 0.62, 6); g.translate(0, 0.31, 0); break; // origin at hips
    case 'head': g = new THREE.IcosahedronGeometry(0.13, 0); g.scale(0.95, 1.1, 1); break;
    case 'hair': g = new THREE.IcosahedronGeometry(0.135, 0); g.scale(1.0, 0.6, 1.05); g.translate(0, 0.06, 0.015); break;
    case 'legL': case 'legR': g = new THREE.BoxGeometry(0.13, 0.86, 0.15); g.translate(0, -0.43, 0); break; // origin at hip joint
    default: g = new THREE.BoxGeometry(0.09, 0.62, 0.1); g.translate(0, -0.31, 0); // arm, origin at shoulder
  }
  return g;
}

export class Pedestrians {
  constructor({ scene, roads, terrain, max = 160 }) {
    this.roads = roads;
    this.terrain = terrain;
    this.max = max;
    this.list = [];
    this.meshes = {};
    const mat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.85 });
    for (const p of PARTS) {
      const m = new THREE.InstancedMesh(partGeo(p), mat, max);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
      m.count = 0;
      m.castShadow = true;
      m.frustumCulled = false;
      scene.add(m);
      this.meshes[p] = m;
    }
    this.litEdges = roads.edges.filter((e) => e.lit && e.kind !== 1 && e.len > 20);
    this.spawnTimer = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this.positions = []; // for traffic avoidance
  }

  sidewalkPoint(e, s, side, out) {
    const L = e.len;
    const arc = Math.min(Math.max(s, 0), L);
    let k = 0;
    while (k < e.n - 2 && e.cum[k + 1] < arc) k++;
    const seg = e.cum[k + 1] - e.cum[k] || 1;
    const t = (arc - e.cum[k]) / seg;
    const ax = e.pts[2 * k], az = e.pts[2 * k + 1], bx = e.pts[2 * k + 2], bz = e.pts[2 * k + 3];
    const tx = (bx - ax) / seg, tz = (bz - az) / seg;
    const o = (e.w / 2 + 2.3) * side;
    out.x = ax + (bx - ax) * t - tz * o;
    out.z = az + (bz - az) * t + tx * o;
    out.y = Math.max(e.y[k] + (e.y[k + 1] - e.y[k]) * t + 0.05, this.terrain.heightAt(out.x, out.z));
    out.tx = tx; out.tz = tz;
    return out;
  }

  spawn(focus) {
    for (let t = 0; t < 6; t++) {
      const ang = Math.random() * Math.PI * 2, r = 40 + Math.random() * 200;
      const n = this.roads.nearest(focus.x + Math.cos(ang) * r, focus.z + Math.sin(ang) * r, 50, (e) => e.lit && e.kind !== 1);
      if (!n) continue;
      const e = n.edge;
      const s = e.cum[n.seg] + n.t * (e.cum[n.seg + 1] - e.cum[n.seg]);
      const p = {
        e, s, side: Math.random() < 0.5 ? -1 : 1, dir: Math.random() < 0.5 ? -1 : 1,
        speed: 1.05 + Math.random() * 0.6, phase: Math.random() * 6.28, x: 0, y: 0, z: 0, yaw: 0,
        state: 'walk', t: 0, vx: 0, vy: 0, vz: 0, rotX: 0, rotZ: 0, panic: 0, scale: 0.92 + Math.random() * 0.16,
        shirt: new THREE.Color(SHIRTS[(Math.random() * SHIRTS.length) | 0]),
        pants: new THREE.Color(PANTS[(Math.random() * PANTS.length) | 0]),
        skin: new THREE.Color(SKIN[(Math.random() * SKIN.length) | 0]),
        hair: new THREE.Color(HAIR[(Math.random() * HAIR.length) | 0]),
      };
      const q = this.sidewalkPoint(e, s, p.side, {});
      p.x = q.x; p.y = q.y; p.z = q.z;
      this.list.push(p);
      return;
    }
  }

  update(dt, focus, camera, player, night) {
    // population: denser in the city, fewer at night
    const want = Math.round(this.max * (1 - night * 0.45));
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.list.length < want) { this.spawnTimer = 0.03; this.spawn(focus); }
    const pp = player?.position, pv = player?.velocity;
    const pSpeed = pv ? Math.hypot(pv.x, pv.z) : 0;
    const tmp = {};
    this.positions.length = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      if (Math.hypot(p.x - focus.x, p.z - focus.z) > 300) { this.list.splice(i, 1); continue; }
      // react to the player's car
      if (pp && p.state !== 'down' && p.state !== 'fly') {
        const dx = p.x - pp.x, dz = p.z - pp.z;
        const d = Math.hypot(dx, dz);
        if (d < 2.2 && pSpeed > 3) {
          p.state = 'fly'; p.t = 0;
          p.vx = pv.x * 0.75 + (dx / (d || 1)) * 2; p.vz = pv.z * 0.75 + (dz / (d || 1)) * 2; p.vy = 3 + pSpeed * 0.18;
        } else if (d < 14 && pSpeed > 5 && p.state === 'walk') {
          const approach = -(dx * pv.x + dz * pv.z) / (d * pSpeed);
          if (approach > 0.7) {
            // dive sideways, away from the car's path
            const sx = -pv.z / pSpeed, sz = pv.x / pSpeed;
            const sgn = Math.sign(dx * sx + dz * sz) || 1;
            p.state = 'dive'; p.t = 0;
            p.vx = sx * sgn * 5.5; p.vz = sz * sgn * 5.5; p.vy = 2.6;
            p.panic = 6;
          }
        }
      }
      p.t += dt;
      if (p.state === 'walk') {
        const sp = p.speed * (p.panic > 0 ? 2.6 : 1);
        p.panic = Math.max(0, p.panic - dt);
        p.s += sp * dt * p.dir;
        if (p.s < 0 || p.s > p.e.len) this.nextEdge(p);
        const q = this.sidewalkPoint(p.e, p.s, p.side, tmp);
        // smooth towards the sidewalk point
        p.x += (q.x - p.x) * Math.min(1, dt * 6);
        p.z += (q.z - p.z) * Math.min(1, dt * 6);
        p.y = q.y;
        const ty = Math.atan2(-q.tx * p.dir, -q.tz * p.dir);
        p.yaw += wrap(ty - p.yaw) * Math.min(1, dt * 8);
        p.phase += dt * sp * 4.2;
        p.rotX = p.rotZ = 0;
      } else if (p.state === 'dive' || p.state === 'fly') {
        p.vy -= 9.81 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        if (p.state === 'fly') { p.rotX += dt * 9; p.rotZ += dt * 4; }
        else p.rotX = Math.min(1.35, p.rotX + dt * 6);
        const g = Math.max(this.terrain.heightAt(p.x, p.z), 0);
        if (p.y <= g && p.vy < 0) {
          p.y = g;
          if (p.state === 'dive') { p.state = 'down'; p.t = 0; p.rotX = 1.4; }
          else { p.state = 'down'; p.t = -2; p.rotX = Math.PI / 2; p.rotZ = 0; }
          p.vx = p.vy = p.vz = 0;
        }
      } else if (p.state === 'down') {
        if (p.t > 1.8) {
          p.rotX = Math.max(0, p.rotX - dt * 3);
          if (p.rotX === 0) {
            // back to the nearest sidewalk
            const n = this.roads.nearest(p.x, p.z, 60, (e) => e.lit && e.kind !== 1);
            if (n) {
              p.e = n.edge; p.s = n.edge.cum[n.seg] + n.t * (n.edge.cum[n.seg + 1] - n.edge.cum[n.seg]);
              const a = this.sidewalkPoint(p.e, p.s, 1, {}), b = this.sidewalkPoint(p.e, p.s, -1, {});
              p.side = Math.hypot(a.x - p.x, a.z - p.z) < Math.hypot(b.x - p.x, b.z - p.z) ? 1 : -1;
            }
            p.state = 'walk';
          }
        }
      }
      if (p.state === 'walk' || p.state === 'dive') this.positions.push(p);
    }
    this.render(camera);
  }

  nextEdge(p) {
    const atEnd = p.s > p.e.len;
    const ni = atEnd ? p.e.b : p.e.a;
    const opts = this.roads.adj[ni].map((ei) => this.roads.edges[ei]).filter((e) => e !== p.e && e.lit && e.kind !== 1);
    if (!opts.length) { p.dir = -p.dir; p.s = Math.min(Math.max(p.s, 0), p.e.len); p.side = -p.side; return; }
    const e = opts[(Math.random() * opts.length) | 0];
    const fromA = e.a === ni;
    const s = fromA ? 0.5 : e.len - 0.5;
    const a = this.sidewalkPoint(e, s, 1, {}), b = this.sidewalkPoint(e, s, -1, {});
    p.side = Math.hypot(a.x - p.x, a.z - p.z) < Math.hypot(b.x - p.x, b.z - p.z) ? 1 : -1;
    p.e = e; p.s = s; p.dir = fromA ? 1 : -1;
  }

  render() {
    const M = this.meshes, m = this._m, q = this._q, e = this._e, v = this._p, s = this._s;
    const base = new THREE.Matrix4(), local = new THREE.Matrix4();
    let i = 0;
    for (const p of this.list) {
      if (i >= this.max) break;
      const sc = p.scale;
      const walk = p.state === 'walk';
      const sw = walk ? Math.sin(p.phase) : 0;
      const bob = walk ? Math.abs(Math.cos(p.phase)) * 0.05 : 0;
      e.set(p.rotX, p.yaw, p.rotZ, 'YXZ');
      q.setFromEuler(e);
      base.compose(v.set(p.x, p.y + 0.94 * sc + bob - (p.state === 'down' ? 0.75 : 0), p.z), q, s.set(sc, sc, sc));
      const put = (name, x, y, z, rx, color) => {
        local.makeRotationX(rx).setPosition(x, y, z);
        m.multiplyMatrices(base, local);
        M[name].setMatrixAt(i, m);
        M[name].instanceColor.setXYZ(i, color.r, color.g, color.b);
      };
      put('torso', 0, 0, 0, 0, p.shirt);
      put('head', 0, 0.78, 0, 0, p.skin);
      put('hair', 0, 0.78, 0, 0, p.hair);
      put('legL', -0.09, 0.02, 0, sw * 0.55, p.pants);
      put('legR', 0.09, 0.02, 0, -sw * 0.55, p.pants);
      const armSwing = p.state === 'dive' ? -2.6 : sw * 0.6;
      put('armL', -0.26, 0.58, 0, -armSwing, p.shirt);
      put('armR', 0.26, 0.58, 0, p.state === 'dive' ? -2.6 : armSwing, p.shirt);
      i++;
    }
    for (const k of PARTS) {
      M[k].count = i;
      M[k].instanceMatrix.needsUpdate = true;
      M[k].instanceColor.needsUpdate = true;
    }
  }
}

function wrap(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
