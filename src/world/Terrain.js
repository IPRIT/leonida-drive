import * as THREE from 'three';
import { GROUND_PALETTE } from './palette.js';
import { patchWeather } from './weatherPatch.js';
import { LAMP_MAP_UNIFORMS, LAMP_MAP_GLSL } from './LampLightMap.js';
import { ColliderStream } from './colliderStream.js';

// GPU-displaced, chunked terrain. One grid geometry per LOD drawn instanced per chunk;
// heights come from an R32F texture (exact texelFetch), ground classes from an R8UI texture.
const CHUNK = 512;
// Sky occlusion under decks (overpasses, elevated junctions). Everything in the shade of a deck is lit by the
// sky alone, and the sky light here is strong and blue (environment + hemisphere): the road and ground under a
// deck turned a saturated navy band that read as the road breaking off. Under a deck most of the sky is blocked:
// the indirect light is cut and desaturated to a dark neutral grey. Boxes come from Roads (setDeckCovers):
// A = centre xz + unit axis, B = half length, half width, underside height.
const MAX_COVERS = 32;
export const DECK_COVER_GLSL = `
  uniform vec4 uCovA[${MAX_COVERS}]; uniform vec4 uCovB[${MAX_COVERS}]; uniform float uCovN;
  float deckCover(vec3 p) {
    float c = 0.0;
    for (int i = 0; i < ${MAX_COVERS}; i++) {
      if (float(i) >= uCovN) break;
      vec4 A = uCovA[i], B = uCovB[i];
      vec2 r = p.xz - A.xy;
      float s = abs(dot(r, A.zw)), t = abs(dot(r, vec2(-A.w, A.z)));
      float inside = (1.0 - smoothstep(B.x - 8.0, B.x, s)) * (1.0 - smoothstep(B.y - 0.5, B.y + 2.0, t));
      c = max(c, inside * smoothstep(0.6, 2.0, B.z - p.y));
    }
    return c;
  }`;
// after <lights_fragment_end>: p = world position of the fragment
export const deckShadeChunk = (p) => `
  { float dc = deckCover(${p});
    if (dc > 0.0) {
      float l = dot(reflectedLight.indirectDiffuse, vec3(0.299, 0.587, 0.114));
      reflectedLight.indirectDiffuse = mix(reflectedLight.indirectDiffuse, vec3(l) * vec3(0.5, 0.49, 0.47), dc);
      reflectedLight.indirectSpecular *= 1.0 - 0.75 * dc;
    } }`;
const LODS = [8, 16, 32, 64]; // vertex spacing (m)
const SKIRT = 14;

export class Terrain {
  constructor(data, scene) {
    const w = data.world;
    this.x0 = w.bounds[0];
    this.z0 = w.bounds[1];
    this.x1 = w.bounds[2];
    this.z1 = w.bounds[3];
    this.hs = w.hs;
    this.gw = w.gw;
    this.gh = w.gh;
    this.ts = w.ts;
    this.tw = w.tw;
    this.th = w.th;
    this.G = w.ground;
    const n = (this.gw + 1) * (this.gh + 1);
    this.h = new Float32Array(n);
    for (let i = 0; i < n; i++) this.h[i] = data.heights[i] * 0.1;
    this.ground = data.groundTex;
    this.ncx = Math.ceil((this.x1 - this.x0) / CHUNK);
    this.ncz = Math.ceil((this.z1 - this.z0) / CHUNK);

    // per-chunk min/max for culling & skipping deep ocean
    const cpc = CHUNK / this.hs;
    this.chunkMin = new Float32Array(this.ncx * this.ncz);
    this.chunkMax = new Float32Array(this.ncx * this.ncz);
    for (let cz = 0; cz < this.ncz; cz++) {
      for (let cx = 0; cx < this.ncx; cx++) {
        let mn = 1e9, mx = -1e9;
        for (let j = 0; j <= cpc; j++) {
          const gz = Math.min(cz * cpc + j, this.gh);
          for (let i = 0; i <= cpc; i++) {
            const gx = Math.min(cx * cpc + i, this.gw);
            const v = this.h[gz * (this.gw + 1) + gx];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
        }
        this.chunkMin[cz * this.ncx + cx] = mn;
        this.chunkMax[cz * this.ncx + cx] = mx;
      }
    }

    this.heightTex = new THREE.DataTexture(this.h, this.gw + 1, this.gh + 1, THREE.RedFormat, THREE.FloatType);
    this.heightTex.internalFormat = 'R32F';
    this.heightTex.minFilter = this.heightTex.magFilter = THREE.NearestFilter;
    this.heightTex.generateMipmaps = false;
    this.heightTex.needsUpdate = true;

    this.groundTex = new THREE.DataTexture(this.ground, this.tw, this.th, THREE.RedIntegerFormat, THREE.UnsignedByteType);
    this.groundTex.internalFormat = 'R8UI';
    this.groundTex.minFilter = this.groundTex.magFilter = THREE.NearestFilter;
    this.groundTex.generateMipmaps = false;
    this.groundTex.needsUpdate = true;

    this.uniforms = {
      uHeight: { value: this.heightTex },
      uGround: { value: this.groundTex },
      uOrigin: { value: new THREE.Vector2(this.x0, this.z0) },
      uGridMax: { value: new THREE.Vector2(this.gw, this.gh) },
      uGroundMax: { value: new THREE.Vector2(this.tw - 1, this.th - 1) },
      uPal: { value: GROUND_PALETTE.map((c) => new THREE.Color(c)) },
      uTime: { value: 0 },
      uNight: { value: 0 },
      // tunnel mouths (Roads.findTunnels): oriented boxes just inside each portal where the drawn ground is cut
      // away, so the slope from the approach cut up to the earth cover never shows inside the tube. A: centre xz +
      // unit axis; B: half length, half width, floor height at the centre, floor grade along the axis.
      uHoleA: { value: Array.from({ length: 16 }, () => new THREE.Vector4()) },
      uHoleB: { value: Array.from({ length: 16 }, () => new THREE.Vector4()) },
      uHoleC: { value: Array.from({ length: 16 }, () => new THREE.Vector4()) },
      uHoleN: { value: 0 },
      // tree canopy share per 16 m cell (setCanopy, from the vegetation): beyond the individually drawn trees
      // (~1.7 km) the ground takes the forest colour, so hills and parks don't turn bald from the air
      uCanopy: { value: (() => { const t = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat); t.needsUpdate = true; return t; })() },
      uCanopyXf: { value: new THREE.Vector4(0, 0, 1, 1) },
    };
    // decks overhead (see DECK_COVER_GLSL); shared by the road, sidewalk and embankment materials
    this.coverUniforms = {
      uCovA: { value: Array.from({ length: MAX_COVERS }, () => new THREE.Vector4()) },
      uCovB: { value: Array.from({ length: MAX_COVERS }, () => new THREE.Vector4()) },
      uCovN: { value: 0 },
    };
    Object.assign(this.uniforms, this.coverUniforms);
    this.material = this.makeMaterial();
    this.meshes = LODS.map((spacing) => this.makeLodMesh(spacing));
    for (const m of this.meshes) scene.add(m);
    this.colliders = new Map();
    this._frustum = new THREE.Frustum();
    this._m = new THREE.Matrix4();
    this._box = new THREE.Box3();
  }

  // surface: the ground's look on an ordinary mesh in world coordinates (the road embankments / aprons beside the
  // asphalt, Roads.skirt): same palette, ground classes, noise, rock, wetness and weather, no height texture
  makeMaterial(surface = false) {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.93, metalness: 0.0, flatShading: true, side: surface ? THREE.DoubleSide : THREE.FrontSide });
    const u = this.uniforms;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u, LAMP_MAP_UNIFORMS);
      if (surface) {
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', `#include <common>
          varying vec3 vWorld;`)
          .replace('#include <begin_vertex>', `#include <begin_vertex>
          vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
      } else sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec2 aOffset;
          uniform highp sampler2D uHeight;
          uniform vec2 uOrigin;
          uniform vec2 uGridMax;
          varying vec3 vWorld;
          float hAt(ivec2 g){ g = clamp(g, ivec2(0), ivec2(uGridMax)); return texelFetch(uHeight, g, 0).r; }`)
        .replace('#include <begin_vertex>', `
          vec2 wxz = aOffset + position.xz;
          ivec2 gi = ivec2(floor((wxz - uOrigin) / 8.0 + 0.5));
          float hh = hAt(gi);
          hh -= position.y * ${SKIRT.toFixed(1)};
          vec3 transformed = vec3(wxz.x, hh, wxz.y);
          vWorld = transformed;`)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          ${LAMP_MAP_GLSL}
          uniform highp usampler2D uGround;
          uniform vec2 uOrigin;
          uniform vec2 uGroundMax;
          uniform vec3 uPal[12];
          uniform float uTime;
          uniform float uNight;
          uniform vec4 uHoleA[16];
          uniform vec4 uHoleB[16];
          uniform vec4 uHoleC[16];
          uniform float uHoleN;
          uniform sampler2D uCanopy;
          uniform vec4 uCanopyXf;
          ${DECK_COVER_GLSL}
          varying vec3 vWorld;
          float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
          float vnoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
            return mix(mix(hash12(i), hash12(i+vec2(1,0)), f.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), f.x), f.y); }
          vec3 classColor(uint c, vec2 p) {
            vec3 col = uPal[c];
            if (c == 5u) { // farm rows
              vec2 q = p * 0.18; float rows = step(0.5, fract(q.x + 0.3 * floor(q.y * 0.25)));
              col = mix(col, col * vec3(0.72, 0.8, 0.6), rows);
            } else if (c == 7u) { // urban: concrete slabs
              vec2 g = abs(fract(p / 4.0) - 0.5); col *= 0.94 + 0.06 * step(0.47, max(g.x, g.y));
            } else if (c == 8u) { // paved plazas / lots: large concrete slabs with soft wear (no painted stripes)
              vec2 g = abs(fract(p / 6.0) - 0.5);
              col *= (0.95 + 0.05 * step(0.48, max(g.x, g.y))) * (0.96 + 0.08 * vnoise(p * 0.07));
            }
            return col;
          }
          vec3 groundColor(vec3 wp) {
            // domain-warp the lookup so class borders become organic instead of 4 m stairs
            vec2 warp = vec2(vnoise(wp.xz * 0.21), vnoise(wp.zx * 0.21 + 17.0)) - 0.5;
            vec2 t = (wp.xz + warp * 3.2 - uOrigin) / 4.0 - 0.5;
            vec2 f = fract(t);
            ivec2 i0 = ivec2(floor(t));
            ivec2 mx = ivec2(uGroundMax);
            uint c00 = texelFetch(uGround, clamp(i0, ivec2(0), mx), 0).r;
            uint c10 = texelFetch(uGround, clamp(i0 + ivec2(1, 0), ivec2(0), mx), 0).r;
            uint c01 = texelFetch(uGround, clamp(i0 + ivec2(0, 1), ivec2(0), mx), 0).r;
            uint c11 = texelFetch(uGround, clamp(i0 + ivec2(1, 1), ivec2(0), mx), 0).r;
            // sharpen blend for a crisp low-poly look
            vec2 s = smoothstep(0.1, 0.9, f);
            vec3 a = mix(classColor(c00, wp.xz), classColor(c10, wp.xz), s.x);
            vec3 b = mix(classColor(c01, wp.xz), classColor(c11, wp.xz), s.x);
            return mix(a, b, s.y);
          }`)
        .replace('#include <color_fragment>', `
          for (int i = 0; i < 16; i++) {
            if (float(i) >= uHoleN) break;
            vec4 A = uHoleA[i], B = uHoleB[i], C = uHoleC[i];
            vec2 r = vWorld.xz - A.xy;
            float s = dot(r, A.zw);
            float yb = B.z + B.w * s;
            // C.x: the half width grows by C.x per metre towards -s (open cut between flared wing walls); C.y: band top
            float top = C.y > 0.0 ? C.y : 6.9;
            if (abs(s) < B.x && abs(dot(r, vec2(-A.w, A.z))) < B.y + C.x * (B.x - s) && vWorld.y > yb - 0.06 && vWorld.y < yb + top) discard;
          }
          vec3 gcol = groundColor(vWorld);
          float n1 = vnoise(vWorld.xz * 0.045);
          float n2 = vnoise(vWorld.xz * 0.31);
          gcol *= 0.86 + 0.2 * n1 + 0.08 * n2;
          // altitude tint: drier, olive greens up high
          float alt = clamp(vWorld.y / 300.0, 0.0, 1.0);
          gcol = mix(gcol, gcol * vec3(0.78, 0.8, 0.62), alt * 0.8);
          // shore: wet sand band and seabed
          float wet = 1.0 - smoothstep(0.05, 0.5, vWorld.y);
          gcol = mix(gcol, uPal[1] * vec3(0.78, 0.74, 0.62), wet * 0.85);
          if (vWorld.y < 0.0) gcol = mix(uPal[1] * 0.85, vec3(0.06, 0.16, 0.18), clamp(-vWorld.y / 14.0, 0.0, 1.0));
          // far forests: canopy colour where the trees are no longer drawn one by one
          float cf = smoothstep(1100.0, 1700.0, length(vWorld - cameraPosition));
          if (cf > 0.0) {
            float canopy = texture2D(uCanopy, (vWorld.xz - uCanopyXf.xy) * uCanopyXf.zw).r;
            vec3 leaf = vec3(0.085, 0.2, 0.06) * (0.8 + 0.35 * n1);
            gcol = mix(gcol, leaf, canopy * cf * 0.9);
          }
          diffuseColor.rgb = gcol;`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          ${deckShadeChunk('vWorld')}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          // steep slopes become rock
          vec3 wn = inverseTransformDirection(normal, viewMatrix);
          float rock = 1.0 - smoothstep(0.62, 0.8, wn.y);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32, 0.30, 0.27) * (0.85 + 0.3 * n2), rock * step(2.0, vWorld.y));`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += diffuseColor.rgb * lampMapLight(vWorld) * 2.4;`);
      patchWeather(sh, { worldPos: 'vWorld', porosity: 0.7 });
    };
    mat.customProgramCacheKey = () => (surface ? 'terrain-surface-v5' : 'terrain-v8');
    return mat;
  }

  surfaceMaterial() {
    if (!this._surfaceMat) this._surfaceMat = this.makeMaterial(true);
    return this._surfaceMat;
  }

  makeLodMesh(spacing) {
    const n = CHUNK / spacing; // cells per side
    const verts = [];
    const idx = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) verts.push(i * spacing, 0, j * spacing);
    const vi = (i, j) => j * (n + 1) + i;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = vi(i, j), b = vi(i + 1, j), c = vi(i, j + 1), d = vi(i + 1, j + 1);
        // same diagonal as Rapier heightfield: (x+,z-)-(x-,z+); CCW from above
        idx.push(a, c, b, b, c, d);
      }
    }
    // skirts around the border (y=1 flags a lowered vertex)
    const border = [];
    for (let i = 0; i < n; i++) border.push([i, 0]);
    for (let j = 0; j < n; j++) border.push([n, j]);
    for (let i = n; i > 0; i--) border.push([i, n]);
    for (let j = n; j > 0; j--) border.push([0, j]);
    const base = verts.length / 3;
    for (const [i, j] of border) verts.push(i * spacing, 1, j * spacing);
    const L = border.length;
    for (let k = 0; k < L; k++) {
      const [i0, j0] = border[k];
      const [i1, j1] = border[(k + 1) % L];
      const t0 = vi(i0, j0), t1 = vi(i1, j1), s0 = base + k, s1 = base + ((k + 1) % L);
      idx.push(t0, t1, s0, t1, s1, s0);
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    const maxInst = this.ncx * this.ncz;
    const off = new THREE.InstancedBufferAttribute(new Float32Array(maxInst * 2), 2);
    off.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aOffset', off);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.userData.spacing = spacing;
    return mesh;
  }

  /** Tree canopy share (Uint8, 0..255) on a w x h grid of `cell` m cells starting at the terrain origin. */
  setCanopy(data, w, h, cell) {
    const t = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
    t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    this.uniforms.uCanopy.value?.dispose();
    this.uniforms.uCanopy.value = t;
    this.uniforms.uCanopyXf.value.set(this.x0, this.z0, 1 / (w * cell), 1 / (h * cell));
  }

  // choose chunk LODs for this camera
  update(camera, dt) {
    this.uniforms.uTime.value += dt;
    const p = camera.position;
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._m);
    const alt = Math.max(0, p.y - this.heightAt(p.x, p.z));
    const altBoost = 1 + alt / 400;
    // LOD by the true distance to the chunk (altitude included) with a mild altitude bias: a cell stays ~3-6 px on
    // screen. (The old bias multiplied the ranges by 1 + alt/400: from 1.5 km the full-detail grid reached 5 km out,
    // 1.7 M terrain triangles drawn at ~1 px per cell.) At street level the ranges are unchanged.
    const lodBoost = 1 + alt / 2000;
    const counts = [0, 0, 0, 0];
    const arrs = this.meshes.map((m) => m.geometry.attributes.aOffset.array);
    const maxDist = Math.min(26000, 4200 * altBoost + 2000);
    for (let cz = 0; cz < this.ncz; cz++) {
      for (let cx = 0; cx < this.ncx; cx++) {
        const k = cz * this.ncx + cx;
        if (this.chunkMax[k] < -7) continue; // deep ocean: water covers it
        const ox = this.x0 + cx * CHUNK, oz = this.z0 + cz * CHUNK;
        this._box.min.set(ox, this.chunkMin[k] - SKIRT, oz);
        this._box.max.set(ox + CHUNK, this.chunkMax[k] + 1, oz + CHUNK);
        const dx = Math.max(ox - p.x, 0, p.x - ox - CHUNK);
        const dz = Math.max(oz - p.z, 0, p.z - oz - CHUNK);
        const dist = Math.hypot(dx, dz, alt * 0.5);
        if (dist > maxDist) continue;
        if (!this._frustum.intersectsBox(this._box)) continue;
        const d3 = Math.hypot(dx, dz, alt);
        let lod = d3 < 1100 * lodBoost ? 0 : d3 < 2600 * lodBoost ? 1 : d3 < 5200 * lodBoost ? 2 : 3;
        const a = arrs[lod];
        a[counts[lod] * 2] = ox;
        a[counts[lod] * 2 + 1] = oz;
        counts[lod]++;
      }
    }
    this.meshes.forEach((m, i) => {
      m.geometry.instanceCount = counts[i];
      const at = m.geometry.attributes.aOffset;
      at.clearUpdateRanges();
      at.addUpdateRange(0, counts[i] * 2);
      at.needsUpdate = true;
    });
    this.lastCounts = counts;
  }

  // cut the drawn ground away inside these oriented boxes (tunnel mouths): [{x, z, ux, uz, L, W, y, g}]
  // decks overhead: [{x, z, ux, uz, L (half length), W (half width), y (underside height)}]
  setDeckCovers(list) {
    const n = Math.min(MAX_COVERS, list.length);
    for (let i = 0; i < n; i++) {
      const c = list[i];
      this.coverUniforms.uCovA.value[i].set(c.x, c.z, c.ux, c.uz);
      this.coverUniforms.uCovB.value[i].set(c.L, c.W, c.y, 0);
    }
    this.coverUniforms.uCovN.value = n;
  }

  setHoles(list) {
    const n = Math.min(16, list.length);
    for (let i = 0; i < n; i++) {
      const h = list[i];
      this.uniforms.uHoleA.value[i].set(h.x, h.z, h.ux, h.uz);
      this.uniforms.uHoleB.value[i].set(h.L, h.W, h.y, h.g);
      this.uniforms.uHoleC.value[i].set(h.flare || 0, h.top || 0, 0, 0);
    }
    this.uniforms.uHoleN.value = n;
  }

  // exact height on the physics triangulation
  heightAt(x, z) {
    let fx = (x - this.x0) / this.hs;
    let fz = (z - this.z0) / this.hs;
    if (fx < 0) fx = 0; else if (fx > this.gw - 1e-4) fx = this.gw - 1e-4;
    if (fz < 0) fz = 0; else if (fz > this.gh - 1e-4) fz = this.gh - 1e-4;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const W = this.gw + 1;
    const h00 = this.h[iz * W + ix], h10 = this.h[iz * W + ix + 1];
    const h01 = this.h[(iz + 1) * W + ix], h11 = this.h[(iz + 1) * W + ix + 1];
    if (tx + tz <= 1) return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
    return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  }

  groundAt(x, z) {
    const i = Math.floor((x - this.x0) / this.ts);
    const j = Math.floor((z - this.z0) / this.ts);
    if (i < 0 || j < 0 || i >= this.tw || j >= this.th) return this.G.water;
    return this.ground[j * this.tw + i];
  }

  inBounds(x, z, margin = 0) {
    return x > this.x0 + margin && x < this.x1 - margin && z > this.z0 + margin && z < this.z1 - margin;
  }

  // Heightfield colliders around a point (src/world/colliderStream.js): the chunks within 120 m at once, the rest
  // nearest first through Streaming's per-frame budget; chunks leaving the radius are disabled and kept (24 most recent).
  updateColliders(RAPIER, world, x, z, radius = 700, groups) {
    if (!this.colStream) {
      this.colMs = 0.6; // build cost estimate per chunk, refined by every build
      this.colStream = new ColliderStream({
        cache: 24,
        live: this.colliders,
        estimate: () => this.colMs,
        build: (key) => {
          const t0 = performance.now();
          const c = this._buildChunk(key);
          this.colMs = this.colMs * 0.7 + 0.3 * (performance.now() - t0);
          return c;
        },
      });
    }
    this._colRAPIER = RAPIER;
    this._colGroups = groups;
    const c0x = Math.floor((x - radius - this.x0) / CHUNK), c1x = Math.floor((x + radius - this.x0) / CHUNK);
    const c0z = Math.floor((z - radius - this.z0) / CHUNK), c1z = Math.floor((z + radius - this.z0) / CHUNK);
    this.colStream.update(world, (visit) => {
      for (let cz = Math.max(0, c0z); cz <= Math.min(this.ncz - 1, c1z); cz++) {
        for (let cx = Math.max(0, c0x); cx <= Math.min(this.ncx - 1, c1x); cx++) {
          const bx = this.x0 + cx * CHUNK, bz = this.z0 + cz * CHUNK;
          const dx = Math.max(bx - x, 0, x - bx - CHUNK), dz = Math.max(bz - z, 0, z - bz - CHUNK);
          visit(cz * this.ncx + cx, Math.hypot(dx, dz));
        }
      }
    }, 120);
  }

  _buildChunk(key) {
    const RAPIER = this._colRAPIER, groups = this._colGroups;
    const cx = key % this.ncx, cz = Math.floor(key / this.ncx);
    const cpc = CHUNK / this.hs;
    const n = cpc + 1;
    const hts = new Float32Array(n * n);
    const W = this.gw + 1;
    // physOverride: vertex index -> collider height where physics must differ from the drawn ground
    // (Roads.carveTunnel: the earth drawn over a tunnel is not solid inside the tube)
    const ov = this.physOverride;
    for (let i = 0; i < n; i++) { // x columns
      const gx = Math.min(cx * cpc + i, this.gw);
      for (let j = 0; j < n; j++) { // z rows
        const gz = Math.min(cz * cpc + j, this.gh);
        const vi = gz * W + gx;
        const o = ov ? ov.get(vi) : undefined;
        hts[j + i * n] = o === undefined ? this.h[vi] : o;
      }
    }
    const desc = RAPIER.ColliderDesc.heightfield(cpc, cpc, hts, { x: CHUNK, y: 1, z: CHUNK })
      .setTranslation(this.x0 + cx * CHUNK + CHUNK / 2, 0, this.z0 + cz * CHUNK + CHUNK / 2)
      .setFriction(1.0);
    if (groups !== undefined) desc.setCollisionGroups(groups);
    return this.colStream.world.createCollider(desc);
  }
}

export const TERRAIN_CHUNK = CHUNK;
