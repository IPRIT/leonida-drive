import * as THREE from 'three';
import { GLOBAL_UNIFORMS } from '../core/globals.js';
import { birdGeo } from './geometry.js';
import { smooth, quality } from './util.js';

const U = GLOBAL_UNIFORMS;

// species: colour, size, cruise speed, flap frequency (rad/s), base glide share, altitude above ground/water
const SPECIES = {
  gull: { color: 0xf3f3ef, scale: 0.78, speed: 9.5, freq: 9.5, glide: 0.55, alt: [16, 34] },
  pelican: { color: 0xb3a28a, scale: 1.3, speed: 10.5, freq: 6.5, glide: 0.8, alt: [3.5, 7] },
  crow: { color: 0x1c1c21, scale: 0.55, speed: 8.0, freq: 15, glide: 0.18, alt: [10, 26] },
};

// Ambient life: seagull flocks over beaches, pelican lines over coastal water, crows inland (CPU boids-lite at
// 10 Hz + per-frame integration, wing flapping in the vertex shader) and GPU fireflies over wetlands at night.
export class Birds {
  constructor(game, root, coast) {
    this.game = game;
    this.coast = coast;
    const qn = quality(game).name || 'high';
    const k = qn === 'low' ? 0.5 : qn === 'medium' ? 0.75 : qn === 'ultra' ? 1.25 : 1;
    // flock slots (contiguous bird index ranges)
    const slots = [['gull', 12], ['gull', 10], ['pelican', 7], ['crow', 10], ['crow', 8]];
    this.flocks = [];
    let n = 0;
    for (const [kind, c] of slots) {
      const cnt = Math.max(3, Math.round(c * k));
      this.flocks.push({ kind, start: n, count: cnt, active: false, leaving: false, ax: 0, ay: 0, az: 0, dx: 1, dz: 0, t: 0, dir: 1, sp: SPECIES[kind] });
      n += cnt;
    }
    this.max = n;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.sep = new Float32Array(n * 3);
    this.bank = new Float32Array(n);
    this.rad = new Float32Array(n);
    this.ph = new Float32Array(n);
    for (let i = 0; i < n; i++) { this.ph[i] = Math.random() * 100; this.rad[i] = 18 + Math.random() * 40; }

    const geo = birdGeo();
    this.aBird = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aBird.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aBird', this.aBird);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide, roughness: 0.9 });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = U.uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float aWing; attribute float aSpan; attribute vec4 aBird; uniform float uTime;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          {
            float flap = sin(uTime * aBird.y + aBird.x);
            float ang = mix(flap * 0.8, 0.13 + 0.04 * sin(uTime * 1.3 + aBird.x), aBird.z) * (0.55 + 0.45 * aSpan);
            if (aWing != 0.0) {
              float a = aWing * ang, c = cos(a), s = sin(a);
              transformed.xy = vec2(c * transformed.x - s * transformed.y, s * transformed.x + c * transformed.y);
            }
          }`);
    };
    mat.customProgramCacheKey = () => 'life-bird';
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.name = 'life-birds';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    root.add(this.mesh);
    this.material = mat;
    this._col = new THREE.Color();
    this.spawnTimer = 0;
    this.sepTimer = 0;
    this.fireflies = new Fireflies(game, root, qn);
  }

  // place a flock somewhere around the viewer
  spawn(f, cx, cz) {
    const sp = f.sp;
    const terrain = this.game.terrain;
    let ax, az;
    if (f.kind === 'gull') {
      const b = this.coast?.beachGrid.sample(cx, cz, 140, 650);
      if (!b) return false;
      ax = b.x; az = b.z;
    } else if (f.kind === 'pelican') {
      const w = this.coast?.waterGrid.sample(cx, cz, 250, 650);
      if (!w) return false;
      ax = w.x; az = w.z;
      const a = Math.random() * Math.PI * 2;
      f.dx = Math.cos(a); f.dz = Math.sin(a);
    } else {
      const a = Math.random() * Math.PI * 2, r = 220 + Math.random() * 300;
      ax = cx + Math.cos(a) * r; az = cz + Math.sin(a) * r;
      const g = terrain.groundAt(ax, az), G = terrain.G;
      if (terrain.heightAt(ax, az) < 0.5 || g === G.water || g === G.sand) return false;
    }
    const ground = Math.max(0, terrain.heightAt(ax, az));
    f.ax = ax; f.az = az; f.ay = ground + sp.alt[0] + Math.random() * (sp.alt[1] - sp.alt[0]);
    f.active = true; f.leaving = false; f.t = 0; f.dir = Math.random() < 0.5 ? -1 : 1;
    for (let j = 0; j < f.count; j++) {
      const i = f.start + j, a = Math.random() * Math.PI * 2, r = 8 + Math.random() * 30;
      this.pos[i * 3] = ax + Math.cos(a) * r;
      this.pos[i * 3 + 1] = f.ay + (Math.random() - 0.5) * 6;
      this.pos[i * 3 + 2] = az + Math.sin(a) * r;
      const s = sp.speed;
      this.vel[i * 3] = -Math.sin(a) * s * f.dir; this.vel[i * 3 + 1] = 0; this.vel[i * 3 + 2] = Math.cos(a) * s * f.dir;
      this.rad[i] = (f.kind === 'gull' ? 16 : 22) + Math.random() * 38;
    }
    return true;
  }

  update(dt, game) {
    if (dt <= 0) return;
    const cam = game.camera.position;
    const night = U.uNight.value;
    const day = 1 - smooth(night, 0.25, 0.65);
    // ---- spawning / retiring (low rate)
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 1.4;
      const alt = cam.y - Math.max(0, game.terrain.heightAt(cam.x, cam.z));
      for (const f of this.flocks) {
        if (f.active) {
          const d = Math.hypot(f.ax - cam.x, f.az - cam.z);
          if (d > 900 || (f.leaving && d > 450)) f.active = false;
          else if (day < 0.3 || alt > 600) f.leaving = true;
        } else if (day > 0.5 && alt < 500 && Math.random() < 0.5) {
          this.spawn(f, cam.x, cam.z);
        }
      }
    }
    // ---- separation (10 Hz, O(n^2) inside each flock, n <= 15)
    this.sepTimer -= dt;
    if (this.sepTimer <= 0) {
      this.sepTimer = 0.1;
      const P = this.pos, S = this.sep;
      for (const f of this.flocks) {
        if (!f.active) continue;
        for (let a = f.start; a < f.start + f.count; a++) {
          let sx = 0, sy = 0, sz = 0;
          for (let b = f.start; b < f.start + f.count; b++) {
            if (a === b) continue;
            const dx = P[a * 3] - P[b * 3], dy = P[a * 3 + 1] - P[b * 3 + 1], dz = P[a * 3 + 2] - P[b * 3 + 2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > 49 || d2 < 1e-4) continue;
            const w = (49 - d2) / 49 / Math.sqrt(d2);
            sx += dx * w; sy += dy * w; sz += dz * w;
          }
          S[a * 3] = sx * 6; S[a * 3 + 1] = sy * 3; S[a * 3 + 2] = sz * 6;
        }
      }
    }
    // ---- integrate + write instances
    const P = this.pos, V = this.vel, S = this.sep, B = this.bank;
    const M = this.mesh.instanceMatrix.array, AB = this.aBird.array, IC = this.mesh.instanceColor.array;
    const t = game.time;
    let k = 0;
    for (const f of this.flocks) {
      if (!f.active) continue;
      f.t += dt;
      const sp = f.sp;
      if (f.kind === 'pelican') { f.ax += f.dx * sp.speed * dt; f.az += f.dz * sp.speed * dt; }
      else { f.ax += Math.sin(f.t * 0.05 + f.start) * 1.2 * dt; f.az += Math.cos(f.t * 0.043 + f.start) * 1.2 * dt; }
      this._col.set(sp.color);
      for (let j = 0; j < f.count; j++) {
        const i = f.start + j, i3 = i * 3, ph = this.ph[i];
        let tx, ty, tz;
        if (f.leaving) {
          tx = P[i3] + (P[i3] - cam.x); ty = P[i3 + 1] + 40; tz = P[i3 + 2] + (P[i3 + 2] - cam.z);
        } else if (f.kind === 'gull') {
          const R = this.rad[i], th = f.dir * (t * sp.speed / R) + ph;
          tx = f.ax + Math.cos(th) * R; tz = f.az + Math.sin(th) * R;
          ty = f.ay + Math.sin(t * 0.4 + ph) * 5;
        } else if (f.kind === 'pelican') {
          const row = Math.floor((j + 1) / 2), side = j === 0 ? 0 : j % 2 ? 1 : -1;
          tx = f.ax - f.dx * row * 4.2 - f.dz * side * row * 3.6;
          tz = f.az - f.dz * row * 4.2 + f.dx * side * row * 3.6;
          ty = f.ay + Math.sin(t * 0.7 + row) * 0.6;
        } else {
          tx = f.ax + Math.sin(t * 0.23 + ph) * 42 + Math.sin(t * 0.61 + ph * 2.1) * 12;
          tz = f.az + Math.cos(t * 0.19 + ph * 1.3) * 42 + Math.cos(t * 0.53 + ph) * 12;
          ty = f.ay + Math.sin(t * 0.5 + ph) * 5;
        }
        // steer towards the target at cruise speed (+ separation)
        let dx = tx - P[i3], dy = ty - P[i3 + 1], dz = tz - P[i3 + 2];
        const L = Math.hypot(dx, dy, dz) || 1;
        const want = sp.speed * Math.min(1.35, 0.55 + L / 25);
        dx = (dx / L) * want + S[i3]; dy = (dy / L) * want * 0.6 + S[i3 + 1]; dz = (dz / L) * want + S[i3 + 2];
        const kk = Math.min(1, dt * 1.6);
        const ovx = V[i3], ovz = V[i3 + 2];
        V[i3] += (dx - V[i3]) * kk; V[i3 + 1] += (dy - V[i3 + 1]) * kk; V[i3 + 2] += (dz - V[i3 + 2]) * kk;
        P[i3] += V[i3] * dt; P[i3 + 1] += V[i3 + 1] * dt; P[i3 + 2] += V[i3 + 2] * dt;
        // bank from the turn rate
        const turn = (ovx * V[i3 + 2] - ovz * V[i3]) / Math.max(1, ovx * ovx + ovz * ovz) / dt;
        B[i] += (Math.max(-0.9, Math.min(0.9, turn * 0.55)) - B[i]) * Math.min(1, dt * 3);
        writeMatrix(M, k, P[i3], P[i3 + 1], P[i3 + 2], V[i3], V[i3 + 1], V[i3 + 2], B[i], sp.scale);
        const glide = Math.max(0, Math.min(1, sp.glide + 0.45 * Math.sin(t * 0.35 + ph) - (V[i3 + 1] > 0.8 ? 0.6 : 0)));
        AB[k * 4] = ph; AB[k * 4 + 1] = sp.freq * (0.9 + (ph % 1) * 0.2); AB[k * 4 + 2] = glide; AB[k * 4 + 3] = 0;
        IC[k * 3] = this._col.r; IC[k * 3 + 1] = this._col.g; IC[k * 3 + 2] = this._col.b;
        k++;
      }
    }
    this.mesh.count = k;
    if (k) {
      const im = this.mesh.instanceMatrix; im.clearUpdateRanges(); im.addUpdateRange(0, k * 16); im.needsUpdate = true;
      this.aBird.clearUpdateRanges(); this.aBird.addUpdateRange(0, k * 4); this.aBird.needsUpdate = true;
      const ic = this.mesh.instanceColor; ic.clearUpdateRanges(); ic.addUpdateRange(0, k * 3); ic.needsUpdate = true;
    }
  }

  // camera-dependent (also called by photo mode while paused)
  visual(game) { this.fireflies.update(game); }

  get activeCount() { return this.mesh.count; }
}

// column-major instance matrix from position, velocity (forward = +z), bank angle and uniform scale
function writeMatrix(M, k, px, py, pz, vx, vy, vz, bank, s) {
  let L = Math.hypot(vx, vy, vz);
  if (L < 1e-3) { vx = 0; vy = 0; vz = 1; L = 1; }
  const fx = vx / L, fy = vy / L, fz = vz / L;
  // X = up x f
  let xx = fz, xy = 0, xz = -fx;
  const xl = Math.hypot(xx, xz) || 1;
  xx /= xl; xz /= xl;
  // Y = f x X
  let yx = fy * xz - fz * xy, yy = fz * xx - fx * xz, yz = fx * xy - fy * xx;
  const cb = Math.cos(bank), sb = Math.sin(bank);
  const Xx = xx * cb + yx * sb, Xy = xy * cb + yy * sb, Xz = xz * cb + yz * sb;
  yx = -xx * sb + yx * cb; yy = -xy * sb + yy * cb; yz = -xz * sb + yz * cb;
  const o = k * 16;
  M[o] = Xx * s; M[o + 1] = Xy * s; M[o + 2] = Xz * s; M[o + 3] = 0;
  M[o + 4] = yx * s; M[o + 5] = yy * s; M[o + 6] = yz * s; M[o + 7] = 0;
  M[o + 8] = fx * s; M[o + 9] = fy * s; M[o + 10] = fz * s; M[o + 11] = 0;
  M[o + 12] = px; M[o + 13] = py; M[o + 14] = pz; M[o + 15] = 1;
}

// GPU fireflies: points that wrap around the camera (world-stable), shown only above wetland / park / grass
// texels of the ground-class texture, only at night.
class Fireflies {
  constructor(game, root, qn) {
    const n = qn === 'low' ? 120 : 240;
    const R = 55;
    const pos = new Float32Array(n * 3), seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() * 2 - 1) * R * 3; // any value: wrapped in the shader
      pos[i * 3 + 1] = 0.3 + Math.random() * 2.2;
      pos[i * 3 + 2] = (Math.random() * 2 - 1) * R * 3;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    const T = game.terrain;
    this.uniforms = {
      uTime: U.uTime, uNight: U.uNight,
      uCam: { value: new THREE.Vector3() }, uR: { value: R }, uSize: { value: 300 },
      uHeight: { value: T.heightTex }, uGround: { value: T.groundTex },
      uOrigin: { value: new THREE.Vector2(T.x0, T.z0) }, uGridMax: { value: new THREE.Vector2(T.gw, T.gh) },
      uGroundMax: { value: new THREE.Vector2(T.tw - 1, T.th - 1) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute float aSeed;
        uniform float uTime, uNight, uR, uSize;
        uniform vec3 uCam;
        uniform highp sampler2D uHeight;
        uniform highp usampler2D uGround;
        uniform vec2 uOrigin, uGridMax, uGroundMax;
        varying float vA;
        void main() {
          vec2 rel = mod(position.xz - uCam.xz + uR, 2.0 * uR) - uR;
          vec2 wxz = uCam.xz + rel;
          uint c = texelFetch(uGround, clamp(ivec2(floor((wxz - uOrigin) / 4.0)), ivec2(0), ivec2(uGroundMax)), 0).r;
          float ok = c == 4u ? 1.0 : (c == 3u ? 0.6 : (c == 2u ? 0.3 : 0.0));
          float h = texelFetch(uHeight, clamp(ivec2(floor((wxz - uOrigin) / 8.0 + 0.5)), ivec2(0), ivec2(uGridMax)), 0).r;
          if (h < 0.05) ok = 0.0;
          float t = uTime * (0.25 + aSeed * 0.35);
          vec3 wp = vec3(wxz.x + sin(t + aSeed * 20.0) * 1.6, h + position.y + sin(t * 1.3 + aSeed * 7.0) * 0.5, wxz.y + cos(t * 0.9 + aSeed * 11.0) * 1.6);
          float blink = pow(max(0.0, sin(uTime * (0.9 + aSeed * 1.3) + aSeed * 40.0)), 3.0);
          float edge = 1.0 - smoothstep(uR * 0.65, uR, length(rel));
          vA = blink * ok * edge * smoothstep(0.35, 0.75, uNight);
          vec4 mv = viewMatrix * vec4(wp, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = vA > 0.002 ? clamp(uSize / max(1.0, -mv.z), 1.5, 24.0) : 0.0;
        }`,
      fragmentShader: /* glsl */`
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vec3(0.72, 1.0, 0.32) * 3.6 * vA * a * a, 1.0);
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.name = 'life-fireflies';
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    root.add(this.points);
    this.material = mat;
    this._v = new THREE.Vector2();
  }

  update(game) {
    const cam = game.camera;
    this.uniforms.uCam.value.copy(cam.position);
    const h = game.render?.height || game.renderer.getDrawingBufferSize(this._v).y;
    this.uniforms.uSize.value = 0.45 * h / (2 * Math.tan((cam.fov * Math.PI) / 360));
  }
}
