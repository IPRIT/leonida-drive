import * as THREE from 'three';
import { ARTDECO, STUCCO, GLASS, CONCRETE, HOUSE, ROOF, INDUSTRIAL, NEON } from './palette.js';
import { patchWeather } from './weatherPatch.js';
import { ColliderStream } from './colliderStream.js';
import { unpackMeshes } from './geometryTransfer.js';
import { buildingMaterials } from './worldBuild.js';

const BUCKET = 768;
const SINK = 2.0;
// far LOD: the detailed buckets dissolve into one prism per building between FAR_A and FAR_B (camera distance, per
// pixel with the same ordered dither on both sides, so every pixel shows exactly one of them: no pop, no double draw)
const FAR_A = 1350, FAR_B = 1700;
const DITHER = 'fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))';
// ?irl=0 skips the real-world massing (public/data/irl.json) - before/after comparisons
const IRL_OFF = typeof location !== 'undefined' && new URLSearchParams(location.search).get('irl') === '0';
const UP = [0, 1, 0], DOWN = [0, -1, 0];

function rnd(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const _c = new THREE.Color();
function lin(hex) { _c.setHex(hex); return [_c.r, _c.g, _c.b]; }

// even-odd test against a flat [x0, z0, x1, z1, ...] footprint
function pointInPoly(p, x, z) {
  let c = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const zi = p[i + 1], zj = p[j + 1];
    if ((zi > z) !== (zj > z) && x < ((p[j] - p[i]) * (z - zi)) / (zj - zi) + p[i]) c = !c;
  }
  return c;
}

// convex hull of [[x, z], ...] (monotone chain), counter-clockwise
function hull2(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  up.pop(); lo.pop();
  return lo.concat(up);
}

// Merged, bucketed building meshes with procedural facades + streamed trimesh colliders.
export class Buildings {
  constructor(data, terrain, scene, prepared = null) {
    this.terrain = terrain;
    this.list = data.buildings;
    this.group = new THREE.Group();
    scene.add(this.group);
    // impact holes punched into facades (ring buffer): xyz = centre, w = radius
    this.uniforms = { uNight: { value: 0 }, uTime: { value: 0 }, uHoles: { value: Array.from({ length: 24 }, () => new THREE.Vector4(0, -1e4, 0, 0)) }, uHoleCount: { value: 0 } };
    this.holeIdx = 0;
    this.material = this.makeMaterial();
    if (prepared) {
      const t0 = performance.now();
      Object.assign(this, prepared.state);
      this.farMaterial = this.makeFarMaterial();
      const meshes = unpackMeshes(prepared.meshes, this.group, buildingMaterials(this));
      this.buckets = new Map(prepared.buckets.map(([key, b]) => {
        b.mesh = meshes[b.mesh]; b.box = b.mesh.geometry.boundingBox;
        return [key, b];
      }));
      this.far = prepared.far.map((f) => ({ key: f.key, mesh: meshes[f.mesh], box: meshes[f.mesh].geometry.boundingBox }));
      this.farByKey = new Map(this.far.map((f) => [f.key, f]));
      this.colliders = new Map();
      this.stats = { ...this.stats, worker: true, hydrateMs: performance.now() - t0 };
      return;
    }
    this.buckets = new Map();
    this.recs = new Array(this.list.length);
    const t0 = performance.now();
    this.irl = this.indexIrl(data.irl);
    this.build();
    const t1 = performance.now();
    this.buildFar();
    this.stats = { buildMs: +(t1 - t0).toFixed(1), farMs: +(performance.now() - t1).toFixed(1), farTris: this.farTris, irl: this.irl.size, irlTris: this.irlTris || 0 };
    this.colliders = new Map();
    // spatial grid of building centres for queries / collider streaming
    this.cell = 64;
    this.grid = new Map();
    this.recs.forEach((r, id) => {
      if (!r) return;
      const key = Math.floor(r.cx / this.cell) * 100003 + Math.floor(r.cz / this.cell);
      let l = this.grid.get(key);
      if (!l) this.grid.set(key, (l = []));
      l.push(id);
    });
  }

  makeMaterial() {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.02, flatShading: true });
    const u = this.uniforms;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 aFacade; attribute vec3 aNeon;
          varying vec4 vFacade; varying vec3 vNeon; varying vec3 vWp;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vFacade = aFacade; vNeon = aNeon; vWp = (modelMatrix * vec4(position, 1.0)).xyz;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uNight; uniform float uTime;
          uniform vec4 uHoles[24]; uniform float uHoleCount;
          varying vec4 vFacade; varying vec3 vNeon; varying vec3 vWp;
          float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
          vec3 gEmit = vec3(0.0); float gGlass = 0.0; float gHole = 0.0;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float fu = vFacade.x, fv = vFacade.y, style = vFacade.z, kind = vFacade.w;
          // kind: 0 wall, 1 roof, 2 neon band, 3 crown/plain
          if (kind < 0.5 && fv > 0.0) {
            float floorH = style > 2.5 && style < 3.5 ? 3.1 : 3.6;
            float bay = style < 2.5 && style > 1.5 ? 1.6 : (style > 3.5 && style < 4.5 ? 6.0 : 3.1);
            vec2 cell = vec2(floor(fu / bay), floor(fv / floorH));
            vec2 f = vec2(fract(fu / bay), fract(fv / floorH));
            // Band-limited windows: each axis fades to its coverage average once its cells get smaller than ~3 px,
            // so distant towers keep their floor stripes (rows) long after the columns blur, and lights switch to
            // 4-window blocks before averaging out completely. No aliasing, no sparkle, still readable at range.
            vec2 pw = vec2(fwidth(fu) / bay, fwidth(fv) / floorH) + 1e-4;
            float farX = smoothstep(0.16, 0.5, pw.x), farY = smoothstep(0.16, 0.5, pw.y);
            float farAll = smoothstep(0.6, 1.6, max(pw.x, pw.y));
            #define AASTEP(e, x, w) clamp(((x) - (e)) / (w) + 0.5, 0.0, 1.0)
            vec4 r; // x0, x1, y0, y1 window rectangle inside the cell
            if (style > 1.5 && style < 2.5) r = vec4(0.06, 0.94, 0.14, 0.92);      // glass curtain wall
            else if (style > 3.5 && style < 4.5) r = vec4(0.2, 0.8, 0.55, 0.85);   // high ribbon windows
            else r = vec4(0.2, 0.8, 0.28, 0.82);
            if (fv < floorH && style < 3.5) r = vec4(0.08, 0.92, 0.1, 0.78);       // ground floor storefronts
            float wx = mix(AASTEP(r.x, f.x, pw.x) * AASTEP(f.x, r.y, pw.x), r.y - r.x, farX);
            float wy = mix(AASTEP(r.z, f.y, pw.y) * AASTEP(f.y, r.w, pw.y), r.w - r.z, farY);
            float win = wx * wy;
            if (style > 3.5 && style < 4.5) win *= step(4.0, fv);
            float cov = (r.y - r.x) * (r.w - r.z);
            float w = mix(win, cov, farAll);
            vec2 seed = vec2(floor(vWp.x * 0.05) * 17.0, floor(vWp.z * 0.05) * 31.0);
            float h = hash12(cell + seed);
            float hB = hash12(vec2(floor(cell.x / 4.0), cell.y) + seed + 3.7); // 4-window blocks
            vec3 glassDay = mix(vec3(0.16, 0.22, 0.3), vec3(0.45, 0.6, 0.72), mix(h, 0.5, farX) * 0.5 + (style > 1.5 && style < 2.5 ? 0.4 : 0.0));
            vec3 glassNight = vec3(0.03, 0.035, 0.05);
            vec3 gcol = mix(glassDay, glassNight, uNight);
            diffuseColor.rgb = mix(diffuseColor.rgb, gcol, w);
            gGlass = w;
            // fewer, warmer, dimmer lights; office towers a little cooler
            float litShare = 0.3 + 0.18 * step(fv, floorH * 1.01);
            float lit = mix(step(h, litShare), step(hB, litShare), farX);
            lit = mix(lit, litShare, farAll);
            float hl = mix(h, hB, farX);
            vec3 warm = mix(vec3(1.0, 0.68, 0.36), vec3(0.78, 0.84, 0.95), step(0.82, hash12(cell * 1.7)));
            warm = mix(warm, vec3(0.96, 0.72, 0.44), farX);
            float dist = length(vWp - cameraPosition);
            float distFade = 1.0 - 0.25 * smoothstep(800.0, 4000.0, dist);
            gEmit = warm * w * lit * (0.42 + 0.34 * hl) * uNight * distFade;
          } else if (kind > 0.5 && kind < 1.5) {
            diffuseColor.rgb *= 0.92 + 0.08 * hash12(floor(vWp.xz * 0.5));
          } else if (kind > 1.5 && kind < 2.5) {
            gEmit = vNeon * (0.6 + 2.6 * uNight) * (0.92 + 0.08 * sin(uTime * 6.0 + vWp.x));
          }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.12, gGlass);
          // punched holes: dark broken cavity with a charred, jagged rim
          if (uHoleCount > 0.5) {
            float hd = 1e3;
            for (int i = 0; i < 24; i++) {
              if (float(i) >= uHoleCount) break;
              vec4 H = uHoles[i];
              float jag = 0.72 + 0.5 * hash12(floor(vWp.xz * 1.7 + vWp.y * 1.3));
              hd = min(hd, length(vWp - H.xyz) - H.w * jag);
            }
            if (hd < 0.0) { diffuseColor.rgb = vec3(0.022, 0.02, 0.018); gEmit = vec3(0.0); gHole = 1.0; roughnessFactor = 1.0; }
            else if (hd < 0.8) { float k = hd / 0.8; diffuseColor.rgb *= mix(0.2, 1.0, k); gEmit *= k; }
          }`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
          metalnessFactor = mix(metalnessFactor, 0.55, gGlass * (1.0 - uNight)) * (1.0 - gHole);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += gEmit;`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          { float bt = clamp((length(vWp - cameraPosition) - ${FAR_A}.0) / ${FAR_B - FAR_A}.0, 0.0, 1.0);
            if (bt > 0.0 && bt >= ${DITHER}) discard; } // far band: the far LOD takes over (buildFar)`);
      patchWeather(sh, { worldPos: 'vWp', porosity: 0.3 });
    };
    mat.customProgramCacheKey = () => 'bld-v6';
    return mat;
  }

  // far LOD material: building colour + the glass share of its style (what the facade shader averages to at range);
  // at night the walls glow with its averaged window lights, brighter with distance so cities read from the air
  makeFarMaterial() {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.02, flatShading: true });
    const u = this.uniforms;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uNight = u.uNight;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec3 aFar; varying vec3 vFar; varying vec3 vWp;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vFar = aFar; vWp = (modelMatrix * vec4(position, 1.0)).xyz;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uNight; varying vec3 vFar; varying vec3 vWp; vec3 gEmit = vec3(0.0);`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          float fdist = length(vWp - cameraPosition);
          if (clamp((fdist - ${FAR_A}.0) / ${FAR_B - FAR_A}.0, 0.0, 1.0) < ${DITHER}) discard;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float style = vFar.x, seed = vFar.z;
          if (vFar.y < 0.5) { // walls (roofs keep their colour)
            float glass = step(1.5, style) * step(style, 2.5);
            float cov = glass > 0.5 ? 0.686 : (style > 3.5 && style < 4.5 ? 0.18 : 0.324);
            vec3 gDay = mix(vec3(0.16, 0.22, 0.3), vec3(0.45, 0.6, 0.72), 0.25 + 0.4 * glass);
            diffuseColor.rgb = mix(diffuseColor.rgb, mix(gDay, vec3(0.03, 0.035, 0.05), uNight), cov);
            float lit = 0.3 * (0.45 + 1.1 * seed);
            float boost = mix(1.0, 2.6, smoothstep(1500.0, 5000.0, fdist));
            gEmit = vec3(0.96, 0.72, 0.44) * cov * lit * 0.59 * uNight * boost;
          }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += gEmit;`);
      patchWeather(sh, { worldPos: 'vWp', porosity: 0.3 });
    };
    mat.customProgramCacheKey = () => 'bld-far-v1';
    return mat;
  }

  // One prism per building (per part for real-world massing): footprint hull of at most 8 corners from below the base
  // to the wall top, coloured with the building's own wall / roof colours (averaged from its near mesh). 2x2 buckets
  // per mesh. ~12-26 triangles a building; the near buckets are skipped beyond FAR_B, these before FAR_A (lod()).
  buildFar() {
    this.farMaterial = this.makeFarMaterial();
    const CL = BUCKET * 2;
    const clusters = new Map();
    const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3();
    for (let id = 0; id < this.recs.length; id++) {
      const r = this.recs[id];
      if (!r) continue;
      const o = this.list[id];
      const key = Math.floor(r.cx / CL) * 1000 + Math.floor(r.cz / CL);
      let c = clusters.get(key);
      if (!c) clusters.set(key, (c = { key, pos: [], nrm: [], col: [], far: [], idx: [] }));
      const g = this.buckets.get(r.key).mesh.geometry;
      const col = g.attributes.color.array, nrm = g.attributes.normal.array, fac = g.attributes.aFacade.array;
      const W = [0, 0, 0, 0], R = [0, 0, 0, 0];
      const step = Math.max(1, Math.floor((r.vEnd - r.vStart) / 96));
      for (let v = r.vStart; v < r.vEnd; v += step) {
        if (fac[v * 4 + 3] > 1.5) continue; // neon bands, crowns, interiors
        const ny = nrm[v * 3 + 1], A = ny > 0.5 ? R : Math.abs(ny) < 0.5 ? W : null;
        if (!A) continue;
        A[0] += col[v * 3]; A[1] += col[v * 3 + 1]; A[2] += col[v * 3 + 2]; A[3]++;
      }
      const wall = W[3] ? [W[0] / W[3], W[1] / W[3], W[2] / W[3]] : [0.55, 0.55, 0.55];
      const roof = R[3] ? [R[0] / R[3], R[1] / R[3], R[2] / R[3]] : wall.map((x) => x * 0.85);
      const seed = ((id * 2654435761) >>> 0) / 4294967296;
      const style = r.style ?? 0;
      const parts = o.irl?.parts?.length
        ? o.irl.parts.map((q) => [q.p, r.base + (q.b > 0.3 ? q.b : 0), r.base + (q._wt ?? q.h)])
        : [[o.p, r.base, r.top + (style === 3 ? 1.6 : 0)]];
      const i0 = c.idx.length;
      for (const [fp, y0, y1] of parts) {
        if (!fp || fp.length < 6 || !(y1 > y0 + 0.5)) continue;
        const pts = [];
        for (let i = 0; i < fp.length; i += 2) pts.push([fp[i], fp[i + 1]]);
        let h = hull2(pts);
        if (h.length < 3) continue;
        if (h.length > 8) { const n = h.length; h = Array.from({ length: 8 }, (_, k) => h[Math.floor((k * n) / 8)]); }
        let hx = 0, hz = 0;
        for (const q of h) { hx += q[0]; hz += q[1]; }
        hx /= h.length; hz /= h.length;
        const yb = y0 - SINK;
        const vert = (x, y, z, nx, ny, nz, cc, kind) => {
          c.pos.push(x, y, z); c.nrm.push(nx, ny, nz); c.col.push(cc[0], cc[1], cc[2]); c.far.push(style, kind, seed);
          return c.pos.length / 3 - 1;
        };
        const tri = (a, b, d, want) => { // winding facing `want`
          _a.fromArray(c.pos, b * 3).sub(_b.fromArray(c.pos, a * 3));
          _n.fromArray(c.pos, d * 3).sub(_b);
          if (_a.cross(_n).dot(want) >= 0) c.idx.push(a, b, d); else c.idx.push(a, d, b);
        };
        for (let k = 0; k < h.length; k++) {
          const [ax, az] = h[k], [bx, bz] = h[(k + 1) % h.length];
          let nx = bz - az, nz = -(bx - ax);
          const l = Math.hypot(nx, nz) || 1;
          nx /= l; nz /= l;
          if (nx * ((ax + bx) / 2 - hx) + nz * ((az + bz) / 2 - hz) < 0) { nx = -nx; nz = -nz; }
          const A0 = vert(ax, yb, az, nx, 0, nz, wall, 0), B0 = vert(bx, yb, bz, nx, 0, nz, wall, 0);
          const B1 = vert(bx, y1, bz, nx, 0, nz, wall, 0), A1 = vert(ax, y1, az, nx, 0, nz, wall, 0);
          _n.set(nx, 0, nz);
          const want = _n.clone();
          tri(A0, B0, B1, want); tri(A0, B1, A1, want);
        }
        const up = new THREE.Vector3(0, 1, 0);
        const r0 = vert(h[0][0], y1, h[0][1], 0, 1, 0, roof, 1);
        let prev = vert(h[1][0], y1, h[1][1], 0, 1, 0, roof, 1);
        for (let k = 2; k < h.length; k++) {
          const cur = vert(h[k][0], y1, h[k][1], 0, 1, 0, roof, 1);
          tri(r0, prev, cur, up);
          prev = cur;
        }
      }
      if (c.idx.length > i0) r.far = { key, i0, i1: c.idx.length };
    }
    this.far = [];
    this.farTris = 0;
    for (const c of clusters.values()) {
      if (!c.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(c.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(c.nrm, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(c.col, 3));
      g.setAttribute('aFar', new THREE.Float32BufferAttribute(c.far, 3));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(c.idx), 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      const m = new THREE.Mesh(g, this.farMaterial);
      m.name = 'buildings:far';
      m.castShadow = false;
      m.receiveShadow = false;
      m.visible = false;
      this.group.add(m);
      this.far.push({ key: c.key, mesh: m, box: g.boundingBox });
      this.farTris += c.idx.length / 3;
    }
    this.farByKey = new Map(this.far.map((f) => [f.key, f]));
    for (const b of this.buckets.values()) { b.mesh.geometry.computeBoundingBox(); b.box = b.mesh.geometry.boundingBox; }
  }

  // near buckets drawn up to FAR_B, far clusters from FAR_A (the dither in both shaders splits the band per pixel)
  lod(camera) {
    if (!camera || !this.far) return;
    const p = camera.position;
    const dmin = (b) => Math.hypot(Math.max(b.min.x - p.x, 0, p.x - b.max.x), Math.max(b.min.y - p.y, 0, p.y - b.max.y), Math.max(b.min.z - p.z, 0, p.z - b.max.z));
    const dmax = (b) => Math.hypot(Math.max(p.x - b.min.x, b.max.x - p.x), Math.max(p.y - b.min.y, b.max.y - p.y), Math.max(p.z - b.min.z, b.max.z - p.z));
    for (const b of this.buckets.values()) if (b.box) b.mesh.visible = dmin(b.box) < FAR_B;
    for (const f of this.far) f.mesh.visible = dmax(f.box) > FAR_A;
  }

  _farHide(id) {
    const f = this.recs[id]?.far, c = f && this.farByKey?.get(f.key);
    if (!c) return;
    const idx = c.mesh.geometry.index;
    for (let i = f.i0; i < f.i1; i++) idx.array[i] = 0;
    idx.addUpdateRange(f.i0, f.i1 - f.i0);
    idx.needsUpdate = true;
  }

  bucketFor(x, z) {
    const key = Math.floor(x / BUCKET) * 1000 + Math.floor(z / BUCKET);
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, (b = { key, pos: [], nrm: [], col: [], fac: [], neon: [], idx: [], phys: [], physIdx: [] }));
    return b;
  }

  build() {
    for (let bi = 0; bi < this.list.length; bi++) {
      const o = this.list[bi];
      const p = o.p;
      let cx = 0, cz = 0;
      for (let i = 0; i < p.length; i += 2) { cx += p[i]; cz += p[i + 1]; }
      cx /= p.length / 2; cz /= p.length / 2;
      const wet = this.wetness(o, cx, cz);
      if (wet === 'sea') continue; // footprint far out in open water (map classification artefact)
      if (wet === 'pier' && !o.pier) { o.pier = true; o.y = Math.max(o.y, 1.4); } // stands on a pier deck
      const irl = this.irl.get(bi);
      if (irl && !o.irl) {
        // real-world prototype: its height / style become the building's (records, colliders, map, damage)
        o.irl = irl;
        o.h = irl.h;
        o.f = Math.max(1, Math.round(irl.h / 3.6));
        o.s = irl.s;
      }
      const b = this.bucketFor(cx, cz);
      const i0 = b.idx.length, v0 = b.pos.length / 3, pv0 = b.phys.length / 3, pi0 = b.physIdx.length;
      this.addBuilding(o, bi);
      if (b.idx.length === i0) continue;
      if (o.irl) this.irlTris = (this.irlTris || 0) + (b.idx.length - i0) / 3;
      this.recs[bi] = {
        key: b.key, iStart: i0, iEnd: b.idx.length, vStart: v0, vEnd: b.pos.length / 3,
        pvStart: pv0, pvEnd: b.phys.length / 3, piStart: pi0, piEnd: b.physIdx.length,
        cx, cz, base: o.y, height: o.h, top: o.y + o.h, style: o.s, floors: o.f, procedural: !!o.g, name: o.n,
        health: 1, removed: false,
      };
      if (o.irl) {
        // real-world massing: marker id, collider outline, roof decks (the top is not the whole footprint)
        const rr = this.recs[bi];
        rr.irl = o.irl.m;
        rr.foot = this.irlFoot(o);
        rr.roofs = o.irl._roofs || [];
        // top / height = highest deck (wall top of pitched / domed / spired parts, like the generated houses whose
        // roofs rise above `top`); peak = the very top, used for the collider so spires and domes stay solid
        let deck = 0;
        for (const f of rr.roofs) deck = Math.max(deck, f.y - o.y);
        if (deck > 0.5 && deck < o.h) { o.h = deck; o.f = Math.max(1, Math.round(deck / 3.6)); rr.height = deck; rr.top = o.y + deck; rr.floors = o.f; }
        rr.peak = o.y + o.irl.h;
      }
    }
    for (const b of this.buckets.values()) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
      g.setAttribute('aFacade', new THREE.Float32BufferAttribute(b.fac, 4));
      g.setAttribute('aNeon', new THREE.Float32BufferAttribute(b.neon, 3));
      g.setIndex(b.idx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, this.material);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
      b.mesh = m;
      b.pos = b.nrm = b.col = b.fac = b.neon = b.idx = null;
      // collider soup as typed arrays right away (~2.5M boxed JS numbers otherwise stay on the heap for the session)
      b.physVerts = new Float32Array(b.phys);
      b.physIndex = Uint32Array.from(b.physIdx);
      b.phys = b.physIdx = null;
    }
  }

  // quad helper (a,b,c,d CCW seen from outside)
  quad(b, a, bb, c, d, n, col, fa, fb, fc, fd, neon = [0, 0, 0]) {
    const base = b.pos.length / 3;
    for (const [p, f] of [[a, fa], [bb, fb], [c, fc], [d, fd]]) {
      b.pos.push(p[0], p[1], p[2]);
      b.nrm.push(n[0], n[1], n[2]);
      b.col.push(col[0], col[1], col[2]);
      b.fac.push(f[0], f[1], f[2], f[3]);
      b.neon.push(neon[0], neon[1], neon[2]);
    }
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  // vBase: world height the facade's floor grid starts from (default y0 + SINK = the building's own base);
  // IRL setback parts pass the building base so storeys line up across parts. cap = false: no flat roof.
  prism(b, poly, y0, y1, col, style, roofCol, uStart = 0, kindWall = 0, neon = null, vBase = null, cap = true) {
    // poly: [[x,z],...] CCW (seen from above, x right, z down => use signed area check)
    const n = poly.length;
    const vb = vBase ?? y0 + SINK;
    let u = uStart;
    for (let i = 0; i < n; i++) {
      const [ax, az] = poly[i];
      const [bx, bz] = poly[(i + 1) % n];
      const dx = bx - ax, dz = bz - az;
      const L = Math.hypot(dx, dz);
      if (L < 0.05) continue;
      const nx = dz / L, nz = -dx / L; // outward for CCW-in-xz (clockwise seen from +y)
      if (this._panels && kindWall === 0) {
        this.panelWall(b, ax, az, bx, bz, L, nx, nz, y0, y1, u, style, col, vb);
        u += L;
        continue;
      }
      this.quad(b, [ax, y0, az], [ax, y1, az], [bx, y1, bz], [bx, y0, bz], [nx, 0, nz], col,
        [u, y0 - vb, style, kindWall], [u, y1 - vb, style, kindWall], [u + L, y1 - vb, style, kindWall], [u + L, y0 - vb, style, kindWall], neon || [0, 0, 0]);
      const pb = b.phys.length / 3;
      b.phys.push(ax, y0, az, ax, y1, az, bx, y1, bz, bx, y0, bz);
      b.physIdx.push(pb, pb + 1, pb + 2, pb, pb + 2, pb + 3);
      u += L;
    }
    if (!cap) return u;
    // roof
    const contour = poly.map(([x, z]) => new THREE.Vector2(x, z));
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch { tris = []; }
    const base = b.pos.length / 3;
    for (const [x, z] of poly) {
      b.pos.push(x, y1, z); b.nrm.push(0, 1, 0); b.col.push(roofCol[0], roofCol[1], roofCol[2]);
      b.fac.push(0, 0, style, 1); b.neon.push(0, 0, 0);
    }
    const pbase = b.phys.length / 3;
    for (const [x, z] of poly) b.phys.push(x, y1, z);
    for (const t of tris) {
      // ensure upward winding
      const [i0, i1, i2] = t;
      const ax = poly[i1][0] - poly[i0][0], az = poly[i1][1] - poly[i0][1];
      const bx = poly[i2][0] - poly[i0][0], bz = poly[i2][1] - poly[i0][1];
      const cy = az * bx - ax * bz;
      if (cy > 0) b.idx.push(base + i0, base + i1, base + i2);
      else b.idx.push(base + i0, base + i2, base + i1);
      b.physIdx.push(pbase + i0, pbase + i1, pbase + i2);
    }
    return u;
  }

  // null = on land; 'pier' = over water next to the shore (gets a deck on piles); 'sea' = open water (dropped).
  // Wet = water class or ground below sea level: footprints keep their own 'building' class even where the map put
  // them in a bay, so the class alone let houses stand in open water (Catalan Key) or sink into the shallows.
  wetness(o, cx, cz) {
    const T = this.terrain;
    if (!T?.groundAt) return null;
    const W = T.G.water, p = o.p;
    const wetAt = (x, z) => T.groundAt(x, z) === W || (T.heightAt ? T.heightAt(x, z) < 0.05 : false);
    let n = 1, wet = wetAt(cx, cz) ? 1 : 0;
    for (let i = 0; i < p.length; i += 2) { n++; if (wetAt((p[i] + cx) / 2, (p[i + 1] + cz) / 2)) wet++; }
    if (wet / n <= 0.5) return null;
    let area = 0;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) area += p[j] * p[i + 1] - p[i] * p[j + 1];
    area = Math.abs(area) / 2;
    for (const r of [8, 16, 26]) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        if (wetAt(cx + Math.cos(a) * r, cz + Math.sin(a) * r)) continue;
        // a stilt house / jetty hut; generated infill and big blocks don't go on piles (an office block on a raft)
        return o.g || area > 300 || o.h > 9 ? 'sea' : 'pier';
      }
    }
    return 'sea';
  }

  addBuilding(o, bi) {
    const p = o.p;
    let poly = [];
    for (let i = 0; i < p.length; i += 2) poly.push([p[i], p[i + 1]]);
    if (poly.length < 3) return;
    // orientation: make it clockwise in (x,z) so outward normals = (dz,-dx)/L
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length];
      area += x0 * z1 - x1 * z0;
    }
    if (area < 0) poly = poly.reverse();
    let cx = 0, cz = 0;
    for (const [x, z] of poly) { cx += x; cz += z; }
    cx /= poly.length; cz /= poly.length;
    const b = this.bucketFor(cx, cz);
    const r = rnd(bi * 2654435761 + 12345);
    const style = o.s;
    const y0 = o.y - SINK;
    const h = o.h;
    const top = o.y + h;
    const pick = (arr) => arr[Math.floor(r() * arr.length)];
    let wall, roof;
    switch (style) {
      case 1: wall = lin(pick(ARTDECO)); roof = lin(0xd9d4cc); break;
      case 2: wall = lin(pick(GLASS)); roof = lin(0x8d9399); break;
      case 3: wall = lin(pick(HOUSE)); roof = lin(pick(ROOF)); break;
      case 4: wall = lin(pick(INDUSTRIAL)); roof = lin(0x9ea3a8); break;
      case 5: wall = lin(pick(CONCRETE)); roof = lin(0x9a9a98); break;
      default: wall = lin(pick(STUCCO)); roof = lin(0xb9b4ab);
    }
    if (o.pier) {
      // weathered timber deck reaching into the water, so the building reads as a pier / stilt house
      const deck = this.offsetPoly(poly, 1.6);
      if (deck) this.prism(b, deck, -2.5, o.y, lin(0x7a5f45), 4, lin(0x8b6d4f), 0, 3);
    }
    if (o.irl) {
      this.addIrl(b, o, wall, r, pick);
      return;
    }
    if (style === 3 && poly.length === 4) {
      this.house(b, poly, y0, o.y + Math.max(3, h), wall, roof, r, cx, cz);
      return;
    }
    let u = this.prism(b, poly, y0, top, wall, style, roof);
    // art deco: parapet band with neon
    if (style === 1) {
      const neon = lin(pick(NEON));
      const inset = this.offsetPoly(poly, -0.05);
      if (inset) this.prism(b, inset, top - 1.4, top - 1.0, neon, style, roof, 0, 2, neon);
      const crown = this.offsetPoly(poly, 0.6);
      if (crown && r() < 0.55) this.prism(b, crown, top, top + 1.2 + r() * 2.5, wall, style, roof, 0, 3);
    }
    // towers: setback crown + mechanical box
    if ((style === 2 || style === 5) && h > 35) {
      const k = 0.18 + r() * 0.12;
      const crown = this.scalePoly(poly, cx, cz, 1 - k);
      const ch = h * (0.06 + r() * 0.08);
      this.prism(b, crown, top, top + ch, wall, style, roof);
      if (h > 90 && r() < 0.6) {
        const c2 = this.scalePoly(poly, cx, cz, 0.45);
        this.prism(b, c2, top + ch, top + ch + h * 0.05, wall, 3.0, roof, 0, 3);
        if (r() < 0.5) {
          const ant = this.scalePoly(poly, cx, cz, 0.06);
          this.prism(b, ant, top + ch, top + ch + 12 + r() * 18, lin(0xdddddd), 3, lin(0xff3030), 0, 3);
        }
      }
    } else if (style !== 1 && h > 10 && r() < 0.5) {
      const box = this.scalePoly(poly, cx, cz, 0.3);
      this.prism(b, box, top, top + 2.2, lin(0xaaaaaa), 3, lin(0x999999), 0, 3);
    }
  }

  house(b, poly, y0, wallTop, wall, roofCol, r, hcx, hcz) {
    // walls
    this.prism(b, poly, y0, wallTop, wall, 3, roofCol);
    // gable roof along the longer side
    const e0 = Math.hypot(poly[1][0] - poly[0][0], poly[1][1] - poly[0][1]);
    const e1 = Math.hypot(poly[2][0] - poly[1][0], poly[2][1] - poly[1][1]);
    const q = e0 >= e1 ? poly : [poly[1], poly[2], poly[3], poly[0]];
    const short = Math.min(e0, e1);
    const rh = short * (0.28 + r() * 0.12);
    const ov = 0.5; // eave overhang
    const m03 = [(q[0][0] + q[3][0]) / 2, (q[0][1] + q[3][1]) / 2];
    const m12 = [(q[1][0] + q[2][0]) / 2, (q[1][1] + q[2][1]) / 2];
    const yt = wallTop + rh;
    const ext = (p, c, k) => [p[0] + (p[0] - c[0]) * k, p[1] + (p[1] - c[1]) * k];
    const c = [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2];
    const k = ov / Math.max(1, short / 2);
    const Q = q.map((p) => ext(p, c, k));
    const R0 = ext(m03, c, k * 0.5), R1 = ext(m12, c, k * 0.5);
    const yE = wallTop - 0.15;
    const tri = (a, bb, cc, col) => {
      const ux = bb[0] - a[0], uy = bb[1] - a[1], uz = bb[2] - a[2];
      const vx = cc[0] - a[0], vy = cc[1] - a[1], vz = cc[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const base = b.pos.length / 3;
      for (const p of [a, bb, cc]) {
        b.pos.push(p[0], p[1], p[2]); b.nrm.push(nx, ny, nz); b.col.push(col[0], col[1], col[2]);
        b.fac.push(0, 0, 3, 1); b.neon.push(0, 0, 0);
      }
      // face away from the house centre (roofs up, gables out)
      const mx = (a[0] + bb[0] + cc[0]) / 3 - hcx, mz = (a[2] + bb[2] + cc[2]) / 3 - hcz;
      const out = Math.abs(ny) > 0.2 ? ny > 0 : nx * mx + nz * mz > 0;
      if (!out) {
        b.nrm.splice(b.nrm.length - 9, 9, -nx, -ny, -nz, -nx, -ny, -nz, -nx, -ny, -nz);
        b.idx.push(base, base + 2, base + 1);
      } else b.idx.push(base, base + 1, base + 2);
      const pb = b.phys.length / 3;
      b.phys.push(...a, ...bb, ...cc);
      b.physIdx.push(pb, pb + 1, pb + 2);
    };
    const P = (p, y) => [p[0], y, p[1]];
    // two roof planes
    tri(P(Q[0], yE), P(Q[1], yE), P(R1, yt), roofCol);
    tri(P(Q[0], yE), P(R1, yt), P(R0, yt), roofCol);
    tri(P(Q[2], yE), P(Q[3], yE), P(R0, yt), roofCol);
    tri(P(Q[2], yE), P(R0, yt), P(R1, yt), roofCol);
    // gables (wall coloured)
    tri(P(q[3], wallTop), P(q[0], wallTop), P(m03, yt - 0.1), wall);
    tri(P(q[1], wallTop), P(q[2], wallTop), P(m12, yt - 0.1), wall);
  }

  // ---------- real-world massing (OpenStreetMap, (c) OSM contributors, ODbL) ----------
  // public/data/irl.json (tools/irl_build.py): { b: [{ i: building index, c: [cx, cz] footprint centroid, m: marker id,
  // h: height, s: facade style, w?: wall colour, rc?: roof colour, parts: [{ p: [x, z, ...], h: top, b?: bottom,
  // r?: roof shape, rh?: roof height, w?, c? }] }] }. Heights are metres above the footprint base (o.y).
  // Roof shapes: 0 flat, 1 gabled, 2 hipped, 3 pyramidal, 4 dome, 5 skillion, 6 mansard, 7 round, 8 onion, 9 cone.
  // Records are matched by footprint geometry (vertex-mean centroid within 2 m + area within 5 %), the index is only
  // a hint: a regenerated buildings.json never puts a tower on the wrong lot, unmatched records are skipped.
  indexIrl(doc) {
    const map = new Map();
    if (IRL_OFF || !Array.isArray(doc?.b)) return map;
    const geo = (p) => {
      let x = 0, z = 0, a = 0;
      const n = p.length / 2;
      for (let i = 0; i < p.length; i += 2) { x += p[i]; z += p[i + 1]; const j = (i + 2) % p.length; a += p[i] * p[j + 1] - p[j] * p[i + 1]; }
      return [x / n, z / n, Math.abs(a) / 2];
    };
    const same = (g, rec) => Math.abs(g[0] - rec.c[0]) < 2 && Math.abs(g[1] - rec.c[1]) < 2 && (!(rec.a > 0) || Math.abs(g[2] - rec.a) <= rec.a * 0.05 + 1);
    let grid = null;
    for (const rec of doc.b) {
      if (!rec?.parts?.length || !Array.isArray(rec.c) || !(rec.h > 0)) continue;
      let id = -1;
      const o = this.list[rec.i];
      if (o?.p && same(geo(o.p), rec)) id = rec.i;
      if (id < 0) {
        if (!grid) {
          grid = new Map();
          this.list.forEach((q, j) => { const g = geo(q.p); const k = Math.floor(g[0] / 16) * 100003 + Math.floor(g[1] / 16); let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push([g, j]); });
        }
        const gx = Math.floor(rec.c[0] / 16), gz = Math.floor(rec.c[1] / 16);
        for (let i = gx - 1; i <= gx + 1; i++) for (let j = gz - 1; j <= gz + 1; j++) for (const [g, k] of grid.get(i * 100003 + j) || []) if (id < 0 && same(g, rec)) id = k;
      }
      if (id >= 0 && !map.has(id)) map.set(id, rec);
    }
    return map;
  }

  // collider outline of an IRL building: ground-level parts (+ whether the massing is one even block)
  irlFoot(o) {
    const pts = [];
    let area = 0, hmin = Infinity, hmax = 0;
    for (const q of o.irl.parts) {
      hmin = Math.min(hmin, q.h); hmax = Math.max(hmax, q.h);
      if (q.b > 0.3) continue;
      const poly = [];
      for (let i = 0; i < q.p.length; i += 2) poly.push([q.p[i], q.p[i + 1]]);
      pts.push(...poly);
      area += polyArea(poly);
    }
    // stepped towers (setbacks, spires, podiums) get the exact trimesh instead of a full-height hull
    const even = hmax - hmin <= Math.max(4, hmax * 0.12);
    return pts.length >= 3 ? { pts, area, even } : null;
  }

  addIrl(b, o, wallDef, r, pick) {
    const R = o.irl, style = R.s, yB = o.y;
    const wallB = R.w != null ? lin(R.w) : wallDef;
    const flatRoof = R.rc != null ? lin(R.rc) : lin(style === 2 ? 0x8d9399 : style === 4 ? 0x9ea3a8 : style === 1 ? 0xd9d4cc : style === 5 ? 0x9a9a98 : 0xb9b4ab);
    const pitchRoof = R.rc != null ? lin(R.rc) : lin(pick(ROOF));
    let main = null;
    const roofs = [];
    for (const q of R.parts) {
      let poly = [];
      for (let i = 0; i < q.p.length; i += 2) poly.push([q.p[i], q.p[i + 1]]);
      if (poly.length < 3) continue;
      if (signedArea(poly) < 0) poly = poly.reverse();
      const bot = q.b > 0.3 ? q.b : 0, ph = q.h - bot, shape = q.r || 0;
      const steep = shape === 3 || shape === 4 || shape === 8 || shape === 9;
      const rh = shape ? Math.min(q.rh ?? this.roofH(shape, poly, ph), ph * (steep ? 1 : 0.85)) : 0;
      const wc = q.w != null ? lin(q.w) : wallB;
      const rc = q.c != null ? lin(q.c) : shape ? pitchRoof : flatRoof;
      const y0 = bot ? yB + bot : yB - SINK;
      let y1 = yB + q.h - rh;
      const roofed = shape ? this.irlRoof(b, poly, y1, rh, shape, wc, rc, style) : false;
      if (shape && !roofed) y1 = yB + q.h; // roof could not be built on this outline: flat top at full height
      q._wt = y1 - yB; // wall top above base (fracture slabs)
      roofs.push({ p: q.p, y: y1, peak: yB + q.h, flat: !roofed });
      if (y1 - y0 > 0.05) this.prism(b, poly, y0, y1, wc, style, rc, 0, 0, null, yB, !roofed);
      else if (!roofed) this.cap(b, poly, y1, rc, [0, 0, style, 1], UP);
      if (bot) this.cap(b, poly, y0, wc, [0, 0, style, 3], DOWN); // underside of overhangs / sky bridges
      const a = polyArea(poly);
      if (!bot && (!main || a > main.a)) main = { poly, a, top: y1, flat: !roofed };
    }
    // roof decks of the real massing (rooftop props, signs, pickups): [{ p: flat [x, z, ...], y: deck / wall top
    // (world), peak: top of its roof (world), flat }]
    R._roofs = roofs;
    if (!main || !main.flat) return;
    const [cx, cz] = polyCentroid(main.poly);
    if (style === 1) {
      // art deco: neon parapet band (+ sometimes a stepped crown), as on the generated Ocean Beach blocks
      const neon = lin(pick(NEON));
      const inset = this.offsetPoly(main.poly, -0.05);
      if (inset) this.prism(b, inset, main.top - 1.4, main.top - 1.0, neon, style, flatRoof, 0, 2, neon);
      const crown = this.offsetPoly(main.poly, 0.5);
      if (crown && r() < 0.4) this.prism(b, crown, main.top, main.top + 1.0 + r() * 1.5, wallB, style, flatRoof, 0, 3);
    } else if (R.parts.length === 1 && R.h > 10 && r() < (R.h > 35 ? 0.85 : 0.45)) {
      // rooftop plant room
      const box = this.scalePoly(main.poly, cx, cz, R.h > 35 ? 0.36 : 0.3);
      this.prism(b, box, main.top, main.top + (R.h > 35 ? 3 + r() * 3 : 2.2), lin(0xaaaaaa), 3, lin(0x999999), 0, 3);
    }
  }

  // default roof height when OSM has a shape but no roof:height
  roofH(shape, poly, ph) {
    const W = obb(poly).W;
    const k = [0, 0.3, 0.26, 0.45, 0.5, 0.14, 0.16, 0.3, 0.85, 0.9][shape] || 0.3;
    const h = W * k;
    if (shape === 4 || shape === 8 || shape === 9 || shape === 3) return Math.min(h, ph);
    return Math.min(h, 7, ph * 0.45);
  }

  // pitched / curved roof over `poly` (CCW, xz) from the wall top y1. false = could not be built (caller goes flat)
  irlRoof(b, poly, y1, rh, shape, wc, rc, style) {
    if (rh < 0.25) return false;
    const box = obb(poly);
    const fr = [0, 0, style, 1], fw = [0, 0, style, 3];
    const eave = style === 3 ? 0.45 : 0;
    switch (shape) {
      case 1: case 5: case 7: {
        if (box.fill < 0.72) return this.insetRoof(b, poly, y1, rh, box.W / 2 * 0.97, rc, fr, eave);
        const hw = box.W / 2;
        const prof = shape === 1 ? [[-hw, 0], [0, rh], [hw, 0]]
          : shape === 5 ? [[-hw, rh], [hw, 0]]
            : [-1, -0.866, -0.5, 0, 0.5, 0.866, 1].map((t) => [t * hw, rh * Math.sqrt(Math.max(0, 1 - t * t))]);
        return this.bandRoof(b, poly, y1, box, prof, rc, wc, fr, fw);
      }
      case 2: return this.insetRoof(b, poly, y1, rh, box.W / 2 * 0.97, rc, fr, eave);
      case 6: return this.insetRoof(b, poly, y1, rh, Math.min(box.W / 2 * 0.4, rh * 0.45), rc, fr, 0);
      case 3: case 9: return this.domeRoof(b, poly, y1, rh, [[1, 0], [0, 1]], rc, fr) || this.insetRoof(b, poly, y1, rh, box.W / 2 * 0.97, rc, fr, 0);
      case 4: return this.domeRoof(b, poly, y1, rh, [[1, 0], [0.92, 0.38], [0.71, 0.71], [0.38, 0.92], [0, 1]], rc, fr);
      case 8: return this.domeRoof(b, poly, y1, rh, [[1, 0], [1.12, 0.2], [1.02, 0.42], [0.66, 0.66], [0.28, 0.85], [0, 1]], rc, fr);
    }
    return false;
  }

  // hipped / mansard: slopes from the outline (eave overhang `ov`) up to an inset outline at y1 + rh, flat deck on top
  insetRoof(b, poly, y1, rh, d0, rc, fr, ov = 0) {
    const n = poly.length;
    let d = d0;
    for (let k = 0; k < 6; k++, d *= 0.72) {
      const inner = this.offsetPoly(poly, -d);
      if (!insetOk(poly, inner)) continue;
      const h = rh * Math.min(1, d / d0); // inset had to shrink: keep the slope, flatter deck
      const outer = ov > 0 ? this.offsetPoly(poly, ov) : poly;
      const ye = y1 - (ov > 0 ? ov * h / d : 0);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, a = outer[i], c = outer[j], ai = inner[i], ci = inner[j];
        this.tri(b, [a[0], ye, a[1]], [c[0], ye, c[1]], [ci[0], y1 + h, ci[1]], rc, fr, UP);
        this.tri(b, [a[0], ye, a[1]], [ci[0], y1 + h, ci[1]], [ai[0], y1 + h, ai[1]], rc, fr, UP);
      }
      this.cap(b, inner, y1 + h, rc, fr, UP);
      return true;
    }
    return false;
  }

  // gabled / skillion / barrel: height = profile(d) across the ridge (d along the minor axis of the min-area box).
  // The outline is cut into bands between profile breakpoints (each band is planar); end walls fill up to the roof.
  bandRoof(b, poly, y1, box, prof, rc, wc, fr, fw) {
    const nx = -box.uz, nz = box.ux;
    const dOf = (p) => (p[0] - box.cx) * nx + (p[1] - box.cz) * nz;
    const hOf = (d) => {
      if (d <= prof[0][0]) return prof[0][1];
      for (let k = 1; k < prof.length; k++) if (d <= prof[k][0]) { const [d0, h0] = prof[k - 1], [d1, h1] = prof[k]; return h0 + (h1 - h0) * (d - d0) / Math.max(1e-6, d1 - d0); }
      return prof[prof.length - 1][1];
    };
    let any = false;
    for (let k = 0; k + 1 < prof.length; k++) {
      let piece = poly;
      if (k > 0) piece = clipHalf(piece, (p) => dOf(p) - prof[k][0]);
      if (k + 2 < prof.length) piece = clipHalf(piece, (p) => prof[k + 1][0] - dOf(p));
      if (piece.length < 3) continue;
      let tris;
      try { tris = THREE.ShapeUtils.triangulateShape(piece.map(([x, z]) => new THREE.Vector2(x, z)), []); } catch { tris = []; }
      const P = piece.map((p) => [p[0], y1 + hOf(dOf(p)), p[1]]);
      for (const [i0, i1, i2] of tris) this.tri(b, P[i0], P[i1], P[i2], rc, fr, UP);
      any = any || tris.length > 0;
    }
    if (!any) return false;
    // end walls (gables) between the wall top and the roof surface
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i], c = poly[(i + 1) % n];
      const dx = c[0] - a[0], dz = c[1] - a[1], L = Math.hypot(dx, dz);
      if (L < 0.05) continue;
      const out = [dz / L, 0, -dx / L];
      const da = dOf(a), dc = dOf(c);
      const ts = [0, 1];
      for (const [dk] of prof) if ((dk - da) * (dk - dc) < 0) ts.push((dk - da) / (dc - da));
      ts.sort((x, y) => x - y);
      for (let k = 0; k + 1 < ts.length; k++) {
        const p = [a[0] + dx * ts[k], a[1] + dz * ts[k]], q = [a[0] + dx * ts[k + 1], a[1] + dz * ts[k + 1]];
        const hp = hOf(dOf(p)), hq = hOf(dOf(q));
        if (hp + hq < 0.05) continue;
        if (hq > 0.02) this.tri(b, [p[0], y1, p[1]], [q[0], y1, q[1]], [q[0], y1 + hq, q[1]], wc, fw, out);
        if (hp > 0.02) this.tri(b, [p[0], y1, p[1]], [q[0], y1 + hq, q[1]], [p[0], y1 + hp, p[1]], wc, fw, out);
      }
    }
    return true;
  }

  // pyramid / cone / dome / onion: rings of the outline scaled towards its centroid; profile [[scale, height 0..1]]
  domeRoof(b, poly, y1, rh, prof, rc, fr) {
    const [cx, cz] = polyCentroid(poly);
    const n = poly.length;
    // star-shaped about the centroid, otherwise the rings would cross
    for (let i = 0; i < n; i++) {
      const a = poly[i], c = poly[(i + 1) % n];
      if ((c[0] - a[0]) * (cz - a[1]) - (c[1] - a[1]) * (cx - a[0]) <= 0) return false;
    }
    const ring = (s, h) => poly.map(([x, z]) => [cx + (x - cx) * s, y1 + h * rh, cz + (z - cz) * s]);
    let prev = ring(prof[0][0], prof[0][1]);
    for (let k = 1; k < prof.length; k++) {
      const [s, h] = prof[k];
      const cur = ring(s, h);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const mx = (prev[i][0] + prev[j][0]) / 2 - cx, mz = (prev[i][2] + prev[j][2]) / 2 - cz;
        const want = [mx, 0.25 * Math.hypot(mx, mz), mz];
        this.tri(b, prev[i], prev[j], cur[j], rc, fr, want);
        if (s > 0.001) this.tri(b, prev[i], cur[j], cur[i], rc, fr, want);
      }
      prev = cur;
    }
    return true;
  }

  // triangle with a flat normal; winding flipped so the face looks along `want`
  tri(b, A, B, C, col, fac, want, phys = true) {
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-6) return;
    nx /= l; ny /= l; nz /= l;
    if (nx * want[0] + ny * want[1] + nz * want[2] < 0) { const t = B; B = C; C = t; nx = -nx; ny = -ny; nz = -nz; }
    const base = b.pos.length / 3;
    for (const p of [A, B, C]) {
      b.pos.push(p[0], p[1], p[2]); b.nrm.push(nx, ny, nz); b.col.push(col[0], col[1], col[2]);
      b.fac.push(fac[0], fac[1], fac[2], fac[3]); b.neon.push(0, 0, 0);
    }
    b.idx.push(base, base + 1, base + 2);
    if (phys) {
      const pb = b.phys.length / 3;
      b.phys.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
      b.physIdx.push(pb, pb + 1, pb + 2);
    }
  }

  // flat polygon at height y facing `want` (UP roof deck / DOWN underside)
  cap(b, poly, y, col, fac, want) {
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(poly.map(([x, z]) => new THREE.Vector2(x, z)), []); } catch { return; }
    for (const [i0, i1, i2] of tris) this.tri(b, [poly[i0][0], y, poly[i0][1]], [poly[i1][0], y, poly[i1][1]], [poly[i2][0], y, poly[i2][1]], col, fac, want);
  }

  scalePoly(poly, cx, cz, s) { return poly.map(([x, z]) => [cx + (x - cx) * s, cz + (z - cz) * s]); }

  offsetPoly(poly, d) {
    // simple inward/outward offset via vertex normals (good enough for convex-ish shapes)
    const n = poly.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const p0 = poly[(i - 1 + n) % n], p1 = poly[i], p2 = poly[(i + 1) % n];
      const ax = p1[0] - p0[0], az = p1[1] - p0[1], bx = p2[0] - p1[0], bz = p2[1] - p1[1];
      const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
      const n1x = az / la, n1z = -ax / la, n2x = bz / lb, n2z = -bx / lb;
      let mx = n1x + n2x, mz = n1z + n2z;
      const ml = Math.hypot(mx, mz) || 1;
      mx /= ml; mz /= ml;
      const cosh = Math.max(0.4, mx * n1x + mz * n1z);
      out.push([p1[0] + mx * d / cosh, p1[1] + mz * d / cosh]);
    }
    return out;
  }

  // punch a visible hole into a facade at `p` (world point on the wall), radius in metres
  addHole(p, radius = 1.8) {
    const H = this.uniforms.uHoles.value[this.holeIdx];
    H.set(p.x, p.y, p.z, radius);
    this.holeIdx = (this.holeIdx + 1) % 24;
    this.uniforms.uHoleCount.value = Math.min(24, this.uniforms.uHoleCount.value + 1);
  }

  update(dt, night, camera) {
    this.uniforms.uNight.value = night;
    this.uniforms.uTime.value += dt;
    this.lod(camera);
  }

  // ---------- per-building API (destruction workstream) ----------
  query(x, z, r) {
    const out = [];
    const c = this.cell;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) {
      for (let j = Math.floor((z - r) / c); j <= Math.floor((z + r) / c); j++) {
        const l = this.grid.get(i * 100003 + j);
        if (!l) continue;
        for (const id of l) {
          const rec = this.recs[id];
          if (!rec.removed && Math.hypot(rec.cx - x, rec.cz - z) <= r) out.push(id);
        }
      }
    }
    return out;
  }

  // wall split into bay x floor panels (outside facade + dark interior side); used by fracture()
  panelWall(b, ax, az, bx, bz, L, nx, nz, y0, y1, u0, style, col, vb = y0 + SINK) {
    const nU = Math.max(1, Math.round(L / 3.1)), H = y1 - y0, nV = Math.max(1, Math.round(H / 3.6));
    const v0 = y0 - vb;
    const IN = [0.11, 0.105, 0.1];
    for (let iu = 0; iu < nU; iu++) for (let iv = 0; iv < nV; iv++) {
      const t0 = iu / nU, t1 = (iu + 1) / nU, h0 = (iv / nV) * H, h1 = ((iv + 1) / nV) * H;
      const p0x = ax + (bx - ax) * t0, p0z = az + (bz - az) * t0, p1x = ax + (bx - ax) * t1, p1z = az + (bz - az) * t1;
      const ua = u0 + L * t0, ub = u0 + L * t1;
      const iStart = b.idx.length, vStart = b.pos.length / 3;
      this.quad(b, [p0x, y0 + h0, p0z], [p0x, y0 + h1, p0z], [p1x, y0 + h1, p1z], [p1x, y0 + h0, p1z], [nx, 0, nz], col,
        [ua, v0 + h0, style, 0], [ua, v0 + h1, style, 0], [ub, v0 + h1, style, 0], [ub, v0 + h0, style, 0]);
      // interior face (reverse winding, plain dark concrete)
      this.quad(b, [p1x, y0 + h0, p1z], [p1x, y0 + h1, p1z], [p0x, y0 + h1, p0z], [p0x, y0 + h0, p0z], [-nx, 0, -nz], IN,
        [0, 0, style, 3], [0, 0, style, 3], [0, 0, style, 3], [0, 0, style, 3]);
      this._panels.push({ x: (p0x + p1x) / 2, y: y0 + (h0 + h1) / 2, z: (p0z + p1z) / 2, iStart, iCount: 12, vStart, w: L / nU, h: H / nV, nx, nz, out: false });
    }
  }

  // ---------- real facade destruction ----------
  // The first heavy hit rebuilds the building as its own mesh: walls split into panels (bay x floor) with an
  // interior side, plus floor slabs. Hits knock panels out (see-through holes, drivable openings at street level)
  // and the collider is rebuilt from what is left.
  fracture(id) {
    const r = this.recs[id];
    if (!r || r.removed) return null;
    if (r.frac) return r.frac;
    const o = this.list[id];
    const tb = { key: -1, pos: [], nrm: [], col: [], fac: [], neon: [], idx: [], phys: [], physIdx: [] };
    const realBucket = this.bucketFor;
    this.bucketFor = () => tb;
    this._panels = [];
    try { this.addBuilding(o, id); } finally { this.bucketFor = realBucket; }
    const panels = this._panels;
    this._panels = null;
    // floor slabs every storey, both faces (seen through the holes); IRL massing: per part, up to its wall top
    const slabs = o.irl ? o.irl.parts.map((q) => [q.p, o.y + (q.b > 0.3 ? q.b : 0), o.y + (q._wt ?? q.h)]) : [[o.p, o.y, o.y + o.h]];
    for (const [fp, sy0, sy1] of slabs) {
      const poly = [];
      for (let i = 0; i < fp.length; i += 2) poly.push(new THREE.Vector2(fp[i], fp[i + 1]));
      let tris = [];
      try { tris = THREE.ShapeUtils.triangulateShape(poly, []); } catch { /* skip slabs */ }
      for (let y = sy0 + 3.6; y < sy1 - 0.5; y += 3.6) {
        const base = tb.pos.length / 3;
        for (const v of poly) { tb.pos.push(v.x, y, v.y); tb.nrm.push(0, 1, 0); tb.col.push(0.16, 0.155, 0.15); tb.fac.push(0, 0, o.s, 3); tb.neon.push(0, 0, 0); }
        for (const [a, bb, c] of tris) tb.idx.push(base + a, base + bb, base + c, base + a, base + c, base + bb);
      }
    }
    // build the replacement first, then hide the merged original and swap in one go (never a half state)
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(tb.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(tb.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(tb.col, 3));
    g.setAttribute('aFacade', new THREE.Float32BufferAttribute(tb.fac, 4));
    g.setAttribute('aNeon', new THREE.Float32BufferAttribute(tb.neon, 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(tb.idx), 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const g0 = this.buckets.get(r.key).mesh.geometry.index;
    for (let i = r.iStart; i < r.iEnd; i++) g0.array[i] = 0;
    g0.addUpdateRange(r.iStart, r.iEnd - r.iStart);
    g0.needsUpdate = true;
    this.group.add(mesh);
    r.frac = { mesh, panels, idx0: Uint32Array.from(tb.idx) };
    const c = this.colliders.get(id);
    if (c) { this.world?.removeCollider(c, false); this.colliders.delete(id); }
    return r.frac;
  }

  // knock out wall panels around `p` (world point on/near the facade). Returns removed panels [{x,y,z,w,h,nx,nz}].
  punch(id, p, radius = 2.5) {
    const f = this.fracture(id);
    if (!f || f.external || !f.panels || !f.mesh?.geometry?.index) return []; // external fracture: src/damage/Fracture.js
    const idx = f.mesh.geometry.index;
    const out = [];
    for (const q of f.panels) {
      if (q.out) continue;
      const d = Math.hypot(q.x - p.x, (q.y - p.y) * 0.85, q.z - p.z);
      // ragged outline: some panels at the rim survive, some just beyond go
      const jag = 0.75 + 0.5 * ((Math.sin(q.x * 12.9898 + q.y * 78.233 + q.z * 37.719) * 43758.5453) % 1 + 1) % 1;
      if (d > radius * jag + Math.max(q.w, q.h) * 0.5) continue;
      q.out = true;
      for (let i = q.iStart; i < q.iStart + q.iCount; i++) idx.array[i] = 0;
      idx.addUpdateRange(q.iStart, q.iCount);
      out.push(q);
    }
    if (out.length) {
      idx.needsUpdate = true;
      // rebuild the collider from the remaining geometry (walls + slabs + roof)
      const c = this.colliders.get(id);
      if (c) { this.world?.removeCollider(c, false); this.colliders.delete(id); }
      this.recs[id].fracDirty = true;
    }
    return out;
  }

  info(id) {
    const r = this.recs[id];
    if (!r) return null;
    const o = this.list[id];
    const footprint = [];
    for (let i = 0; i < o.p.length; i += 2) footprint.push([o.p[i], o.p[i + 1]]);
    let area = 0;
    for (let i = 0; i < footprint.length; i++) {
      const [x0, z0] = footprint[i], [x1, z1] = footprint[(i + 1) % footprint.length];
      area += x0 * z1 - x1 * z0;
    }
    const b = this.buckets.get(r.key);
    const col = b.mesh.geometry.attributes.color;
    const color = (Math.round(col.getX(r.vStart) * 255) << 16) | (Math.round(col.getY(r.vStart) * 255) << 8) | Math.round(col.getZ(r.vStart) * 255);
    return {
      id, footprint, base: r.base, height: r.height, top: r.top, style: r.style, floors: r.floors,
      center: { x: r.cx, y: r.base + r.height / 2, z: r.cz }, area: Math.abs(area) / 2, color,
      kind: r.style === 2 || r.style === 5 ? 'tower' : r.style === 3 ? 'house' : r.style === 4 ? 'industrial' : 'block',
      health: r.health, removed: r.removed,
    };
  }

  // has the ground storey lost so many wall panels that the building can't stand any more?
  supportLost(id) {
    const r = this.recs[id];
    const f = r?.frac;
    if (!f || r.removed || !Array.isArray(f.panels)) return false;
    let n = 0, out = 0;
    for (const q of f.panels) if (q.y < r.base + 3.4) { n++; if (q.out) out++; }
    return n > 0 && out / n >= 0.45;
  }

  // The fan map's footprints and its road skeleton disagree here and there: a house standing on a carriageway, a
  // block across a junction or a road median. Hide every footprint whose interior is >= 10 % drawn road surface (or
  // that reaches >= 2.5 m into one). Roads well above the roof (bridges) or below the base (tunnels) don't count,
  // nor do edges without a drawn ribbon (`skip`: runways / airfield pieces the landmarks replace). Run once after
  // the landmarks claimed their footprints. Load time: ~40 ms (one segment-grid gather per building).
  removeOnRoads(roads, skip = null) {
    const grid = roads?.grid, E = roads?.edges, c = roads?.cell || 64;
    if (!grid || !E) return 0;
    const cand = [];
    let n = 0;
    for (let id = 0; id < this.recs.length; id++) {
      const r = this.recs[id];
      if (!r || r.removed) continue;
      const p = this.list[id].p;
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (let i = 0; i < p.length; i += 2) {
        if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
        if (p[i + 1] < z0) z0 = p[i + 1]; if (p[i + 1] > z1) z1 = p[i + 1];
      }
      const y0 = r.base - 6, y1 = (r.peak ?? r.top) + 0.5;
      cand.length = 0;
      for (let ci = Math.floor((x0 - 16) / c), ci1 = Math.floor((x1 + 16) / c); ci <= ci1; ci++) {
        for (let cj = Math.floor((z0 - 16) / c), cj1 = Math.floor((z1 + 16) / c); cj <= cj1; cj++) {
          const l = grid.get(ci * 100003 + cj);
          if (!l) continue;
          for (let q = 0; q < l.length; q += 2) {
            const e = E[l[q]], k = l[q + 1], P = e.pts;
            if (e.tunnel || skip?.has(e.i)) continue;
            const hw = (e.wp ? Math.max(e.wp[k], e.wp[k + 1]) : e.w) / 2;
            const ax = P[2 * k], az = P[2 * k + 1], bx = P[2 * k + 2], bz = P[2 * k + 3];
            if (Math.max(ax, bx) + hw < x0 || Math.min(ax, bx) - hw > x1 || Math.max(az, bz) + hw < z0 || Math.min(az, bz) - hw > z1) continue;
            if (Math.min(e.y[k], e.y[k + 1]) > y1 || Math.max(e.y[k], e.y[k + 1]) < y0) continue;
            cand.push(ax, az, bx, bz, hw);
          }
        }
      }
      if (!cand.length) continue;
      // interior samples on a 1-3 m grid: share on the asphalt and the deepest reach into it
      const st = Math.max(1, Math.min(3, Math.sqrt((x1 - x0) * (z1 - z0)) / 8));
      let tot = 0, hit = 0, pen = 0;
      for (let z = z0 + st / 2; z < z1; z += st) {
        for (let x = x0 + st / 2; x < x1; x += st) {
          if (!pointInPoly(p, x, z)) continue;
          tot++;
          let best = 0;
          for (let i = 0; i < cand.length; i += 5) {
            const ax = cand[i], az = cand[i + 1], dx = cand[i + 2] - ax, dz = cand[i + 3] - az, L2 = dx * dx + dz * dz || 1;
            let t = ((x - ax) * dx + (z - az) * dz) / L2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const inn = cand[i + 4] - Math.hypot(ax + dx * t - x, az + dz * t - z);
            if (inn > best) best = inn;
          }
          if (best > 0.3) { hit++; if (best > pen) pen = best; }
        }
      }
      if (tot && (hit / tot >= 0.1 || (pen >= 2.5 && hit / tot > 0.03)) && this.remove(id)) n++;
    }
    this.stats.onRoads = n;
    return n;
  }

  // Footprints poking into a landmark model (arena facade, tennis bowl, hotel row, water tower legs, airport
  // concourses): hidden when >= 30 m² or >= 15 % of the footprint lies inside one of the landmark's solid colliders
  // (src/landmarks/colliders.js items: 0 = oriented box, 1 = vertical cylinder, 2 = convex hull) and the height
  // ranges overlap. Flat pieces (aprons, runways) and props under 3 m across are ignored. Once, after the landmarks.
  removeUnderLandmarks(items) {
    if (!Array.isArray(items)) return 0;
    let n = 0;
    const poly = [];
    for (const it of items) {
      if (!it || it.reach < 3) continue;
      let y0, y1;
      poly.length = 0;
      if (it.shape === 0) {
        const yaw = 2 * Math.atan2(it.q.y, it.q.w), c = Math.cos(yaw), s = Math.sin(yaw);
        for (const [u, v] of [[-it.a, -it.c], [it.a, -it.c], [it.a, it.c], [-it.a, it.c]]) poly.push(it.x + u * c + v * s, it.z - u * s + v * c);
        y0 = it.y - it.b; y1 = it.y + it.b;
      } else if (it.shape === 1) {
        for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; poly.push(it.x + Math.cos(a) * it.a, it.z + Math.sin(a) * it.a); }
        y0 = it.y - it.b; y1 = it.y + it.b;
      } else if (it.shape === 2 && it.pts) {
        const P = it.pts, xz = [];
        y0 = 1e9; y1 = -1e9;
        for (let i = 0; i < P.length; i += 3) { xz.push([it.x + P[i], it.z + P[i + 2]]); y0 = Math.min(y0, it.y + P[i + 1]); y1 = Math.max(y1, it.y + P[i + 1]); }
        for (const q of hull2(xz)) poly.push(q[0], q[1]);
      } else continue;
      if (y1 - y0 < 2 || poly.length < 6) continue;
      for (const id of this.query(it.x, it.z, it.reach + 60)) {
        const r = this.recs[id];
        if (!r || r.removed || r.top < y0 + 0.5 || r.base > y1 - 0.5) continue;
        const p = this.list[id].p;
        let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
        for (let i = 0; i < p.length; i += 2) {
          if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
          if (p[i + 1] < z0) z0 = p[i + 1]; if (p[i + 1] > z1) z1 = p[i + 1];
        }
        let tot = 0, hit = 0;
        for (let z = z0 + 1; z < z1; z += 2) {
          for (let x = x0 + 1; x < x1; x += 2) {
            if (!pointInPoly(p, x, z)) continue;
            tot++;
            if (pointInPoly(poly, x, z)) hit++;
          }
        }
        if (hit && (hit * 4 >= 30 || hit / tot >= 0.15) && this.remove(id)) n++;
      }
    }
    this.stats.underLandmarks = n;
    return n;
  }

  // Street lamps whose pole would stand inside a footprint (a map building reaching over the sidewalk): dropped
  // from the flat [x, y, z, yaw, ...] list before the Lamps scatter is built, so ids stay consistent everywhere.
  lampsOutside(L) {
    if (!Array.isArray(L) && !ArrayBuffer.isView(L)) return L;
    const out = [];
    let n = 0;
    for (let i = 0; i < L.length; i += 4) {
      const x = L[i], y = L[i + 1], z = L[i + 2];
      let inside = false;
      for (const id of this.query(x, z, 45)) {
        const r = this.recs[id];
        if (r && !r.removed && r.base < y + 6 && r.top > y + 1 && pointInPoly(this.list[id].p, x, z)) { inside = true; break; }
      }
      if (inside) { n++; continue; }
      out.push(L[i], L[i + 1], L[i + 2], L[i + 3]);
    }
    this.stats.lampsInside = n;
    return out;
  }

  // hide a building (render + collider)
  remove(id) {
    const r = this.recs[id];
    if (!r || r.removed) return false;
    r.removed = true;
    if (r.frac?.external) r.frac.dispose?.(); // src/damage/Fracture.js owns its meshes + colliders
    else if (r.frac?.mesh) { this.group.remove(r.frac.mesh); r.frac.mesh.geometry?.dispose(); }
    const g = this.buckets.get(r.key).mesh.geometry;
    const idx = g.index;
    for (let i = r.iStart; i < r.iEnd; i++) idx.array[i] = 0;
    idx.addUpdateRange(r.iStart, r.iEnd - r.iStart);
    idx.needsUpdate = true;
    this._farHide(id);
    const c = this.colliders.get(id);
    if (c) { this.world?.removeCollider(c, false); this.colliders.delete(id); }
    return true;
  }

  // accumulate damage; visually scorches/darkens the building. Returns remaining health.
  damage(id, amount) {
    const r = this.recs[id];
    if (!r || r.removed) return 0;
    r.health = Math.max(0, r.health - amount);
    const k = 0.45 + 0.55 * r.health;
    if (r.frac?.external) { r.frac.tint?.(k); return r.health; }
    if (r.frac) {
      const col = r.frac.mesh?.geometry?.attributes?.color;
      if (!col) return r.health;
      if (!r.frac.baseColors) r.frac.baseColors = col.array.slice();
      for (let i = 0; i < col.array.length; i++) col.array[i] = r.frac.baseColors[i] * k;
      col.needsUpdate = true;
      return r.health;
    }
    const g = this.buckets.get(r.key).mesh.geometry;
    const col = g.attributes.color;
    if (!r.baseColors) r.baseColors = col.array.slice(r.vStart * 3, r.vEnd * 3);
    for (let i = 0; i < r.baseColors.length; i++) col.array[r.vStart * 3 + i] = r.baseColors[i] * k;
    col.addUpdateRange(r.vStart * 3, (r.vEnd - r.vStart) * 3);
    col.needsUpdate = true;
    return r.health;
  }

  // per-building colliders streamed around the player (convex hull when the footprint is convex enough), through
  // src/world/colliderStream.js: the ones within 120 m at once, the rest nearest first within Streaming's per-frame
  // budget (a teleport used to build every building within 350 m in one frame); out of range: removed.
  // flush > 0: build everything in range now (tests, tools).
  updateColliders(RAPIER, world, x, z, radius, groups, flush = 0) {
    this.world = world;
    if (!this.colStream) {
      this.colMs = 0.03; // build cost estimate per building, refined by every build
      this.colStream = new ColliderStream({
        live: this.colliders,
        estimate: () => this.colMs,
        build: (id) => {
          const t0 = performance.now();
          const R = this._colRAPIER;
          const desc = this.colliderDesc(R, id);
          if (!desc) return null;
          desc.setFriction(0.6).setRestitution(0.05)
            .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(15000);
          if (this._colGroups !== undefined) desc.setCollisionGroups(this._colGroups);
          const c = this.world.createCollider(desc);
          c.userData = { building: id };
          this.colMs = this.colMs * 0.9 + 0.1 * (performance.now() - t0);
          return c;
        },
      });
    }
    this._colRAPIER = RAPIER;
    this._colGroups = groups;
    this.colStream.update(world, (visit) => {
      for (const id of this.query(x, z, radius)) { const r = this.recs[id]; visit(id, Math.hypot(r.cx - x, r.cz - z)); }
    }, 120);
    if (flush > 0) this.colStream.step(Infinity);
  }

  colliderDesc(RAPIER, id) {
    const r = this.recs[id];
    if (!r || r.removed || r.frac?.external) return null; // fractured: colliders streamed by src/damage/Fracture.js
    if (r.frac) {
      const g = r.frac.mesh?.geometry;
      if (!g?.index) return null;
      const ia = g.index.array;
      const idx = [];
      for (let i = 0; i < ia.length; i += 3) if (ia[i] !== ia[i + 1]) idx.push(ia[i], ia[i + 1], ia[i + 2]);
      return RAPIER.ColliderDesc.trimesh(g.attributes.position.array, Uint32Array.from(idx));
    }
    const b = this.buckets.get(r.key);
    if (r.convex === undefined) {
      // convexity test: polygon area vs hull area
      const o = this.list[id];
      if (r.foot) {
        // real-world massing: outer (ground-level) outline x full height when it is one even, convex-ish block,
        // else the exact trimesh of the rendered parts (setback towers must not get an invisible full-height podium)
        const hull = hull2d(r.foot.pts);
        r.convex = r.foot.even && hull.length <= 64 && r.foot.area / Math.max(1e-6, polyArea(hull)) > 0.9;
        r.hull = hull;
      } else {
        const pts = [];
        for (let i = 0; i < o.p.length; i += 2) pts.push([o.p[i], o.p[i + 1]]);
        const hull = hull2d(pts);
        r.convex = pts.length <= 12 && polyArea(pts) / Math.max(1e-6, polyArea(hull)) > 0.9;
        r.hull = hull;
      }
    }
    if (r.convex) {
      const pts = new Float32Array(r.hull.length * 6);
      r.hull.forEach(([hx, hz], i) => {
        pts.set([hx, r.base - 2, hz, hx, r.peak ?? r.top, hz], i * 6);
      });
      return RAPIER.ColliderDesc.convexHull(pts);
    }
    if (!b.physVerts) { b.physVerts = new Float32Array(b.phys); b.physIndex = Uint32Array.from(b.physIdx); }
    const verts = b.physVerts.slice(r.pvStart * 3, r.pvEnd * 3);
    const idx = b.physIndex.slice(r.piStart, r.piEnd).map((v) => v - r.pvStart);
    return RAPIER.ColliderDesc.trimesh(verts, idx);
  }
}

function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const [x0, z0] = p[i], [x1, z1] = p[(i + 1) % p.length]; a += x0 * z1 - x1 * z0; }
  return Math.abs(a) / 2;
}

function signedArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const [x0, z0] = p[i], [x1, z1] = p[(i + 1) % p.length]; a += x0 * z1 - x1 * z0; }
  return a / 2;
}

function polyCentroid(p) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, z0] = p[i], [x1, z1] = p[(i + 1) % p.length];
    const c = x0 * z1 - x1 * z0;
    a += c; cx += (x0 + x1) * c; cz += (z0 + z1) * c;
  }
  if (Math.abs(a) < 1e-9) { let x = 0, z = 0; for (const q of p) { x += q[0]; z += q[1]; } return [x / p.length, z / p.length]; }
  return [cx / (3 * a), cz / (3 * a)];
}

// minimum-area bounding rectangle: centre, unit major axis (ux, uz), length L >= width W, fill = area / box area
function obb(poly) {
  const h = hull2d(poly);
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const [ax, az] = h[i], [bx, bz] = h[(i + 1) % h.length];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-6) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of h) {
      const u = x * ux + z * uz, v = -x * uz + z * ux;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const A = (u1 - u0) * (v1 - v0);
    if (!best || A < best.A) best = { A, ux, uz, u0, u1, v0, v1 };
  }
  if (!best) return { cx: poly[0][0], cz: poly[0][1], ux: 1, uz: 0, L: 0, W: 0, fill: 0 };
  let { ux, uz } = best;
  const cu = (best.u0 + best.u1) / 2, cv = (best.v0 + best.v1) / 2;
  const cx = cu * ux - cv * uz, cz = cu * uz + cv * ux;
  let L = best.u1 - best.u0, W = best.v1 - best.v0;
  if (W > L) { [L, W] = [W, L]; [ux, uz] = [-uz, ux]; }
  return { cx, cz, ux, uz, L, W, fill: polyArea(poly) / Math.max(1e-6, best.A) };
}

// Sutherland-Hodgman against one half-plane: keeps points with f(p) >= 0
function clipHalf(poly, f) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], c = poly[(i + 1) % poly.length];
    const fa = f(a), fc = f(c);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fc >= 0)) { const t = fa / (fa - fc); out.push([a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t]); }
  }
  return out;
}

// an inward offset is usable when it kept every edge's direction (no flipped / crossed edges) and stays inside
function insetOk(poly, inner) {
  if (!inner || inner.length !== poly.length) return false;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], c = poly[(i + 1) % n], ai = inner[i], ci = inner[(i + 1) % n];
    const ex = c[0] - a[0], ez = c[1] - a[1];
    if ((ci[0] - ai[0]) * ex + (ci[1] - ai[1]) * ez < -1e-3 * (ex * ex + ez * ez)) return false;
  }
  const a = signedArea(inner);
  return a >= 0 && a < signedArea(poly) && inner.every(([x, z]) => pointIn(x, z, poly));
}

function pointIn(x, z, p) {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, zi] = p[i], [xj, zj] = p[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

function hull2d(points) {
  const p = points.map((q) => q.slice()).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}
