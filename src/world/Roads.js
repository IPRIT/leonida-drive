import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchWeather } from './weatherPatch.js';
import { findRunways } from '../air/runways.js';
import { SIGNAL_UNIFORMS, MAX_SIGNALS } from './fakeLights.js';
import { LAMP_MAP_UNIFORMS, LAMP_MAP_GLSL } from './LampLightMap.js';
import { DECK_COVER_GLSL, deckShadeChunk } from './Terrain.js';
import { ColliderStream } from './colliderStream.js';
import { unpackMeshes } from './geometryTransfer.js';
import { roadMaterials, restoreRoadTerrain } from './worldBuild.js';
import { surfaceTriangle } from './RoadSurface.js';
import { closeRoadCoverage } from './RoadCoverage.js';
import { MARK, CODE, ShapeIndex, classRadius, filletPoints, computeControl, stopBarAt, sidewalkCorners, conformJunctionGround, conformGround, signalSpots, signSpots, junctionIslands, goreDecals, planDeadEnds, deadEnd, ROAD_MARK_GLSL_FUNCS, ROAD_MARK_GLSL_APPLY } from './Junctions.js';

const BUCKET = 768;
const LIFT = 0.07;
const LAMP_STEP = 34;
const KIND = { road: 0, highway: 1, dirt: 2 };
const NONE = [];
const J_GORE = 0.8, J_FILLET = 2.88; // wedge angles (rad): forks below get a nose, straight sides above no kerb return

// Road network: render meshes (markings in shader), bridges, lamp positions, routing graph.
export class Roads {
  constructor(data, terrain, scene, prepared = null) {
    const tBuild = performance.now();
    this.terrain = terrain;
    // kerb-return radii and islands measured on the source map (tools/junction_shapes.py), optional
    this.shapes = new ShapeIndex(data.junctions);
    if (prepared) {
      Object.assign(this, prepared.state);
      this.workerBuildMs = prepared.state.buildMs;
      for (const j of this.junctions) if (j?.plane) {
        const p = j.plane;
        p.at = (x, z) => p.a + p.b * (x - p.nx) + p.c * (z - p.nz);
      }
      restoreRoadTerrain(terrain, prepared.terrain);
    } else {
      const R = data.roads;
      // dead-end classes from the data pipeline (tools/export.py: cds bulbs with radius, water, paved, track, ...)
      this.endInfo = new Map((R.ends || []).map((o) => [o.n, o]));
      this.nodes = R.nodes;
      this.nodeY = R.ny;
      this.edges = R.edges.map((e, i) => {
        const n = e.p.length / 2;
        const pts = new Float32Array(e.p);
        const y = Float32Array.from(e.y);
        const cum = new Float32Array(n);
        for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(pts[2 * k] - pts[2 * k - 2], pts[2 * k + 1] - pts[2 * k - 1]);
        // cl: map road class (tools/map_build.py: 0 highway, 1 arterial, 2 street, 3 track, 4 runway, 5 taxiway); rp: highway
        // ramp / connector; end / cds: dead-end treatment from the data pipeline (water stop, paved blend, cul-de-sac bulb)
        return { i, a: e.a, b: e.b, noSidewalk: !!e.noSidewalk, kind: KIND[e.k], w: e.w, wp: e.wp ? Float32Array.from(e.wp) : null, pts, y, br: e.br ? Uint8Array.from(e.br) : null, len: cum[n - 1], cum, n, cl: e.cl ?? -1, rp: e.rp ?? 0, w0: e.w0 ?? e.w, end: e.end, cds: e.cds };
      });
      // adjacency
      this.adj = this.nodes.map(() => []);
      for (const e of this.edges) {
        this.adj[e.a].push(e.i);
        if (e.b !== e.a) this.adj[e.b].push(e.i);
      }
      this.findTunnels();
      // New datasets solve crossing clearances and approach grades together.
      // Retain the runtime reconstruction only for older maps without levels.
      if (Array.isArray(R.overpasses)) this.overpasses = R.overpasses;
      else this.gradeSeparate();
      this.nodeR = this.nodes.map((_, ni) => Math.max(3, ...this.adj[ni].map((ei) => this.edges[ei].w * 0.5)));
      this.buildSpatialIndex();
      this.computeOneWay();
      this.markAirside();
      this.clampSelfClearance();
      this.lamps = [];
    }
    this.group = new THREE.Group();
    scene.add(this.group);
    // uDead: knocked-down lamps (xz of the head) whose light pool must go out; ring buffer
    this.uniforms = { uNight: { value: 0 }, uLampStep: { value: LAMP_STEP }, uDead: { value: Array.from({ length: 24 }, () => new THREE.Vector2(1e7, 1e7)) }, uDeadN: { value: 0 } };
    this.deadIdx = 0;
    this.material = this.makeMaterial();
    this.bridgeMat = new THREE.MeshStandardMaterial({ color: 0xc9c4ba, roughness: 0.85, flatShading: true });
    this.sidewalkMat = this.makeSidewalkMaterial();
    // embankments / aprons beside the asphalt (see skirt()): drawn with the ground's own look where the terrain
    // provides it, so they read as the ground sloping up to the road, not as a separate material
    this.embankMat = terrain?.surfaceMaterial?.() || new THREE.MeshStandardMaterial({ color: 0x8a7a63, roughness: 1, side: THREE.DoubleSide });
    this.fasciaMat = new THREE.MeshStandardMaterial({ color: 0xc9c4ba, roughness: 0.85, side: THREE.DoubleSide });
    if (prepared) {
      this.tunnelMat = this.makeTunnelMaterial();
      unpackMeshes(prepared.meshes, this.group, roadMaterials(this));
    } else this.buildMeshes();
    this.terrain?.setDeckCovers?.(this.deckCovers());
    this.detailMeshes = this.group.children.filter((m) => m.material === this.sidewalkMat);
    this.buildMs = performance.now() - tBuild; // main-thread build time (perf reports)
  }

  // Boxes under the decks that stand well above the ground (overpass stretches, elevated junction slabs): the
  // sky-occlusion shading of whatever lies beneath them (Terrain.setDeckCovers / DECK_COVER_GLSL)
  deckCovers() {
    const out = [];
    for (const o of this.overpasses || []) {
      const hw = Math.max(4, ...this.adj[o.nj].map((ei) => this.edges[ei].w / 2));
      const low = Math.max(4, ...this.adj[o.ni].map((ei) => this.edges[ei].w / 2));
      out.push({ x: o.x, z: o.z, ux: o.dir[0], uz: o.dir[1], L: 10 + low + 45, W: hw + 0.6, y: this.nodeY[o.nj] + LIFT - 1.35 });
    }
    this.junctions.forEach((J) => {
      if (!J || J.apex === undefined) return;
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, y = 1e9;
      for (const q of J.ring) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[2]); z1 = Math.max(z1, q[2]); y = Math.min(y, q[1]); }
      out.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, ux: 1, uz: 0, L: (x1 - x0) / 2 + 8, W: (z1 - z0) / 2, y: y - 1.35 });
    });
    return out;
  }

  // A hairpin can contain both parallel carriageways in one graph edge. Limit
  // their widths just as we do between separate edges; otherwise the two strips
  // overlap at different grades along the narrow median.
  clampSelfClearance() {
    for (const e of this.edges) {
      if (e.kind !== 1 || e.airside || e.tunnel || e.n < 5) continue;
      const raw = e.wp ? e.wp.slice() : new Float32Array(e.n).fill(e.w);
      let changed = false;
      for (let k = 0; k < e.n; k++) {
        const a = Math.max(0, k - 1), b = Math.min(e.n - 1, k + 1);
        const tx = e.pts[b * 2] - e.pts[a * 2], tz = e.pts[b * 2 + 1] - e.pts[a * 2 + 1], tl = Math.hypot(tx, tz);
        if (!tl) continue;
        for (let j = 0; j < e.n - 1; j++) {
          if (Math.abs(e.cum[k] - (e.cum[j] + e.cum[j + 1]) / 2) < 1.6 * e.w) continue;
          const x = e.pts[j * 2], z = e.pts[j * 2 + 1], dx = e.pts[j * 2 + 2] - x, dz = e.pts[j * 2 + 3] - z;
          const l2 = dx * dx + dz * dz;
          if (!l2 || Math.abs(tx * dx + tz * dz) < 0.85 * tl * Math.sqrt(l2)) continue;
          const t = ((e.pts[k * 2] - x) * dx + (e.pts[k * 2 + 1] - z) * dz) / l2;
          if (t < 0 || t > 1 || Math.abs(e.y[k] - e.y[j] - (e.y[j + 1] - e.y[j]) * t) > 0.6) continue;
          const d = Math.hypot(e.pts[k * 2] - x - dx * t, e.pts[k * 2 + 1] - z - dz * t);
          const width = Math.max(6.5, e.w * 0.6, d - 1.2);
          if (width < raw[k]) { raw[k] = width; changed = true; }
        }
      }
      if (!changed) continue;
      e.wp = raw.slice();
      for (let k = 0; k < e.n; k++) for (let j = Math.max(0, k - 8); j < Math.min(e.n, k + 9); j++) {
        e.wp[k] = Math.min(e.wp[k], raw[j] + Math.abs(e.cum[k] - e.cum[j]) * 0.1);
      }
    }
  }

  buildSpatialIndex() {
    this.cell = 64;
    this.grid = new Map();
    for (const e of this.edges) {
      for (let k = 0; k < e.n - 1; k++) {
        const x0 = e.pts[2 * k], z0 = e.pts[2 * k + 1], x1 = e.pts[2 * k + 2], z1 = e.pts[2 * k + 3];
        const ci0 = Math.floor(Math.min(x0, x1) / this.cell), ci1 = Math.floor(Math.max(x0, x1) / this.cell);
        const cj0 = Math.floor(Math.min(z0, z1) / this.cell), cj1 = Math.floor(Math.max(z0, z1) / this.cell);
        for (let ci = ci0; ci <= ci1; ci++) for (let cj = cj0; cj <= cj1; cj++) {
          const key = ci * 100003 + cj;
          let l = this.grid.get(key);
          if (!l) this.grid.set(key, (l = []));
          l.push(e.i, k);
        }
      }
    }
    // fine index for surface tests (onOtherRoad, sidewalkBlocked): 16 m cells, each segment registered in every cell
    // its carriageway (+0.6 m) touches, so a point query reads one short list
    this.fcell = 16;
    this.fgrid = new Map();
    for (const e of this.edges) {
      const pad = e.w / 2 + 0.6;
      for (let k = 0; k < e.n - 1; k++) {
        const x0 = e.pts[2 * k], z0 = e.pts[2 * k + 1], x1 = e.pts[2 * k + 2], z1 = e.pts[2 * k + 3];
        const ci0 = Math.floor((Math.min(x0, x1) - pad) / 16), ci1 = Math.floor((Math.max(x0, x1) + pad) / 16);
        const cj0 = Math.floor((Math.min(z0, z1) - pad) / 16), cj1 = Math.floor((Math.max(z0, z1) + pad) / 16);
        for (let ci = ci0; ci <= ci1; ci++) for (let cj = cj0; cj <= cj1; cj++) {
          const key = ci * 100003 + cj;
          let l = this.fgrid.get(key);
          if (!l) this.fgrid.set(key, (l = []));
          l.push(e.i, k);
        }
      }
    }
  }

  // Tunnels. The source map leaves a gap where a road dives through a hill, so the road just ends at the slope.
  // Facing dead ends with high ground between them are paired and joined by a tunnel edge: a Hermite curve
  // with a smooth grade, a concrete tube (cut-and-cover gallery where the hill is low, bored tube inside),
  // portals, ceiling lights, and the ground carved out wherever it would poke into the tube.
  findTunnels() {
    const T = this.terrain;
    this.tunnels = [];
    if (!T?.h || !T.heightAt) return;
    const ends = [];
    for (const e of this.edges) {
      if (e.len < 30 || e.br) continue;
      for (const atA of [true, false]) {
        const ni = atA ? e.a : e.b;
        if (this.adj[ni].length !== 1) continue;
        const p = this.pointAt(e, atA ? 0 : e.len), q = this.pointAt(e, atA ? Math.min(25, e.len) : e.len - Math.min(25, e.len));
        let dx = p.x - q.x, dz = p.z - q.z;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l; dz /= l;
        ends.push({ e, ni, x: p.x, z: p.z, y: p.y, dx, dz, used: false });
      }
    }
    const cands = [];
    for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
      const A = ends[i], B = ends[j];
      if (A.e === B.e || (A.e.kind === 2) !== (B.e.kind === 2)) continue;
      const vx = B.x - A.x, vz = B.z - A.z, L = Math.hypot(vx, vz);
      if (L < 60 || L > 1300) continue;
      const ux = vx / L, uz = vz / L;
      const ca = A.dx * ux + A.dz * uz, cb = -(B.dx * ux + B.dz * uz);
      if (ca < 0.88 || cb < 0.88) continue;
      if (Math.abs(A.y - B.y) / L > 0.07) continue; // a tunnel never climbs steeper than 7 % (Mt. Kalaga: 6.6 %)
      let top = -1e9, wet = false;
      for (let k = 1; k < 24; k++) {
        const g = T.heightAt(A.x + vx * (k / 24), A.z + vz * (k / 24));
        top = Math.max(top, g);
        if (g < 0.2) wet = true;
      }
      if (wet || top - Math.max(A.y, B.y) < 14) continue;
      cands.push({ A, B, L, score: L * (3 - ca - cb) });
    }
    cands.sort((a, b) => a.score - b.score);
    for (const c of cands) {
      if (c.A.used || c.B.used) continue;
      c.A.used = c.B.used = true;
      this.addTunnel(c.A, c.B, c.L);
    }
    // cut-outs in the drawn ground (Terrain shader) just inside each mouth
    const holes = [];
    for (const e of this.tunnels) {
      for (const end of [0, 1]) {
        // entirely inside the tube (portal plane to 24 m in, three boxes following the curve), as wide as the
        // inner walls: the ground sloping up from the cut at the mouth to the earth cover above the tube is never
        // seen inside, and the cut edges coincide with the tube's own walls, ceiling and headwall
        for (let k = 0; k < 3; k++) {
          const sa = Math.min(e.len / 2, 8 * k), sb = Math.min(e.len / 2, 8 * k + 8);
          if (sb - sa < 1) continue;
          const A = this.pointAt(e, end ? e.len - sa : sa), B = this.pointAt(e, end ? e.len - sb : sb);
          let ux = B.x - A.x, uz = B.z - A.z;
          const L = Math.hypot(ux, uz) || 1;
          ux /= L; uz /= L;
          holes.push({ x: (A.x + B.x) / 2, z: (A.z + B.z) / 2, ux, uz, L: L / 2 + (k ? 0.6 : 0), W: e.w / 2 + 1.0, y: (A.y + B.y) / 2, g: (B.y - A.y) / L });
        }
        // in front of the mouth, between the wing walls: the ground rising from the approach cut to the earth cover
        // behind the headwall (one 8 m grid cell) is cut away up to above the coping; the box flares with the wing
        // walls (inside them) and the portal's concrete apron floors the cut.
        const P = this.pointAt(e, end ? e.len : 0), sg = end ? -1 : 1, hwO = e.w / 2 + 1.7;
        const ux = P.tx * sg, uz = P.tz * sg;
        const gIn = (this.pointAt(e, end ? e.len - 6 : 6).y - P.y) / 6;
        const sa = -14, sb = 0.02, sm = (sa + sb) / 2;
        holes.push({ x: P.x + ux * sm, z: P.z + uz * sm, ux, uz, L: (sb - sa) / 2, W: hwO + 0.2, flare: 3.0 / 14, top: 11.0, y: P.y + gIn * sm, g: gIn });
      }
    }
    if (holes.length) T.setHoles?.(holes);
  }

  addTunnel(A, B, L) {
    // the traced approach often ends in a small hook (skeleton tip, ~1 m sideways over the last 10 m): lay the
    // last metres onto a smooth curve that meets the portal on the tube's own axis, so the mitred joint is straight
    for (const E of [A, B]) {
      const e = E.e, atA = e.a === E.ni, Ls = Math.min(14, e.len * 0.3);
      const P = this.pointAt(e, atA ? Ls : e.len - Ls);
      const sg = atA ? -1 : 1, m0x = P.tx * sg * Ls, m0z = P.tz * sg * Ls, m1x = E.dx * Ls, m1z = E.dz * Ls;
      for (let k = 0; k < e.n; k++) {
        const d = atA ? e.cum[k] : e.len - e.cum[k];
        if (d <= 0.01 || d >= Ls) continue;
        const u = 1 - d / Ls, u2 = u * u, u3 = u2 * u;
        const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
        e.pts[2 * k] = h00 * P.x + h10 * m0x + h01 * E.x + h11 * m1x;
        e.pts[2 * k + 1] = h00 * P.z + h10 * m0z + h01 * E.z + h11 * m1z;
      }
      for (let k = 1; k < e.n; k++) e.cum[k] = e.cum[k - 1] + Math.hypot(e.pts[2 * k] - e.pts[2 * k - 2], e.pts[2 * k + 1] - e.pts[2 * k - 1]);
      e.len = e.cum[e.n - 1];
    }
    const n = Math.max(6, Math.ceil(L / 7));
    const pts = new Float32Array((n + 1) * 2), y = new Float32Array(n + 1), cum = new Float32Array(n + 1);
    const t0x = A.dx * L * 0.5, t0z = A.dz * L * 0.5, t1x = -B.dx * L * 0.5, t1z = -B.dz * L * 0.5;
    for (let k = 0; k <= n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      pts[2 * k] = h00 * A.x + h10 * t0x + h01 * B.x + h11 * t1x;
      pts[2 * k + 1] = h00 * A.z + h10 * t0z + h01 * B.z + h11 * t1z;
      if (k) cum[k] = cum[k - 1] + Math.hypot(pts[2 * k] - pts[2 * k - 2], pts[2 * k + 1] - pts[2 * k - 1]);
    }
    // floor profile over arc length: each portal continues the approach road's own grade (no crest / sag at the
    // mouth), eases linearly (vertical curve, <= 0.15 % per metre) to one constant interior grade that closes the
    // height difference. End grades against the overall climb are dropped (no hump / dip inside the hill).
    const Lc = cum[n], D = B.y - A.y;
    const gIn = (E) => {
      const atA = E.e.a === E.ni, s = Math.min(10, E.e.len);
      const q = this.pointAt(E.e, atA ? s : E.e.len - s);
      return Math.max(-0.22, Math.min(0.22, (E.y - q.y) / Math.max(1, s)));
    };
    const same = (g) => (g * D < 0 ? 0 : g);
    let g0 = same(gIn(A)), g1 = same(-gIn(B)), gM = D / Lc, La = 0, Lb = 0;
    for (let f = 1; f >= 0; f -= 0.25) {
      const a = g0 * f + (D / Lc) * (1 - f), b = g1 * f + (D / Lc) * (1 - f);
      let m = D / Lc, la = 0, lb = 0;
      for (let it = 0; it < 4; it++) {
        la = Math.min(Lc / 3, Math.max(8, Math.abs(a - m) / 0.0015));
        lb = Math.min(Lc / 3, Math.max(8, Math.abs(b - m) / 0.0015));
        m = (D - (a * la) / 2 - (b * lb) / 2) / (Lc - (la + lb) / 2);
      }
      if (Math.abs(m) <= Math.max(0.075, Math.abs(D / Lc)) && m * D >= 0) { g0 = a; g1 = b; gM = m; La = la; Lb = lb; break; }
    }
    const gAt = (s) => (s < La ? g0 + ((gM - g0) * s) / La : s > Lc - Lb ? gM + ((g1 - gM) * (s - Lc + Lb)) / Lb : gM);
    y[0] = A.y;
    for (let k = 1; k <= n; k++) {
      const s0 = cum[k - 1], s1 = cum[k], h = s1 - s0;
      y[k] = y[k - 1] + (h * (gAt(s0) + 4 * gAt((s0 + s1) / 2) + gAt(s1))) / 6; // Simpson: exact on each piece
    }
    const err = B.y - y[n];
    for (let k = 1; k <= n; k++) y[k] += (err * cum[k]) / Lc; // closes the rounding at the kinks (mm)
    const kind = Math.min(A.e.kind, B.e.kind);
    const e = { i: this.edges.length, a: A.ni, b: B.ni, kind, w: (A.e.w + B.e.w) / 2, wp: null, pts, y, br: null, len: cum[n], cum, n: n + 1, tunnel: true };
    this.edges.push(e);
    this.adj[A.ni].push(e.i);
    this.adj[B.ni].push(e.i);
    this.tunnels.push(e);
    this.carveTunnel(e);
  }

  // Keep the ground out of the tube and give each mouth a proper approach. The terrain is a heightfield on an 8 m
  // grid: a slope between a low vertex and a high one crosses the tube (or the road in front of the portal).
  //  - approach (up to 16 m in front of a portal, between the wing walls): ground cut to 15 cm under the road;
  //  - first 8 m inside, tube wide: cut to the floor - so the slope up to the cover lies inside the tube, where
  //    the Terrain shader cuts the drawn ground away (setHoles) and the tube walls hide it;
  //  - from 12 m inside: drawn ground lifted to >= 8 m above the floor (cut-and-cover earth, no slope crosses);
  //  - physics (Terrain.physOverride): the whole tube strip cut below the floor; a lid trimesh (road colliders)
  //    carries the drawn hill wherever it is >= 3 m above the tube, so cars on the hill above stay on top.
  carveTunnel(e) {
    const T = this.terrain, W = T.gw + 1, hs = T.hs;
    const reach = e.w / 2 + 1 + hs * 1.5, COVER = 8.0, hwO = e.w / 2 + 1.0 + 0.7;
    // portal frame (tunnelPortal): headwall half width WH and top HH, cover just under its coping HT, wings WL long
    const WH = hwO + 3.4, HH = 9.0, HT = 8.7, WL = 14, KS = 0.6;
    let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    for (let k = 0; k < e.n; k++) { const x = e.pts[2 * k], z = e.pts[2 * k + 1]; minx = Math.min(minx, x); maxx = Math.max(maxx, x); minz = Math.min(minz, z); maxz = Math.max(maxz, z); }
    const pad = reach + 18;
    const i0 = Math.max(0, Math.floor((minx - pad - T.x0) / hs)), i1 = Math.min(T.gw, Math.ceil((maxx + pad - T.x0) / hs));
    const j0 = Math.max(0, Math.floor((minz - pad - T.z0) / hs)), j1 = Math.min(T.gh, Math.ceil((maxz + pad - T.z0) / hs));
    const t0 = this.pointAt(e, 0), t1 = this.pointAt(e, e.len);
    const gA = (this.pointAt(e, 6).y - t0.y) / 6, gB = (this.pointAt(e, e.len - 6).y - t1.y) / 6; // floor grade into the tube
    if (!T.physOverride) T.physOverride = new Map();
    const floorAt = new Map(); // vertex index -> tube floor height there (strip vertices)
    let changed = false;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = T.x0 + i * hs, z = T.z0 + j * hs;
      let best = 1e9, by = 0, s = 0;
      for (let k = 0; k < e.n - 1; k++) {
        const ax = e.pts[2 * k], az = e.pts[2 * k + 1], bx = e.pts[2 * k + 2], bz = e.pts[2 * k + 3];
        const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
        const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
        if (d < best) { best = d; by = e.y[k] + (e.y[k + 1] - e.y[k]) * t; s = e.cum[k] + (e.cum[k + 1] - e.cum[k]) * t; }
      }
      // beyond the portals: distance along the tube axis (negative = outside, on the approach) + lateral offset
      let sIn = Math.min(s, e.len - s);
      if (s <= 0.01 || s >= e.len - 0.01) {
        const P = s <= 0.01 ? t0 : t1, sg = s <= 0.01 ? 1 : -1, g = s <= 0.01 ? gA : gB;
        const ux = P.tx * sg, uz = P.tz * sg;
        sIn = (x - P.x) * ux + (z - P.z) * uz;
        best = Math.abs((x - P.x) * -uz + (z - P.z) * ux);
        by = P.y + g * Math.min(0, sIn);
      }
      const idx = j * W + i;
      if (sIn < 0) {
        // approach cut between the wing walls (they flare from the tube to +3 m over 14 m)
        const f = Math.min(1, -sIn / WL);
        if (sIn >= -16 && best <= hwO + 0.2 + 3.0 * f) { if (T.h[idx] > by - 0.15) { T.h[idx] = by - 0.15; changed = true; } }
        else {
          // beside the wings: the bank never towers over the wall tops (no rock-steep face next to the portal)
          const top = sIn >= -WL ? HH + (1.2 - HH) * f : 1.2;
          const cap = by + top + KS * (Math.max(0, best - (hwO + 0.8 + 3.0 * f)) + Math.max(0, -WL - sIn));
          if (T.h[idx] > cap) { T.h[idx] = cap; changed = true; }
        }
      } else {
        // behind the headwall and over the tube: earth cover from the headwall top, sloping no steeper than KS
        // (the old cut behind the mouth left a trench whose back wall showed as rock above the headwall); the drawn
        // ground in front of the mouth is cut away by the terrain holes (setHoles), the physics by physOverride
        const dHead = Math.hypot(Math.max(0, best - WH), Math.max(0, sIn - 1.2));
        const cap = by + HT + KS * dHead, low = by + COVER - KS * Math.max(0, best - (hwO + 1.0));
        if (T.h[idx] < low) { T.h[idx] = low; changed = true; }
        if (T.h[idx] > cap) { T.h[idx] = cap; changed = true; }
      }
      if (sIn >= -2.6 && best <= reach) {
        const prev = T.physOverride.get(idx);
        T.physOverride.set(idx, Math.min(prev ?? T.h[idx], by - 0.6));
        floorAt.set(idx, by);
      }
    }
    if (changed && T.heightTex) T.heightTex.needsUpdate = true;
    // lid: drawn-ground triangles over cut cells that sit well above the tube (same split as the heightfield)
    const lid = [];
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
      const v = [j * W + i, j * W + i + 1, (j + 1) * W + i, (j + 1) * W + i + 1];
      if (!v.every((q) => floorAt.has(q) && T.h[q] >= floorAt.get(q) + 3.0)) continue;
      const P = v.map((q) => [T.x0 + (q % W) * hs, T.h[q], T.z0 + Math.floor(q / W) * hs]);
      lid.push(P[0], P[2], P[1], P[1], P[2], P[3]);
    }
    e.lid = lid;
  }

  // Portal structure at one end of a tube: concrete headwall around the mouth with an overhanging coping, and
  // wing walls flaring along the approach that retain the cut. Drawn with the tube's outer shell; the faces a car
  // can hit join the road physics.
  tunnelPortal(e, row, sg, G, bget) {
    const hwI = e.w / 2 + 1.0, TH = 0.7, hwO = hwI + TH, H1 = 4.8, H2 = 6.8;
    const Hh = 9.0, Wh = hwO + 3.4, WALL = 0.55, WL = 14;
    const ux = row.tx * sg, uz = row.tz * sg; // into the tube
    const rx = -uz, rz = ux; // lateral
    const g = (row.gIn || 0); // floor grade into the tube
    const at = (lat, h, s) => [row.x + rx * lat + ux * s, row.y + h + g * Math.min(0, s), row.z + rz * lat + uz * s];
    const base = () => G.opos.length / 3;
    // triangles facing direction n (world)
    const tri = (A, B, C, n) => {
      const b = base();
      const cx = (B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1]);
      const cy = (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]);
      const cz = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
      G.opos.push(...A, ...B, ...C);
      if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) G.oidx.push(b, b + 1, b + 2); else G.oidx.push(b, b + 2, b + 1);
    };
    const quad = (A, B, C, D, n) => { tri(A, B, C, n); tri(A, C, D, n); };
    const phys = [];
    const pquad = (A, B, C, D) => phys.push(A, B, C, A, C, D);
    const out = [-ux, 0, -uz], up = [0, 1, 0];
    // headwall front face (in the portal plane), with the tube's outer profile as its opening
    const outer = [[-hwI, -0.4], [-hwI, H1], [-hwI + 2.4, H2], [hwI - 2.4, H2], [hwI, H1], [hwI, -0.4]]
      .map(([px, py]) => [px + Math.sign(px) * TH, py < 0 ? py : py + TH]);
    const contour = [[-Wh, -0.8], [Wh, -0.8], [Wh, Hh], [-Wh, Hh]];
    const hole = outer.slice().reverse();
    const v2 = (q) => new THREE.Vector2(q[0], q[1]);
    const pts = [...contour, ...hole];
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour.map(v2), [hole.map(v2)])) {
      const A = at(pts[a][0], pts[a][1], 0), B = at(pts[b][0], pts[b][1], 0), C = at(pts[c][0], pts[c][1], 0);
      tri(A, B, C, out);
      phys.push(A, B, C);
    }
    // headwall sides and top (1.2 m thick into the hill)
    for (const sd of [-1, 1]) quad(at(sd * Wh, -0.8, 0), at(sd * Wh, Hh, 0), at(sd * Wh, Hh, 1.2), at(sd * Wh, -0.8, 1.2), [rx * sd, 0, rz * sd]);
    quad(at(-Wh, Hh, 0), at(Wh, Hh, 0), at(Wh, Hh, 1.2), at(-Wh, Hh, 1.2), up);
    // coping: overhanging beam along the top
    const cW = Wh + 0.3, c0 = Hh - 0.05, c1 = Hh + 0.5, s0 = -0.55, s1 = 1.3;
    quad(at(-cW, c0, s0), at(cW, c0, s0), at(cW, c1, s0), at(-cW, c1, s0), out);
    quad(at(-cW, c1, s0), at(cW, c1, s0), at(cW, c1, s1), at(-cW, c1, s1), up);
    quad(at(-cW, c0, s0), at(cW, c0, s0), at(cW, c0, s1), at(-cW, c0, s1), [0, -1, 0]);
    for (const sd of [-1, 1]) quad(at(sd * cW, c0, s0), at(sd * cW, c1, s0), at(sd * cW, c1, s1), at(sd * cW, c0, s1), [rx * sd, 0, rz * sd]);
    // wing walls: from the headwall at the tube's side out along the approach, flaring 3 m, top falling to 1.2 m
    for (const sd of [-1, 1]) {
      const l0 = sd * (hwO + 0.25), l1 = sd * (hwO + 3.25);
      const iA = at(l0, -0.8, 0), iB = at(l1, -0.8, -WL), iC = at(l1, 1.2, -WL), iD = at(l0, Hh, 0);
      // inner face normal: towards the road (and slightly forward)
      const nIn = [-rx * sd, 0, -rz * sd];
      quad(iA, iB, iC, iD, nIn);
      pquad(iA, iB, iC, iD);
      // thickness: outer face, top, end
      const o = (P, k) => [P[0] + rx * sd * WALL * k, P[1], P[2] + rz * sd * WALL * k];
      const oA = o(iA, 1), oB = o(iB, 1), oC = o(iC, 1), oD = o(iD, 1);
      quad(oA, oB, oC, oD, [rx * sd, 0, rz * sd]);
      quad(iD, iC, oC, oD, up);
      quad(iB, oB, oC, iC, out);
    }
    // concrete apron flooring the cut between the wings, just under the road: the drawn ground above it is cut away
    // (terrain holes in front of the mouth)
    quad(at(-(hwO + 0.3), -0.03, 0.02), at(hwO + 0.3, -0.03, 0.02), at(hwO + 3.3, -0.03, -WL), at(-(hwO + 3.3), -0.03, -WL), up);
    // physics: headwall face + wing inner faces, into the road bucket at the portal
    const b = bget(row.x, row.z);
    if (!b.kpos) { b.kpos = []; b.kidx = []; }
    for (let q = 0; q + 2 < phys.length; q += 3) {
      const k = b.kpos.length / 3;
      b.kpos.push(...phys[q], ...phys[q + 1], ...phys[q + 2]);
      b.kidx.push(k, k + 1, k + 2, k, k + 2, k + 1); // both sides
    }
  }

  // concrete tube: inner faces (dark, lit by ceiling lamps), outer shell, portal frames; walls join physics
  tunnelMesh(e, bget) {
    if (!this.tunnelGeo) this.tunnelGeo = { pos: [], uv: [], idx: [], opos: [], oidx: [] };
    const G = this.tunnelGeo;
    const hw = e.w / 2 + 1.0, H1 = 4.8, H2 = 6.8, TH = 0.7;
    const prof = [[-hw, -0.4], [-hw, H1], [-hw + 2.4, H2], [hw - 2.4, H2], [hw, H1], [hw, -0.4]];
    const outer = prof.map(([px, py]) => [px + Math.sign(px) * TH, py < 0 ? py : py + TH]);
    const np = prof.length;
    const rows = [];
    for (let k = 0; k < e.n; k++) {
      const kp = Math.max(0, k - 1), kn = Math.min(e.n - 1, k + 1);
      let tx = e.pts[2 * kn] - e.pts[2 * kp], tz = e.pts[2 * kn + 1] - e.pts[2 * kp + 1];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      rows.push({ x: e.pts[2 * k], z: e.pts[2 * k + 1], y: e.y[k], rx: -tz, rz: tx, tx, tz, s: e.cum[k] });
    }
    const at = (r, p) => [r.x + r.rx * p[0], r.y + p[1], r.z + r.rz * p[0]];
    const ib = G.pos.length / 3, ob = G.opos.length / 3;
    for (const r of rows) {
      prof.forEach((p, q) => { G.pos.push(...at(r, p)); G.uv.push(r.s, q === 2 || q === 3 ? 1 : 0); });
      outer.forEach((p) => G.opos.push(...at(r, p)));
    }
    for (let k = 0; k < rows.length - 1; k++) for (let q = 0; q < np - 1; q++) {
      const a = ib + k * np + q, b = a + 1, c = a + np, d = c + 1;
      G.idx.push(a, c, b, b, c, d); // inner faces look inwards
      const oa = ob + k * np + q, obb = oa + 1, oc = oa + np, od = oc + 1;
      G.oidx.push(oa, obb, oc, obb, od, oc); // outer shell looks outwards
    }
    // raised walkways between the carriageway edge and the walls (kerb face + top): no open strip at the floor
    const hwR = e.w / 2, KH = 0.25;
    for (const sd of [-1, 1]) {
      const wb = G.pos.length / 3;
      for (const r of rows) {
        for (const [lat, h] of [[sd * hwR, 0.02], [sd * hwR, KH], [sd * hw, KH]]) {
          G.pos.push(r.x + r.rx * lat, r.y + h, r.z + r.rz * lat);
          G.uv.push(r.s, 0);
        }
      }
      const face = (A, B, C, n) => {
        const P = (i) => G.pos.slice(i * 3, i * 3 + 3);
        const a = P(A), b = P(B), c = P(C);
        const cx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), cy = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), cz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) G.idx.push(A, B, C); else G.idx.push(A, C, B);
      };
      for (let k = 0; k < rows.length - 1; k++) {
        const r = rows[k], i0 = wb + k * 3, i1 = i0 + 3;
        const nIn = [-r.rx * sd, 0, -r.rz * sd];
        face(i0, i1, i0 + 1, nIn); face(i1, i1 + 1, i0 + 1, nIn); // kerb face, towards the road
        face(i0 + 1, i1 + 1, i0 + 2, [0, 1, 0]); face(i1 + 1, i1 + 2, i0 + 2, [0, 1, 0]); // walkway top
        const b = bget(r.x, r.z);
        if (!b.kpos) { b.kpos = []; b.kidx = []; }
        const kb = b.kpos.length / 3;
        for (const i of [i0, i0 + 1, i0 + 2, i1, i1 + 1, i1 + 2]) b.kpos.push(G.pos[i * 3], G.pos[i * 3 + 1], G.pos[i * 3 + 2]);
        b.kidx.push(kb, kb + 3, kb + 1, kb + 3, kb + 4, kb + 1, kb + 1, kb + 4, kb + 2, kb + 4, kb + 5, kb + 2);
        b.kidx.push(kb, kb + 1, kb + 3, kb + 3, kb + 1, kb + 4, kb + 1, kb + 2, kb + 4, kb + 4, kb + 2, kb + 5);
      }
    }
    // portal frames (ring between inner and outer profile at both ends)
    for (const r of [rows[0], rows[rows.length - 1]]) {
      const base = G.opos.length / 3;
      prof.forEach((p) => G.opos.push(...at(r, p)));
      outer.forEach((p) => G.opos.push(...at(r, p)));
      for (let q = 0; q < np - 1; q++) G.oidx.push(base + q, base + q + 1, base + np + q, base + q + 1, base + np + q + 1, base + np + q);
      for (let q = 0; q < np - 1; q++) G.oidx.push(base + q, base + np + q, base + q + 1, base + q + 1, base + np + q, base + np + q + 1);
    }
    // headwalls + wing walls at both mouths
    const r0 = rows[0], r1 = rows[rows.length - 1];
    r0.gIn = (this.pointAt(e, 6).y - r0.y) / 6;
    r1.gIn = (this.pointAt(e, e.len - 6).y - r1.y) / 6;
    this.tunnelPortal(e, r0, 1, G, bget);
    this.tunnelPortal(e, r1, -1, G, bget);
    // the lid over the tube's cut strip (carveTunnel) joins the road physics: the hill above stays solid
    for (let q = 0; q + 2 < (e.lid?.length || 0); q += 3) {
      const A = e.lid[q], B = e.lid[q + 1], C = e.lid[q + 2];
      const b = bget(A[0], A[2]);
      if (!b.kpos) { b.kpos = []; b.kidx = []; }
      const base = b.kpos.length / 3;
      b.kpos.push(...A, ...B, ...C);
      // face up (counter-clockwise seen from above)
      const up = (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]) > 0;
      b.kidx.push(base, up ? base + 1 : base + 2, up ? base + 2 : base + 1);
    }
    // walls into the road physics of the bucket around each row pair
    for (let k = 0; k < rows.length - 1; k++) {
      const b = bget(rows[k].x, rows[k].z);
      if (!b.kpos) { b.kpos = []; b.kidx = []; }
      for (const side of [0, 4]) {
        const base = b.kpos.length / 3;
        b.kpos.push(...at(rows[k], prof[side]), ...at(rows[k], prof[side + 1]), ...at(rows[k + 1], prof[side]), ...at(rows[k + 1], prof[side + 1]));
        b.kidx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3, base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }
  }

  buildTunnelMeshes() {
    const G = this.tunnelGeo;
    if (!G) return;
    const inner = new THREE.BufferGeometry();
    inner.setAttribute('position', new THREE.Float32BufferAttribute(G.pos, 3));
    inner.setAttribute('aTun', new THREE.Float32BufferAttribute(G.uv, 2));
    inner.setIndex(G.idx);
    inner.computeVertexNormals();
    inner.computeBoundingSphere();
    const mat = this.tunnelMat = this.makeTunnelMaterial();
    const mi = new THREE.Mesh(inner, mat);
    mi.receiveShadow = false;
    this.group.add(mi);
    const outer = new THREE.BufferGeometry();
    outer.setAttribute('position', new THREE.Float32BufferAttribute(G.opos, 3));
    outer.setIndex(G.oidx);
    const og = outer.toNonIndexed();
    og.computeVertexNormals();
    og.computeBoundingSphere();
    const mo = new THREE.Mesh(og, this.bridgeMat);
    mo.castShadow = true;
    mo.receiveShadow = true;
    this.group.add(mo);
  }

  makeTunnelMaterial() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x8a8780, roughness: 0.9, flatShading: true });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aTun; varying vec2 vTun;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTun = aTun;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vTun;')
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          reflectedLight.directDiffuse *= 0.08; reflectedLight.indirectDiffuse *= 0.3; reflectedLight.directSpecular *= 0.05;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          float lampRow = smoothstep(0.42, 0.5, abs(fract(vTun.x / 12.0) - 0.5));
          totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.86, 0.62) * 0.55;
          totalEmissiveRadiance += vec3(1.0, 0.9, 0.7) * lampRow * step(0.98, vTun.y) * 3.0;`);
    };
    mat.customProgramCacheKey = () => 'tunnel-in-v1';
    return mat;
  }

  // unit direction of an edge leaving node ni, measured ~12 m out (ignores the last-metre wiggle)
  armDir(e, ni) {
    const s = Math.min(12, e.len * 0.5);
    const p = this.pointAt(e, e.a === ni ? s : e.len - s);
    const dx = p.x - this.nodes[ni][0], dz = p.z - this.nodes[ni][1];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  }

  // follow a road away from node ni through straight continuations up to maxLen metres. At 3-way nodes the
  // straight edge continues and the side branch (an on/off ramp) is followed as its own chain.
  walkChain(e0, ni, maxLen, branching = true, d = 0) {
    const steps = [], nodes = [], branches = [];
    let e = e0, from = ni;
    const seen = new Set();
    while (e && !seen.has(e.i) && !e.lifted && (e === e0 || !e.br)) {
      seen.add(e.i);
      const fromA = e.a === from;
      steps.push({ e, fromA, d0: d });
      d += e.len;
      if (d >= maxLen) break;
      const to = fromA ? e.b : e.a;
      const deg = this.adj[to].length;
      if (deg === 2) {
        const nx = this.adj[to].find((ei) => ei !== e.i);
        if (nx === undefined) break;
        nodes.push({ ni: to, d });
        e = this.edges[nx];
        from = to;
        continue;
      }
      if (deg !== 3 || !branching) break;
      // 3-way: continue straight, follow the ramp separately
      const din = this.armDir(e, to);
      let straight = null, best = -0.94;
      for (const ei of this.adj[to]) {
        if (ei === e.i) continue;
        const dd = this.armDir(this.edges[ei], to);
        const c = din[0] * dd[0] + din[1] * dd[1];
        if (c < best) { best = c; straight = ei; }
      }
      if (straight === null) break;
      const side = this.adj[to].find((ei) => ei !== e.i && ei !== straight);
      if (side === undefined || this.edges[side].a === this.edges[side].b) break;
      nodes.push({ ni: to, d });
      branches.push(this.walkChain(this.edges[side], to, maxLen, false, d));
      e = this.edges[straight];
      from = to;
    }
    return { steps, nodes, branches, len: d };
  }

  // Flat highway crossings in the source map become overpasses: the straight highway pair is split off the
  // junction node and lifted onto a bridge with smooth cosine ramps; the cross road stays at grade.
  gradeSeparate() {
    const H = 6.6, RAMP = 140, RAMP_MIN = 70;
    this.overpasses = [];
    const N0 = this.nodes.length;
    for (let ni = 0; ni < N0; ni++) {
      const inc = this.adj[ni];
      if (inc.length !== 4 || inc.some((ei) => this.edges[ei].a === this.edges[ei].b || this.edges[ei].br || this.edges[ei].lifted)) continue;
      const dirs = inc.map((ei) => this.armDir(this.edges[ei], ni));
      let best = null;
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
        if (this.edges[inc[i]].kind !== 1 || this.edges[inc[j]].kind !== 1) continue;
        const c = dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1];
        if (c < -0.94 && (!best || c < best.c)) best = { c, i, j };
      }
      if (!best) continue;
      const others = [0, 1, 2, 3].filter((k) => k !== best.i && k !== best.j);
      const hd = dirs[best.i];
      if (others.some((k) => Math.abs(hd[0] * dirs[k][0] + hd[1] * dirs[k][1]) > 0.6)) continue;
      const flat = 10 + Math.max(...others.map((k) => this.edges[inc[k]].w)) / 2;
      const chains = [best.i, best.j].map((k) => this.walkChain(this.edges[inc[k]], ni, flat + RAMP));
      if (chains.some((c) => c.len < flat + RAMP_MIN)) continue;
      // every ramp branching off the lifted stretch must be long enough to come back down to the ground
      const rampOf = (c) => Math.min(RAMP, c.len - flat);
      if (chains.some((c) => c.branches.some((b) => b.len < flat + rampOf(c) || b.steps.some((st) => st.e.kind === 2)))) continue;
      // lift profile of a chain: the main stretch eases down with a cosine ramp; a ramp branch that leaves a fork
      // doubling back alongside the stretch towards the overpass first follows that stretch's height while they
      // run side by side (no wall between two carriageways at different heights), then eases down to the ground
      const liftOf = (main, ch) => {
        const ramp = Math.min(RAMP, main.len - flat);
        const lift = (d) => (d <= flat ? H : d >= flat + ramp ? 0 : H * 0.5 * (1 + Math.cos((Math.PI * (d - flat)) / ramp)));
        if (ch === main || !ch.steps.length) return lift;
        const st0 = ch.steps[0], dF = st0.d0, fork = st0.fromA ? st0.e.a : st0.e.b;
        const inc = main.steps.find((st) => (st.fromA ? st.e.b : st.e.a) === fork);
        if (!inc) return lift;
        const di = this.armDir(inc.e, fork), db = this.armDir(st0.e, fork);
        if (di[0] * db[0] + di[1] * db[1] < 0.5) return lift;
        const lim = (inc.e.w + st0.e.w) / 2 + 2.5;
        let Lh = 0;
        for (let x = 0; x <= Math.min(60, st0.e.len); x += 2) {
          const p = this.pointAt(st0.e, st0.fromA ? x : st0.e.len - x);
          let best = 1e9;
          for (let k = 0; k < inc.e.n - 1; k++) {
            const ax = inc.e.pts[2 * k], az = inc.e.pts[2 * k + 1], dx = inc.e.pts[2 * k + 2] - ax, dz = inc.e.pts[2 * k + 3] - az;
            const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / (dx * dx + dz * dz || 1)));
            best = Math.min(best, Math.hypot(p.x - ax - dx * t, p.z - az - dz * t));
          }
          if (best > lim) break;
          Lh = x;
        }
        const h0 = lift(dF - Lh), L2 = ch.len - dF - Lh;
        return (d) => {
          const x = d - dF;
          if (x <= Lh) return lift(dF - Math.max(0, x));
          if (L2 <= 1) return 0;
          return x - Lh >= L2 ? 0 : h0 * 0.5 * (1 + Math.cos((Math.PI * (x - Lh)) / L2));
        };
      };
      // reject if the lifted profile would get steeper than 10 % anywhere (overpasses on hillsides)
      let tooSteep = false;
      for (const main of chains) {
        for (const ch of [main, ...main.branches]) for (const st of ch.steps) {
          const lift = liftOf(main, ch);
          const e = st.e;
          for (let k = 0; k < e.n - 1 && !tooSteep; k++) {
            const ds = e.cum[k + 1] - e.cum[k];
            if (ds < 0.5) continue;
            const d0 = st.d0 + (st.fromA ? e.cum[k] : e.len - e.cum[k]), d1 = st.d0 + (st.fromA ? e.cum[k + 1] : e.len - e.cum[k + 1]);
            if (Math.abs(e.y[k + 1] + lift(d1) - e.y[k] - lift(d0)) / ds > 0.1) tooSteep = true;
          }
        }
      }
      if (tooSteep) continue;
      // split: the highway pair moves to a new node one deck higher
      const nj = this.nodes.length;
      this.nodes.push([this.nodes[ni][0], this.nodes[ni][1]]);
      this.nodeY.push(this.nodeY[ni] + H);
      this.adj.push([]);
      for (const k of [best.i, best.j]) {
        const e = this.edges[inc[k]];
        if (e.a === ni) e.a = nj; else e.b = nj;
        this.adj[nj].push(e.i);
      }
      this.adj[ni] = inc.filter((_, k) => k !== best.i && k !== best.j);
      for (const main of chains) {
        for (const ch of [main, ...main.branches]) {
        const lift = liftOf(main, ch);
        for (const st of ch.steps) {
          const e = st.e;
          e.lifted = true;
          if (!e.br) e.br = new Uint8Array(e.n);
          for (let k = 0; k < e.n; k++) {
            const dl = lift(st.d0 + (st.fromA ? e.cum[k] : e.len - e.cum[k]));
            if (dl <= 0) continue;
            e.y[k] += dl;
            if (dl > 0.12) e.br[k] = 1;
          }
        }
        for (const nd of ch.nodes) if (ch === main || nd.d > ch.steps[0].d0) this.nodeY[nd.ni] += lift(nd.d);
        }
      }
      this.overpasses.push({ ni, nj, x: this.nodes[ni][0], z: this.nodes[ni][1], dir: hd });
    }
  }

  // Divided highways: the source map draws each carriageway as its own line. A highway with a parallel
  // carriageway on exactly one side is one-way (right-hand traffic): partner on the left -> flow a->b (+1).
  computeOneWay() {
    const c = this.cell;
    for (const e of this.edges) {
      e.oneway = 0;
      if (e.kind !== 1 || e.len < 24) continue;
      let left = 0, right = 0, samples = 0;
      for (let s = Math.min(6, e.len / 4); s < e.len - 4; s += 15) {
        samples++;
        const p = this.pointAt(e, s);
        const rx = -p.tz, rz = p.tx; // right-hand normal of a->b
        let bestLat = 0, bestAbs = 1e9;
        const ci = Math.floor(p.x / c), cj = Math.floor(p.z / c);
        for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
          const l = this.grid.get(i * 100003 + j);
          if (!l) continue;
          for (let q = 0; q < l.length; q += 2) {
            const f = this.edges[l[q]];
            if (f === e || f.kind !== 1) continue;
            const k = l[q + 1];
            const ax = f.pts[2 * k], az = f.pts[2 * k + 1], bx = f.pts[2 * k + 2], bz = f.pts[2 * k + 3];
            const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
            if (Math.abs((dx * p.tx + dz * p.tz) / L) < 0.92) continue;
            const t = ((p.x - ax) * dx + (p.z - az) * dz) / (L * L);
            if (t < -0.15 || t > 1.15) continue;
            const qx = ax + dx * t - p.x, qz = az + dz * t - p.z;
            const lat = qx * rx + qz * rz;
            const gap = Math.abs(lat) - (e.w + f.w) / 2;
            if (gap < -3 || gap > 30) continue;
            if (Math.abs(lat) < bestAbs) { bestAbs = Math.abs(lat); bestLat = lat; }
          }
        }
        if (bestAbs < 1e9) { if (bestLat < 0) left++; else right++; }
      }
      const hits = left + right;
      if (hits >= Math.max(2, samples * 0.4) && Math.min(left, right) <= Math.max(left, right) * 0.25) e.oneway = left > right ? 1 : -1;
    }
    // carry the flow through plain continuations (degree-2 nodes) into short pieces without a partner
    const into = (f, X) => (f.oneway === 1 && f.b === X) || (f.oneway === -1 && f.a === X);
    const outof = (f, X) => (f.oneway === 1 && f.a === X) || (f.oneway === -1 && f.b === X);
    for (let pass = 0; pass < 6; pass++) {
      let changed = 0;
      for (const e of this.edges) {
        if (e.kind !== 1 || e.oneway || e.a === e.b) continue;
        let vote = 0, bad = false;
        for (const [X, sign] of [[e.a, 1], [e.b, -1]]) {
          if (this.adj[X].length !== 2) continue;
          const f = this.edges[this.adj[X].find((ei) => ei !== e.i)];
          if (!f || !f.oneway) continue;
          const d1 = this.armDir(e, X), d2 = this.armDir(f, X);
          if (d1[0] * d2[0] + d1[1] * d2[1] > -0.7) continue; // not a straight continuation
          const v = into(f, X) ? sign : outof(f, X) ? -sign : 0;
          if (vote && v && v !== vote) bad = true;
          vote = vote || v;
        }
        if (vote && !bad) { e.oneway = vote; changed++; }
      }
      if (!changed) break;
    }
  }

  // Runways and the taxiways/aprons around them are airside: airfield markings, no lamps, no AI traffic.
  markAirside() {
    let runways = [];
    try { runways = findRunways(this) || []; } catch { /* no runways */ }
    this.runways = runways;
    // runway: {cx, cz, dx, dz, len, w} — centre, unit direction, length, width
    const share = (e, lat, ext) => {
      let inside = 0;
      for (let k = 0; k < e.n; k++) {
        const x = e.pts[2 * k], z = e.pts[2 * k + 1];
        for (const r of runways) {
          const t = (x - r.cx) * r.dx + (z - r.cz) * r.dz;
          const d = Math.abs((x - r.cx) * -r.dz + (z - r.cz) * r.dx);
          if (Math.abs(t) < r.len / 2 + ext && d < lat(r)) { inside++; break; }
        }
      }
      return inside / e.n;
    };
    for (const e of this.edges) {
      e.runway = false;
      e.airside = false;
      if (!runways.length) continue;
      e.runway = e.w >= 30 && share(e, (r) => r.w / 2 + 6, 30) > 0.7;
      e.airside = e.runway || share(e, () => 160, 60) > 0.6;
    }
    // runway ends that are real extremities (not joints to the next runway piece) get threshold markings
    for (const e of this.edges) {
      if (!e.runway) continue;
      const isEnd = (ni) => !this.adj[ni].some((ei) => ei !== e.i && this.edges[ei].runway);
      e.rwEnd = [isEnd(e.a) ? 1 : 0, isEnd(e.b) ? 1 : 0];
    }
    // hook: a module may refine the airside flags before lamps / sidewalks / ribbons are decided
    // (src/landmarks marks every taxiway inside an airport as airside)
    Roads.afterAirside?.(this);
  }

  // may a vehicle traverse edge e starting from node `from`?
  allowedFrom(e, from) { return !e.oneway || (e.oneway > 0 ? e.a === from : e.b === from); }

  // nearest point on the network: {edge, seg, t, x, z, y, dist, dir:[dx,dz]}
  nearest(x, z, maxR = 400, filter, maxY = Infinity, minY = -Infinity) {
    let best = null;
    const c = this.cell;
    for (let r = 0; r * c <= maxR + c; r++) {
      const ci = Math.floor(x / c), cj = Math.floor(z / c);
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
        const l = this.grid.get(i * 100003 + j);
        if (!l) continue;
        for (let q = 0; q < l.length; q += 2) {
          const e = this.edges[l[q]], k = l[q + 1];
          if (filter && !filter(e)) continue;
          const ax = e.pts[2 * k], az = e.pts[2 * k + 1], bx = e.pts[2 * k + 2], bz = e.pts[2 * k + 3];
          const dx = bx - ax, dz = bz - az;
          const L2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
          const px = ax + dx * t, pz = az + dz * t;
          const y = e.y[k] + (e.y[k + 1] - e.y[k]) * t;
          if (y > maxY || y < minY) continue;
          const d = Math.hypot(x - px, z - pz);
          if (!best || d < best.dist) {
            const L = Math.sqrt(L2);
            best = { edge: e, seg: k, t, x: px, z: pz, y, dist: d, dir: [dx / L, dz / L] };
          }
        }
      }
      if (best && best.dist < r * c) break;
    }
    return best;
  }

  makeMaterial() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x3c3d41, roughness: 0.88, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 });
    const u = this.uniforms;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u, SIGNAL_UNIFORMS, LAMP_MAP_UNIFORMS, this.terrain?.coverUniforms || {});
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec2 aLane; attribute vec4 aInfo; attribute vec4 aEnd;
          varying vec2 vLane; varying vec4 vInfo; varying vec4 vEnd; varying vec3 vWp;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vLane = aLane; vInfo = aInfo; vEnd = aEnd; vWp = (modelMatrix * vec4(position, 1.0)).xyz;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uNight; uniform float uLampStep;
          ${DECK_COVER_GLSL}
          ${LAMP_MAP_GLSL}
          uniform vec4 uSig[${MAX_SIGNALS}]; uniform vec3 uSigCol[${MAX_SIGNALS}]; uniform float uSigCount;
          varying vec2 vLane; varying vec4 vInfo; varying vec4 vEnd; varying vec3 vWp;
          float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
          float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
            return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x),mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),f.x),f.y); }
          float lineAA(float d, float w){ float fw = fwidth(d) + 1e-4; return 1.0 - smoothstep(w - fw, w + fw, abs(d)); }
          float dashes(float v, float on, float period){ float f = fract(v / period); return step(f, on / period); }
          ${ROAD_MARK_GLSL_FUNCS}
          vec3 gEmissive = vec3(0.0);`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float kind = vInfo.x; float hw = vInfo.y; float noMark = vInfo.z; float lit = vInfo.w;
          float x = vLane.x, v = vLane.y;
          float n = vnoise(vWp.xz * 0.6) * 0.5 + vnoise(vWp.xz * 3.1) * 0.5;
          vec3 asphalt = vec3(0.19, 0.195, 0.205) * (0.86 + 0.24 * n);
          // wheel tracks slightly darker / polished
          float tr = abs(fract((abs(x) + 0.9) / 3.6) - 0.5);
          asphalt *= 0.97 + 0.05 * smoothstep(0.1, 0.3, tr);
          vec3 col = asphalt;
          // lines stop cleanly at junction ends: at the stop bar on the approach half (the double yellow too), after
          // the crosswalk on the departure half; short of a dead end's cap (Junctions.js jCut)
          float owm = (kind > 1.15 && kind < 1.5) ? (kind > 1.32 ? -1.0 : 1.0) : 0.0;
          bool apA = owm == 0.0 ? (x > 0.0 || abs(x) < 0.45) : owm < 0.0;
          bool apB = owm == 0.0 ? (x < 0.0 || abs(x) < 0.45) : owm > 0.0;
          float markOK = (1.0 - noMark) * step(jCut(vEnd.z, apA), vEnd.x) * step(jCut(vEnd.w, apB), vEnd.y);
          if (kind < 0.5) {
            // urban road: double yellow centre, white edges, dashed lane lines on wide roads
            float yel = max(lineAA(x - 0.17, 0.07), lineAA(x + 0.17, 0.07));
            float edge = lineAA(abs(x) - (hw - 0.45), 0.08);
            float lanes = 0.0;
            if (hw > 6.2) lanes = lineAA(abs(x) - hw * 0.5, 0.07) * dashes(v, 3.0, 9.0);
            col = mix(col, vec3(0.86, 0.66, 0.12), yel * markOK);
            col = mix(col, vec3(0.88), max(edge, lanes) * markOK * 0.9);
          } else if (kind < 1.5) {
            float ow = kind > 1.15 ? (kind > 1.32 ? -1.0 : 1.0) : 0.0;
            if (ow != 0.0) {
              // one-way carriageway: yellow line on the median (left) side, white on the right, dashed lanes
              float xl = x * ow;
              float ln = clamp(floor(2.0 * hw / 3.7 + 0.5), 1.0, 4.0);
              float lw = 2.0 * hw / ln;
              float pl = hw - xl;
              float fr = fract(pl / lw);
              float lanes = lineAA(min(fr, 1.0 - fr) * lw, 0.075) * step(lw * 0.5, pl) * step(pl, 2.0 * hw - lw * 0.5) * dashes(v, 3.0, 12.0);
              float yel = lineAA(xl - (hw - 0.55), 0.09);
              float wht = lineAA(xl + (hw - 0.55), 0.09);
              col = mix(col, vec3(0.86, 0.66, 0.12), yel * markOK);
              col = mix(col, vec3(0.9), clamp(lanes + wht, 0.0, 1.0) * markOK * 0.9);
            } else {
              // two-way highway: double yellow centre, dashed lanes per direction, white edges
              float ln = clamp(floor(hw / 3.7 + 0.5), 1.0, 3.0);
              float lw = hw / ln;
              float ax = abs(x);
              float fr = fract(ax / lw);
              float lanes = lineAA(min(fr, 1.0 - fr) * lw, 0.075) * step(lw * 0.5, ax) * step(ax, hw - lw * 0.5) * dashes(v, 3.0, 12.0);
              float yel = max(lineAA(x - 0.18, 0.08), lineAA(x + 0.18, 0.08));
              float edge = lineAA(abs(x) - (hw - 0.55), 0.09);
              col = mix(col, vec3(0.86, 0.66, 0.12), yel * markOK);
              col = mix(col, vec3(0.9), clamp(lanes + edge, 0.0, 1.0) * markOK * 0.9);
            }
            col *= 1.03;
          } else if (kind < 2.5) {
            vec3 dirt = vec3(0.47, 0.38, 0.26) * (0.8 + 0.35 * n);
            float ruts = 1.0 - 0.18 * (lineAA(abs(x) - 0.9, 0.35));
            col = dirt * ruts;
          } else if (kind < 3.5) {
            // taxiway / apron: yellow centreline, no lane dashes
            col = asphalt * 0.92;
            col = mix(col, vec3(0.86, 0.66, 0.12), lineAA(x, 0.15) * 0.9);
            col = mix(col, vec3(0.86, 0.66, 0.12), lineAA(abs(x) - (hw - 0.8), 0.12) * 0.6);
          } else if (kind > 4.5) {
            // painted areas on junction fills (Junctions.js decals): kind 5 = white, 6 = yellow; hw = 1 solid border
            // band, 0 diagonal hatch (islands), 2 chevrons pointing along +v (gore areas); lane = metres
            vec3 pc = kind > 5.5 ? vec3(0.86, 0.66, 0.12) : vec3(0.9);
            float pm = hw > 0.5 && hw < 1.5 ? 1.0 : 0.0;
            if (hw < 0.5) pm = lineAA((fract((x + v) / 2.6) - 0.5) * 2.6, 0.2);
            else if (hw > 1.5) pm = lineAA((fract((v - abs(x)) / 3.0) - 0.5) * 3.0, 0.28);
            col = mix(asphalt, pc, pm * 0.92);
          } else {
            // runway: dashed centreline, side stripes, threshold piano keys + aiming-point blocks at real ends
            col = asphalt * 0.88;
            float cl = lineAA(x, 0.45) * dashes(v, 30.0, 50.0);
            float side = lineAA(abs(x) - (hw - 1.6), 0.45);
            float dA = vEnd.z > 1.5 ? vEnd.x : 1e4, dB = vEnd.w > 1.5 ? vEnd.y : 1e4;
            float dE = min(dA, dB);
            float keys = step(6.0, dE) * step(dE, 36.0) * step(0.45, fract(x / 1.8)) * step(abs(x), hw - 3.0);
            float aim = step(150.0, dE) * step(dE, 195.0) * step(abs(abs(x) - hw * 0.42), hw * 0.12);
            float mark = clamp(cl * step(60.0, dE) + side + keys + aim, 0.0, 1.0);
            col = mix(col, vec3(0.92), mark * 0.92);
          }
          // junction markings: crosswalks, stop bars / yield teeth, turn arrows (src/world/Junctions.js)
          ${ROAD_MARK_GLSL_APPLY}
          // street lamps + signals: shared world-space light map (spills across ribbons, junctions, sidewalks and
          // ground alike, so there are no seams; knocked-down lamps go dark)
          gEmissive = col * lampMapLight(vWp) * 2.4 + lampMapLight(vWp) * uWetness * 0.35;
          diffuseColor.rgb = col;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += gEmissive;
          if (vInfo.w > 1.5) totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.86, 0.62) * (0.35 + 0.8 * exp(-pow(fract(vLane.y / 12.0) - 0.5, 2.0) * 40.0));`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          if (vInfo.w > 1.5) { reflectedLight.directDiffuse *= 0.06; reflectedLight.indirectDiffuse *= 0.3; reflectedLight.directSpecular *= 0.05; }
          ${deckShadeChunk('vWp')}`);
      patchWeather(sh, { worldPos: 'vWp', porosity: 0.35 });
    };
    mat.customProgramCacheKey = () => 'road-v9';
    return mat;
  }

  isUrbanAt(x, z) {
    const G = this.terrain.G;
    const g = this.terrain.groundAt(x, z);
    return g === G.urban || g === G.paved || g === G.building || g === G.sport || g === G.road;
  }

  // trim distances + junction polygons for nodes with >= 3 roads
  // Least-squares plane through a junction: the node and every arm's centreline 3, 6, 9 and 12 m out
  // (tools/export.py fits the same plane to keep the ground under it). y = a + b (x - nx) + c (z - nz).
  junctionPlane(ni) {
    const [nx, nz] = this.nodes[ni];
    const S = [0, 0, 0, 0, 0, 0, 0, 0, 0], r = [0, 0, 0];
    const add = (dx, dz, y, w) => {
      const v = [1, dx, dz];
      for (let i = 0; i < 3; i++) { r[i] += w * v[i] * y; for (let j = 0; j < 3; j++) S[i * 3 + j] += w * v[i] * v[j]; }
    };
    add(0, 0, this.nodeY[ni], 2);
    const pts = [];
    for (const ei of this.adj[ni]) {
      const e = this.edges[ei];
      if (e.a === e.b) continue;
      for (const d of [3, 6, 9, 12]) {
        const s = Math.min(d, e.len * 0.45);
        const p = this.pointAt(e, e.a === ni ? s : e.len - s);
        add(p.x - nx, p.z - nz, p.y, 1);
        pts.push(p);
      }
    }
    S[4] += 5; S[8] += 5; // ridge: arms all along one line leave the cross slope undefined -> level across
    // 3x3 solve (Cramer)
    const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    const D = det(S);
    if (Math.abs(D) < 1e-9) return null;
    const col = (k) => { const m = S.slice(); for (let i = 0; i < 3; i++) m[i * 3 + k] = r[i]; return det(m) / D; };
    const a = col(0), b = col(1), c = col(2);
    const at = (x, z) => a + b * (x - nx) + c * (z - nz);
    let res = Math.abs(at(nx, nz) - this.nodeY[ni]);
    for (const p of pts) res = Math.max(res, Math.abs(at(p.x, p.z) - p.y));
    return { a, b, c, nx, nz, at, res };
  }

  computeJunctions() {
    this.trims = this.edges.map(() => [0, 0]);
    this.endFrame = this.edges.map(() => [null, null]);
    this.junctions = new Array(this.nodes.length);
    for (let ni = 0; ni < this.nodes.length; ni++) {
      // arms: a closed loop (cul-de-sac ring, lollipop) leaves its node twice
      const inc = [];
      for (const ei of this.adj[ni]) {
        const e = this.edges[ei];
        if (e.a === e.b) inc.push([ei, true], [ei, false]); else inc.push([ei, e.a === ni]);
      }
      if (inc.length < 3) continue;
      const [nx, nz] = this.nodes[ni];
      const arms = inc.map(([ei, fromA]) => {
        const e = this.edges[ei];
        const s = Math.min(10, e.len * 0.45);
        const p = this.pointAt(e, fromA ? s : e.len - s);
        let dx = p.x - nx, dz = p.z - nz;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l; dz /= l;
        return { e, fromA, dx, dz, hw: e.w / 2, ang: Math.atan2(dz, dx), t: 0 };
      }).sort((a, b) => a.ang - b.ang);
      const n = arms.length;
      const maxHw = Math.max(...arms.map((a) => a.hw));
      // corners between neighbouring arms: the kerb lines (left edge of A, right edge of B) meet at a sharp corner;
      // the kerb return is a fillet tangent to both, so each arm's trim (= the fill's edge = the tangent point) is
      // the sharp corner's distance plus the fillet's tangent length. Forks narrower than ~45 deg get a blunt nose,
      // wedges of ~165 deg and more (straight sides, outer bends) none.
      // how far each arm may be trimmed before the fill (a plane through the junction, or the node's height) and the
      // arm's own profile part by more than 0.3 m: big kerb returns on graded arms stop there (the end row would
      // have to tilt steeply onto the plane, a crest / step on the arm)
      const plane0 = this.junctionPlane(ni);
      const fit = plane0 && plane0.res <= 0.6 ? plane0 : null;
      for (const a of arms) {
        const lim = a.e.len * 0.45;
        a.tMax = lim;
        // (a kerb return never reaches past ~40 m: scan no further; 1.5 m steps)
        for (let s = 2; s <= Math.min(lim, 40); s += 1.5) {
          const p = this.pointAt(a.e, a.fromA ? s : a.e.len - s);
          const hw = p.w / 2, ex = -p.tz * hw, ez = p.tx * hw;
          const dev = fit ? Math.max(Math.abs(fit.at(p.x + ex, p.z + ez) - p.y), Math.abs(fit.at(p.x - ex, p.z - ez) - p.y)) : Math.abs(this.nodeY[ni] - p.y);
          if (dev > 0.3) { a.tMax = s - 1.5; break; }
        }
      }
      const wedges = [];
      // a highway-only node (diverge / merge): its narrowest wedge (< 95 deg) between two carriageways is a gore
      let goreAt = -1;
      if (arms.every((a) => a.e.kind === 1)) {
        let gMin = 1.66;
        for (let i = 0; i < n; i++) {
          let g = arms[(i + 1) % n].ang - arms[i].ang;
          if (g <= 0) g += Math.PI * 2;
          if (g < gMin) { gMin = g; goreAt = i; }
        }
      }
      for (let i = 0; i < n; i++) {
        const A = arms[i], B = arms[(i + 1) % n];
        let gap = B.ang - A.ang;
        if (gap <= 0) gap += Math.PI * 2;
        // left boundary of A (rotate +90deg) meets right boundary of B (rotate -90deg)
        const lax = -A.dz, laz = A.dx, rbx = B.dz, rbz = -B.dx;
        const px = lax * A.hw, pz = laz * A.hw, qx = rbx * B.hw, qz = rbz * B.hw;
        const den = A.dx * B.dz - A.dz * B.dx;
        let ta, tb;
        if (Math.abs(den) < 0.12) { ta = A.hw; tb = B.hw; } else {
          const wx = qx - px, wz = qz - pz;
          ta = (wx * B.dz - wz * B.dx) / den;
          tb = (wx * A.dz - wz * A.dx) / den;
        }
        const cap = maxHw * 2.5 + 6;
        ta = Math.min(cap, Math.max(ta, 0));
        tb = Math.min(cap, Math.max(tb, 0));
        const W = { gap, Lt: 0, R: 0 };
        if (i === goreAt && Math.abs(den) >= 0.05) {
          // painted gore from where the carriageways' inner edges meet to a nose ~3 m wide (Junctions.js goreDecals)
          const Lg = Math.max(4, Math.min(14, 3.2 / (2 * Math.tan(gap / 2))));
          W.gore = { ta, tb };
          ta += Lg; tb += Lg;
        } else if (gap > J_GORE && gap < J_FILLET && Math.abs(den) >= 0.12) {
          const R = this.cornerRadius(ni, A, B);
          W.Lt = Math.max(0, Math.min(R / Math.tan(gap / 2), 14, A.tMax - ta, B.tMax - tb));
          W.R = W.Lt * Math.tan(gap / 2);
          ta += W.Lt; tb += W.Lt;
          W.tanA = ta; W.tanB = tb; // tangent points' distances from the node (straight-arm model)
        } else if (gap <= J_GORE) {
          // a fork: blunt nose; between two highway carriageways a painted gore from where their edges meet to a
          // nose ~3 m wide (Junctions.js goreDecals)
          ta += 1.0; tb += 1.0;
        }
        wedges.push(W);
        A.t = Math.max(A.t, ta);
        B.t = Math.max(B.t, tb);
      }
      const ring = [];
      for (const a of arms) {
        const lim = a.e.len * 0.45;
        a.t = Math.min(Math.max(a.t + 0.25, a.hw * 0.6 + 1.5), lim);
        const idx = a.e.i;
        this.trims[idx][a.fromA ? 0 : 1] = { t: a.t, xwalk: 0, code: 0 };
        const p = this.pointAt(a.e, a.fromA ? a.t : a.e.len - a.t);
        a.hw = p.w / 2;
        a.ox = a.fromA ? p.tx : -p.tx; a.oz = a.fromA ? p.tz : -p.tz; // outward along the arm at its end row
        // the arm's ribbon ends with exactly these corners (same frame, width and height): no slivers, holes or lips
        const row = this.endRow(a.e, a.fromA ? 0 : 1, p, p.tx, p.tz, 1, a.hw);
        // corners: right of the arm direction first (faces the previous arm), then left
        a.cR = a.fromA ? row.r : row.l;
        a.cL = a.fromA ? row.l : row.r;
        ring.push(a.cR, a.cL, null); // null: placeholder for the kerb return / outer-bend arc after this arm
      }
      // across a wedge wider than 180 deg (the outside of a bending through road, a T's straight side) the chord
      // from one arm's corner to the next cuts inside the carriageway: follow the road edge around the node.
      // Narrower wedges: the kerb return (straight kerb to the tangent point, circular arc, straight kerb).
      const yc = this.nodeY[ni] + LIFT;
      for (let i = 0; i < n; i++) {
        const A = arms[i], B = arms[(i + 1) % n], W = wedges[i];
        const gap = W.gap;
        const arc = [];
        const a0 = A.ang + Math.PI / 2, a1 = A.ang + gap - Math.PI / 2;
        if (a1 > a0 + 0.05) {
          const m = Math.max(1, Math.ceil((a1 - a0) / 0.35));
          for (let k = 0; k <= m; k++) {
            const f = k / m, ang = a0 + (a1 - a0) * f, r = A.hw + (B.hw - A.hw) * f;
            const q = [nx + Math.cos(ang) * r, yc, nz + Math.sin(ang) * r];
            q.arc = true;
            arc.push(q);
          }
        } else if (W.Lt > 0) {
          const pts = this.kerbReturn(A, B, W);
          if (pts) { arc.push(...pts); W.fillet = true; }
        }
        ring.splice(ring.indexOf(null), 1, ...arc);
      }
      for (const a of arms) a.ni = ni;
      // the fill is one plane through the junction (no creases on a slope); the arms' end rows tilt to meet it
      // and blend back to level-across over ~2 widths. Not on decks / lifted ramps or ill-fitting (saddle) nodes.
      let plane = null;
      if (plane0) {
        plane = plane0 !== null ? plane0 : this.junctionPlane(ni); // (same fit as above: arms unchanged)
        if (plane && plane.res > 0.6) plane = null;
      }
      if (plane) {
        for (const a of arms) {
          const f = this.endFrame[a.e.i][a.fromA ? 0 : 1];
          const lift = f.yy - f.py;
          const yl = plane.at(f.l[0], f.l[2]) + lift, yr = plane.at(f.r[0], f.r[2]) + lift;
          f.dl = yl - f.l[1]; f.dr = yr - f.r[1];
          // blend length: >= 2 widths, and long enough that the extra grade stays under ~2 %
          const free = a.e.len - (this.trims[a.e.i][0]?.t || 0) - (this.trims[a.e.i][1]?.t || 0);
          f.tiltD = Math.min(Math.max(12, 2 * a.e.w, (1.5 * Math.max(Math.abs(f.dl), Math.abs(f.dr))) / 0.02), Math.max(0.5, free));
          f.l[1] = yl; f.r[1] = yr;
        }
        for (const q of ring) if (q.arc) q[1] = plane.at(q[0], q[2]) + LIFT;
      }
      const urban = arms.some((a) => a.e.lit) && !arms.every((a) => a.e.kind === 1);
      this.junctions[ni] = { poly: ring, ring, plane, arms: urban ? arms : null, allArms: arms, wedges, urban, center: [nx, this.nodeY[ni], nz] };
    }
    this.computeJoints();
    this.mergeJunctionClusters();
    this.conformNearbyJoints();
    computeControl(this); // who stops where + the ribbon-end marking codes (src/world/Junctions.js)
  }

  // Kerb between arm A's left end-row corner and arm B's right one: A's actual edge (curved arms) in to the tangent
  // point, the fillet (conic tangent to both edges there), B's edge out to its end row. Points [x, y, z] with
  // .arc / .kerb (heights: the arms' design + LIFT, the junction's plane overrides them), or null (chord).
  kerbReturn(A, B, W) {
    const edge = (a, s, side) => {
      const p = this.pointAt(a.e, a.fromA ? s : a.e.len - s);
      const ox = a.fromA ? p.tx : -p.tx, oz = a.fromA ? p.tz : -p.tz, hw = p.w / 2;
      return { x: p.x - oz * hw * side, z: p.z + ox * hw * side, y: p.y + LIFT, ox, oz };
    };
    const tA = Math.min(A.t, W.tanA), tB = Math.min(B.t, W.tanB);
    const EA = edge(A, tA, 1), EB = edge(B, tB, -1);
    const f = filletPoints([EA.x, EA.y, EA.z], [EA.ox, EA.oz], [EB.x, EB.y, EB.z], [EB.ox, EB.oz], 1e9);
    if (!f) return null;
    const out = [];
    const mk = (x, y, z) => { const q = [x, y, z]; q.arc = true; q.kerb = true; out.push(q); };
    const bent = (a, side, s0, s1) => { // edge points between s0 and s1 that sit > 12 cm off the chord
      const P0 = edge(a, s0, side), P1 = edge(a, s1, side), out = [];
      for (let s = s0 + 4 * Math.sign(s1 - s0); (s1 - s) * Math.sign(s1 - s0) > 0.8; s += 4 * Math.sign(s1 - s0)) {
        const q = edge(a, s, side);
        const dx = P1.x - P0.x, dz = P1.z - P0.z, l = Math.hypot(dx, dz) || 1;
        if (Math.abs((q.x - P0.x) * dz - (q.z - P0.z) * dx) / l > 0.12) out.push(q);
      }
      return out;
    };
    for (const q of bent(A, 1, A.t, tA)) mk(q.x, q.y, q.z);
    if (A.t - tA > 0.3) mk(EA.x, EA.y, EA.z);
    for (const [x, z, t] of f) mk(x, EA.y + (EB.y - EA.y) * t, z);
    if (B.t - tB > 0.3) mk(EB.x, EB.y, EB.z);
    for (const q of bent(B, -1, tB, B.t)) mk(q.x, q.y, q.z);
    return out;
  }

  // kerb-return radius of the corner between arms A and B of junction ni: by road class, pulled towards the radius
  // the source map shows there (tools/junction_shapes.py) as far as that measurement is trustworthy
  cornerRadius(ni, A, B) {
    // highway to highway (merges, diverges, forks): no kerb, just a rounded edge
    const target = A.e.kind === 1 && B.e.kind === 1 ? 6 : (classRadius(A.e) + classRadius(B.e)) / 2;
    const [x, z] = this.nodes[ni];
    const m = this.shapes.corner(x, z, A.ang, B.ang);
    let r = target;
    if (m) r = target + (Math.min(m.r, 40) - target) * Math.min(1, m.conf) * 0.85;
    return Math.max(3, Math.min(40, r));
  }

  // the traffic lights' rule (src/world/Traffic.js TrafficLights): >= 3 roads, one of them lit, not all highways
  isSignalised(ni) {
    const adj = this.adj[ni];
    if (adj.length < 3) return false;
    const es = adj.map((ei) => this.edges[ei]);
    return es.some((e) => e.lit) && !es.every((e) => e.kind === 1);
  }

  /** distance from node ni along edge e to the far edge of its stop bar / yield line (null: no stop there) */
  stopDist(e, ni) {
    const end = e.a === ni ? 0 : 1;
    const tr = this.trims[e.i]?.[end];
    if (!tr?.code || !(tr.code & (CODE.STOP | CODE.YIELD))) return null;
    return tr.t + stopBarAt(tr.code)[1];
  }

  // first-segment outward direction + half width of edge e at end (0: a, 1: b)
  endSeg(e, end) {
    let k0 = end ? e.n - 1 : 0, k1 = end ? e.n - 2 : 1;
    while (k1 > 0 && k1 < e.n - 1 && Math.hypot(e.pts[2 * k1] - e.pts[2 * k0], e.pts[2 * k1 + 1] - e.pts[2 * k0 + 1]) < 0.5) k1 += end ? -1 : 1;
    let ux = e.pts[2 * k1] - e.pts[2 * k0], uz = e.pts[2 * k1 + 1] - e.pts[2 * k0 + 1];
    const l = Math.hypot(ux, uz) || 1;
    ux /= l; uz /= l;
    return { ux, uz, hw: (e.wp ? e.wp[k0] : e.w) / 2 };
  }

  // blend the width of edge e towards w over the last L metres before end (0: a, 1: b)
  taperEnd(e, end, w, L) {
    if (!e.wp) e.wp = new Float32Array(e.n).fill(e.w);
    for (let k = 0; k < e.n; k++) {
      const d = end ? e.len - e.cum[k] : e.cum[k];
      if (d >= L) continue;
      let t = d / L;
      t = t * t * (3 - 2 * t);
      e.wp[k] = w + (e.wp[k] - w) * t;
    }
  }

  // Ribbon row at the end of an edge, shared with whatever closes the joint (junction fill, plain joint, cap).
  // (tx, tz): row tangent in the edge's a->b direction; ms: mitre stretch; p: centre {x, z, y, k}.
  endRow(e, end, p, tx, tz, ms, hw, lift) {
    const isB = !!(e.br && e.br[p.k] && e.br[Math.min(p.k + 1, e.n - 1)]);
    const yy = p.y + (lift ?? LIFT) - (e.internal ? 0.012 : 0);
    const nx = -tz, nz = tx;
    const lx = p.x + nx * hw * ms, lz = p.z + nz * hw * ms, rx = p.x - nx * hw * ms, rz = p.z - nz * hw * ms;
    // flat across: the ground under every ribbon is kept >= 5 cm below it by the data pipeline (tools/export.py
    // terrain conform), so rows no longer climb onto the terrain (that tilted lanes and, at tunnel portals, ramped
    // the approach road up onto the cover)
    const f = { tx, tz, ms, hw, lift, l: [lx, yy, lz], r: [rx, yy, rz], yy, py: p.y, isB };
    f.l.row = f.r.row = f;
    this.endFrame[e.i][end] = f;
    return f;
  }

  // Plain joints (two edges meeting at a node) are mitred: both ribbons end with the same row on the bisector, so
  // the asphalt is continuous with no fill disc (a flat disc on a grade stood proud of the ribbons, and bends
  // under ~10 deg had no fill at all - wheels dropped through the wedge). Hairpins (> 90 deg) get a small fill
  // polygon like a junction. Dead ends get a rounded cap instead of a flat cut.
  computeJoints() {
    this.bends = [];
    this.joinTrim = this.edges.map(() => [0, 0]);
    for (let ni = 0; ni < this.nodes.length; ni++) {
      if (this.junctions[ni]) continue;
      const inc = this.adj[ni];
      if (inc.length === 1) {
        const e = this.edges[inc[0]];
        if (e.a === e.b) {
          // a closed ring on its own: mitre its two ends into one row
          const f1 = this.endSeg(e, 0), f2 = this.endSeg(e, 1);
          let tx = f1.ux - f2.ux, tz = f1.uz - f2.uz;
          const tl = Math.hypot(tx, tz) || 1;
          tx /= tl; tz /= tl;
          const ms = 1 / Math.max(0.7, tx * f1.ux + tz * f1.uz);
          const hw = (f1.hw + f2.hw) / 2;
          this.endRow(e, 0, this.pointAt(e, 0), tx, tz, ms, hw).mitre = true;
          this.endRow(e, 1, this.pointAt(e, e.len), tx, tz, ms, hw).mitre = true;
          continue;
        }
        const end = e.a === ni ? 0 : 1;
        const p = this.pointAt(e, end ? e.len : 0);
        this.endRow(e, end, p, p.tx, p.tz, 1, p.w / 2);
        continue;
      }
      if (inc.length !== 2) continue;
      const e1 = this.edges[inc[0]], e2 = this.edges[inc[1]];
      if (e1 === e2 || e1.a === e1.b || e2.a === e2.b) continue;
      const end1 = e1.a === ni ? 0 : 1, end2 = e2.a === ni ? 0 : 1;
      const f1 = this.endSeg(e1, end1), f2 = this.endSeg(e2, end2);
      const c = f1.ux * f2.ux + f1.uz * f2.uz;
      if (c < 0.02) {
        // mitre: tangent of travel e1 -> e2, stretched so the carriageway keeps its width through the bend
        let tx = f2.ux - f1.ux, tz = f2.uz - f1.uz;
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        const ms = 1 / Math.max(0.7, -(tx * f1.ux + tz * f1.uz));
        // different widths meeting at a plain joint (e.g. the two halves of a highway lifted onto an overpass):
        // taper both over 30 m to the mean, or the wider deck would end in an open edge over the narrower one
        if (Math.abs(f1.hw - f2.hw) >= 0.4) {
          const m = (f1.hw + f2.hw) / 2;
          this.taperEnd(e1, end1, m * 2, 30);
          this.taperEnd(e2, end2, m * 2, 30);
          f1.hw = f2.hw = m;
        }
        const hw = (f1.hw + f2.hw) / 2;
        const p1 = this.pointAt(e1, end1 ? e1.len : 0), p2 = this.pointAt(e2, end2 ? e2.len : 0);
        const b1 = !!(e1.br && e1.br[p1.k] && e1.br[Math.min(p1.k + 1, e1.n - 1)]), b2 = !!(e2.br && e2.br[p2.k] && e2.br[Math.min(p2.k + 1, e2.n - 1)]);
        const lift = LIFT; // one surface offset on decks, approaches and junctions
        for (const [e, end, f, p] of [[e1, end1, f1, p1], [e2, end2, f2, p2]]) {
          const edx = end === 0 ? f.ux : -f.ux, edz = end === 0 ? f.uz : -f.uz; // edge direction (a->b) here
          const sg = tx * edx + tz * edz >= 0 ? 1 : -1;
          this.endRow(e, end, p, tx * sg, tz * sg, ms, hw, lift).mitre = true;
        }
        continue;
      }
      // hairpin: trim both arms back to where their inner edges cross and fill between them
      const [nx, nz] = this.nodes[ni];
      const arms = [[e1, end1], [e2, end2]].map(([e, end]) => {
        const s = Math.min(10, e.len * 0.45);
        const p = this.pointAt(e, end ? e.len - s : s);
        let dx = p.x - nx, dz = p.z - nz;
        const l = Math.hypot(dx, dz) || 1;
        return { e, end, dx: dx / l, dz: dz / l, hw: e.w / 2, t: 0 };
      });
      for (const [A, B] of [[arms[0], arms[1]], [arms[1], arms[0]]]) {
        const lax = -A.dz, laz = A.dx, rbx = B.dz, rbz = -B.dx;
        const den = A.dx * B.dz - A.dz * B.dx;
        if (Math.abs(den) < 0.05) { A.t = Math.max(A.t, A.hw); B.t = Math.max(B.t, B.hw); continue; }
        const wx = rbx * B.hw - lax * A.hw, wz = rbz * B.hw - laz * A.hw;
        A.t = Math.max(A.t, Math.min(A.hw * 4 + 6, Math.max(0, (wx * B.dz - wz * B.dx) / den)));
        B.t = Math.max(B.t, Math.min(B.hw * 4 + 6, Math.max(0, (wx * A.dz - wz * A.dx) / den)));
      }
      const ring = [];
      for (const a of arms) {
        a.t = Math.min(a.t + 0.5, a.e.len * 0.45);
        this.joinTrim[a.e.i][a.end] = a.t;
        const p = this.pointAt(a.e, a.end ? a.e.len - a.t : a.t);
        const row = this.endRow(a.e, a.end, p, p.tx, p.tz, 1, p.w / 2);
        ring.push(...(a.end === 0 ? [row.r, row.l] : [row.l, row.r]));
      }
      // A sloped hairpin needs the same planar seam treatment as a junction.
      // A horizontal fan through the node otherwise leaves a wheel-catching lip
      // where its rim meets either graded arm.
      const M = new Array(9).fill(0), rhs = [0, 0, 0];
      const add = (x, y, z, w = 1) => {
        const v = [1, x - nx, z - nz];
        for (let a = 0; a < 3; a++) { rhs[a] += w * v[a] * y; for (let b = 0; b < 3; b++) M[a * 3 + b] += w * v[a] * v[b]; }
      };
      add(nx, this.nodeY[ni], nz, 2);
      for (const q of ring) add(q[0], q[1] - LIFT, q[2]);
      const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
      const D = det(M);
      let cy = this.nodeY[ni] + LIFT, bendPlane = null;
      if (Math.abs(D) > 1e-9) {
        const solve = (k) => { const m = M.slice(); for (let a = 0; a < 3; a++) m[a * 3 + k] = rhs[a]; return det(m) / D; };
        const a = solve(0), b = solve(1), c = solve(2), at = (x, z) => a + b * (x - nx) + c * (z - nz);
        let res = Math.abs(at(nx, nz) + LIFT - cy);
        for (const q of ring) res = Math.max(res, Math.abs(at(q[0], q[2]) + LIFT - q[1]));
        if (res <= 0.6) {
          cy = at(nx, nz) + LIFT;
          bendPlane = { at };
          for (const arm of arms) {
            const f = this.endFrame[arm.e.i][arm.end];
            Object.defineProperty(f, 'plane', { value: bendPlane, enumerable: false, configurable: true });
            const yl = at(f.l[0], f.l[2]) + LIFT, yr = at(f.r[0], f.r[2]) + LIFT;
            f.dl = yl - f.l[1]; f.dr = yr - f.r[1];
            const free = arm.e.len - (this.trims[arm.e.i][0]?.t || 0) - (this.trims[arm.e.i][1]?.t || 0);
            f.tiltD = Math.min(Math.max(12, 2 * arm.e.w, 75 * Math.max(Math.abs(f.dl), Math.abs(f.dr))), Math.max(0.5, free));
            f.l[1] = yl; f.r[1] = yr;
          }
        }
      }
      const bend = { ni, ring, center: [nx, cy - LIFT, nz] };
      // Runtime-only function: debug/worker snapshots must stay cloneable.
      Object.defineProperty(bend, 'plane', { value: bendPlane, enumerable: false });
      this.bends.push(bend);
    }
  }

  // Junctions joined by very short links (dual carriageways, offset T's) form one intersection: the link is drawn
  // as plain asphalt over its full length (no markings, no trims, no sidewalks) underneath both junction
  // polygons, so there are no holes between them, and sidewalk corners never cut across it.
  mergeJunctionClusters() {
    this.clusters = 0;
    const parent = this.nodes.map((_, i) => i);
    const root = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (const e of this.edges) {
      const A = this.junctions[e.a], B = this.junctions[e.b];
      if (!A || !B || e.a === e.b || e.br || e.lifted) continue;
      const lim = Math.max(26, (this.nodeR[e.a] + this.nodeR[e.b]) * 1.5, (this.trims[e.i][0]?.t || 0) + (this.trims[e.i][1]?.t || 0) + e.w + 2);
      if (e.len > lim || Math.abs(this.nodeY[e.a] - this.nodeY[e.b]) > 2) continue;
      const [ax, az] = this.nodes[e.a], [bx, bz] = this.nodes[e.b];
      if (Math.hypot(ax - bx, az - bz) > 45) continue;
      e.internal = true;
      e.intTrim = [this.trims[e.i][0]?.t || 0, this.trims[e.i][1]?.t || 0]; // where the fills' rims cross the link
      this.trims[e.i] = [{ t: 0, xwalk: 0, code: 0 }, { t: 0, xwalk: 0, code: 0 }];
      this.endFrame[e.i] = [null, null]; // runs node to node underneath both fills
      this.clusters++;
      parent[root(e.b)] = root(e.a);
    }
    // Adjacent fills overlap on divided highways. Independent fitted planes make
    // their overlap a physical ledge. Fit one surface for the entire compact
    // intersection, then blend every external arm onto that same plane.
    const clusters = new Map();
    for (let i = 0; i < this.nodes.length; i++) if (this.junctions[i]) {
      const k = root(i); let list = clusters.get(k);
      if (!list) clusters.set(k, (list = [])); list.push(i);
    }
    for (const ids of clusters.values()) {
      if (ids.length < 2 || ids.some((i) => !this.junctions[i].plane)) continue;
      const nx = ids.reduce((s, i) => s + this.nodes[i][0], 0) / ids.length;
      const nz = ids.reduce((s, i) => s + this.nodes[i][1], 0) / ids.length;
      if (ids.some((i) => Math.hypot(this.nodes[i][0] - nx, this.nodes[i][1] - nz) > 140)) continue;
      const M = new Array(9).fill(0), rhs = [0, 0, 0];
      for (const i of ids) for (const q of this.junctions[i].ring) {
        const v = [1, q[0] - nx, q[2] - nz], y = q[1] - LIFT;
        for (let a = 0; a < 3; a++) { rhs[a] += v[a] * y; for (let b = 0; b < 3; b++) M[a * 3 + b] += v[a] * v[b]; }
      }
      const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
      const D = det(M);
      if (Math.abs(D) < 1e-9) continue;
      const solve = (k) => { const m = M.slice(); for (let i = 0; i < 3; i++) m[i * 3 + k] = rhs[i]; return det(m) / D; };
      const a = solve(0), b = solve(1), c = solve(2);
      const at = (x, z) => a + b * (x - nx) + c * (z - nz);
      let res = 0;
      for (const i of ids) for (const q of this.junctions[i].ring) res = Math.max(res, Math.abs(at(q[0], q[2]) + LIFT - q[1]));
      if (res > 2) continue;
      const plane = { a, b, c, nx, nz, at, res };
      for (const i of ids) {
        const J = this.junctions[i]; J.plane = plane;
        for (const arm of J.allArms) {
          const f = arm.cL.row, e = arm.e;
          if (!f) continue;
          const yl = at(f.l[0], f.l[2]) + LIFT, yr = at(f.r[0], f.r[2]) + LIFT;
          f.dl = (f.dl || 0) + yl - f.l[1]; f.dr = (f.dr || 0) + yr - f.r[1];
          const free = e.len - (this.trims[e.i][0]?.t || 0) - (this.trims[e.i][1]?.t || 0);
          f.tiltD = Math.min(Math.max(12, 2 * e.w, 75 * Math.max(Math.abs(f.dl), Math.abs(f.dr))), Math.max(0.5, free));
          f.l[1] = yl; f.r[1] = yr;
        }
        for (const q of J.ring) q[1] = at(q[0], q[2]) + LIFT;
      }
    }
  }

  // Raster graphs sometimes insert a degree-two node inside the neighbouring
  // intersection. Its mitred row must share that intersection's plane too.
  conformNearbyJoints() {
    const contains = (ring, x, z) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a[2] > z) !== (b[2] > z) && x < (b[0] - a[0]) * (z - a[2]) / (b[2] - a[2]) + a[0]) inside = !inside;
      }
      return inside;
    };
    for (let ni = 0; ni < this.nodes.length; ni++) {
      if (this.adj[ni].length !== 2 || this.junctions[ni]) continue;
      const [x, z] = this.nodes[ni], frames = this.adj[ni].map((ei) => {
        const e = this.edges[ei]; return [e, this.endFrame[ei][e.a === ni ? 0 : 1]];
      });
      if (frames.some(([e, f]) => !f || e.tunnel || !f.mitre)) continue;
      const points = [[x, z], ...frames.flatMap(([, f]) => [[f.l[0], f.l[2]], [f.r[0], f.r[2]]])];
      let best = null, distance = Infinity;
      for (const [px, pz] of points) for (const J of this.jList(px, pz)) {
        if (!J.plane || Math.abs(J.plane.at(x, z) - this.nodeY[ni]) > 0.8) continue;
        const d = Math.hypot(J.center[0] - x, J.center[2] - z);
        const reach = Math.max(...frames.map(([e]) => e.w)) * 0.75 + Math.max(...J.allArms.map((a) => a.hw));
        if (!contains(J.ring, px, pz) && d > reach) continue;
        if (d < distance) { best = J.plane; distance = d; }
      }
      if (!best) continue;
      for (const [e, f] of frames) {
        f.plane = best;
        const yl = best.at(f.l[0], f.l[2]) + LIFT, yr = best.at(f.r[0], f.r[2]) + LIFT;
        f.dl = (f.dl || 0) + yl - f.l[1]; f.dr = (f.dr || 0) + yr - f.r[1];
        f.l[1] = yl; f.r[1] = yr;
        const free = e.len - (this.trims[e.i][0]?.t || 0) - (this.trims[e.i][1]?.t || 0);
        f.tiltD = Math.min(Math.max(12, 2 * e.w, 75 * Math.max(Math.abs(f.dl), Math.abs(f.dr))), Math.max(0.5, free));
      }
    }
  }

  // is (x, z) inside a junction polygon (used to keep sidewalks off junction surfaces)
  inJunction(x, z, y) {
    for (const J of this.jList(x, z)) {
      if (Math.abs(J.center[1] - y) > 3) continue;
      const B = J.bb;
      if (x < B[0] || x > B[1] || z < B[2] || z > B[3]) continue;
      const P = J.poly;
      let inside = false;
      for (let a = 0, b = P.length - 1; a < P.length; b = a++) {
        const xa = P[a][0], za = P[a][2], xb = P[b][0], zb = P[b][2];
        if ((za > z) !== (zb > z) && x < ((xb - xa) * (z - za)) / (zb - za) + xa) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  // junction fills whose bounding box touches the 32 m cell of (x, z) (each fill registered in every cell it covers)
  jList(x, z) {
    if (!this.jGrid) {
      this.jGrid = new Map();
      for (const J of this.junctions) {
        if (!J?.poly?.length) continue;
        const B = (J.bb = [1e9, -1e9, 1e9, -1e9]);
        for (const q of J.poly) { B[0] = Math.min(B[0], q[0]); B[1] = Math.max(B[1], q[0]); B[2] = Math.min(B[2], q[2]); B[3] = Math.max(B[3], q[2]); }
        for (let i = Math.floor(B[0] / 32); i <= Math.floor(B[1] / 32); i++) for (let j = Math.floor(B[2] / 32); j <= Math.floor(B[3] / 32); j++) {
          const key = i * 100003 + j;
          if (!this.jGrid.has(key)) this.jGrid.set(key, []);
          this.jGrid.get(key).push(J);
        }
      }
    }
    return this.jGrid.get(Math.floor(x / 32) * 100003 + Math.floor(z / 32)) || NONE;
  }

  // point on the centreline at arc length s: {x, y, z, tx, tz}
  /**
   * Floor height of a tunnel at (x, z), or null outside every tunnel tube (width/2 + margin from its centreline).
   * Cameras use it instead of the terrain, which inside a tunnel is the hill above (a few tunnels: a plain loop).
   */
  tunnelFloorAt(x, z, margin = 2.5) {
    for (const e of this.tunnels) {
      const r = e.w / 2 + margin, pts = e.pts, y = e.y;
      let best = r * r, fy = null;
      for (let k = 0; k < e.n - 1; k++) {
        const ax = pts[2 * k], az = pts[2 * k + 1], bx = pts[2 * k + 2], bz = pts[2 * k + 3];
        const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
        const px = ax + dx * t - x, pz = az + dz * t - z, d2 = px * px + pz * pz;
        if (d2 < best) { best = d2; fy = y[k] + (y[k + 1] - y[k]) * t; }
      }
      if (fy !== null) return fy;
    }
    return null;
  }

  pointAt(e, s) {
    s = Math.max(0, Math.min(e.len, s));
    // first k with cum[k + 1] >= s (binary search; capped at the last segment)
    let lo = 0, hi = e.n - 2;
    while (lo < hi) { const m = (lo + hi) >> 1; if (e.cum[m + 1] < s) lo = m + 1; else hi = m; }
    const k = lo;
    const seg = e.cum[k + 1] - e.cum[k] || 1;
    const t = (s - e.cum[k]) / seg;
    const ax = e.pts[2 * k], az = e.pts[2 * k + 1], bx = e.pts[2 * k + 2], bz = e.pts[2 * k + 3];
    return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, y: e.y[k] + (e.y[k + 1] - e.y[k]) * t, tx: (bx - ax) / seg, tz: (bz - az) / seg, k, w: e.wp ? e.wp[k] + (e.wp[k + 1] - e.wp[k]) * t : e.w };
  }

  buildMeshes() {
    for (const e of this.edges) {
      // lamps / urban decision
      let urban = 0, samples = 0;
      for (let k = 0; k < e.n - 1; k += 2) {
        const dx = e.pts[2 * k + 2] - e.pts[2 * k], dz = e.pts[2 * k + 3] - e.pts[2 * k + 1];
        const L = Math.hypot(dx, dz) || 1;
        const o = e.w / 2 + 6;
        for (const sd of [-1, 1]) {
          samples++;
          if (this.isUrbanAt(e.pts[2 * k] - (dz / L) * o * sd, e.pts[2 * k + 1] + (dx / L) * o * sd)) urban++;
        }
      }
      samples = Math.max(1, samples);
      const lit = !e.airside && !e.tunnel && e.kind !== 2 && (urban / samples > 0.35 || (e.kind === 1 && urban / samples > 0.15)) ? 1 : 0;
      e.lit = lit;
      // kerbs + sidewalks on every street with some built-up surroundings (suburbs included), not only lit ones
      e.sw = e.kind === 0 && !e.airside && !e.tunnel && urban / samples > 0.12;
    }
    this.computeJunctions();
    // the ground under the (larger) kerb-returned fills and their tilting arms (src/world/Junctions.js)
    planDeadEnds(this); // cul-de-sac bulbs: centre and radius, before the ground is lowered under them
    this.groundLowered = conformJunctionGround(this, LIFT);
    // street furniture spots: signal poles on the kerbed corners, stop signs at stop-controlled approaches
    this.signalSpots = signalSpots(this, LIFT);
    this.signSpots = signSpots(this, LIFT);
    const buckets = new Map();
    const bget = (x, z) => {
      const key = Math.floor(x / BUCKET) * 1000 + Math.floor(z / BUCKET);
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { key, pos: [], lane: [], info: [], end: [], idx: [] }));
      return b;
    };
    for (const e of this.edges) {
      // hook: an edge a module draws itself or hides (src/landmarks: runways as exact rectangles, stray airfield
      // pieces) gets no ribbon, collider or lamps; it stays in the graph (routing, airside flags, plane spawns)
      if (Roads.skipRibbon?.(e, this)) continue;
      const lit = e.lit;
      this.ribbon(e, bget, lit);
      if (lit && !e.internal) this.placeLamps(e);
    }
    sidewalkCorners(this, bget, LIFT); // kerbed corners following the kerb returns (src/world/Junctions.js)
    junctionIslands(this, bget, LIFT); // islands from the source map: raised + kerbed, or painted where turns cross
    this.gores = goreDecals(this, bget, LIFT); // painted gore areas where highway carriageways fork
    for (const e of this.tunnels || []) this.tunnelMesh(e, bget);
    this.buildTunnelMeshes();
    // junction fills (degree >= 3), hairpin fills and rounded dead-end caps. Their rims are the arms' own end rows
    // (computeJunctions / computeJoints), so asphalt, fills and colliders meet vertex to vertex. Plain joints are
    // mitred and need no fill.
    const fan = (b, c, ring, kind) => {
      const base = b.pos.length / 3;
      const push = (q) => { b.pos.push(q[0], q[1], q[2]); b.lane.push(0, 0); b.info.push(kind, 30, 1, 0); b.end.push(99, 99, 0, 0); };
      const n = ring.length;
      const cr = (o, p, q) => (p[2] - o[2]) * (q[0] - o[0]) - (p[0] - o[0]) * (q[2] - o[2]); // > 0: faces up
      const tri = (i, j, k, P) => (cr(P[i], P[j], P[k]) > 0 ? b.idx.push(base + i, base + j, base + k) : b.idx.push(base + i, base + k, base + j));
      // fan from the node when the rim is star-shaped around it (smooth crown at the node height); otherwise
      // (arms all on one side, reflex gaps > 180 deg) the node lies outside: triangulate the rim polygon itself
      let sg = 0, star = true;
      for (let i = 0; i < n && star; i++) {
        const v = cr(c, ring[i], ring[(i + 1) % n]);
        const scale = Math.hypot(ring[i][0] - c[0], ring[i][2] - c[2]) * Math.hypot(ring[(i + 1) % n][0] - c[0], ring[(i + 1) % n][2] - c[2]);
        if (Math.abs(v) < 0.02 * scale) { star = false; break; }
        if (!sg) sg = Math.sign(v); else if (Math.sign(v) !== sg) star = false;
      }
      if (star) {
        const P = [c, ...ring];
        P.forEach(push);
        for (let i = 0; i < n; i++) tri(0, 1 + i, 1 + ((i + 1) % n), P);
        return;
      }
      ring.forEach(push);
      const tris = THREE.ShapeUtils.triangulateShape(ring.map((q) => new THREE.Vector2(q[0], q[2])), []);
      for (const [i, j, k] of tris) tri(i, j, k, ring);
    };
    const kindAt = (ni) => Math.min(...this.adj[ni].map((ei) => (this.edges[ei].kind === 2 ? 2 : 0)));
    for (let ni = 0; ni < this.nodes.length; ni++) {
      const J = this.junctions[ni];
      const deg = this.adj[ni].length;
      if (!deg) continue;
      if (Roads.skipRibbon && this.adj[ni].every((ei) => Roads.skipRibbon(this.edges[ei], this))) continue; // only hidden arms
      const [x, z] = this.nodes[ni];
      if (J) {
        // fill apex: the plane; an elevated junction between decks / lifted ramps has none (their end rows keep
        // their own heights): apex at the mean of its rim, not the node's own height (a tent with 0.4 m creases),
        // and its arm strips follow that fan (J.apex)
        let cy = (J.plane ? J.plane.at(x, z) : J.center[1]) + LIFT;
        if (!J.plane && J.allArms.some((a) => a.e.lifted || this.endFrame[a.e.i][a.fromA ? 0 : 1]?.isB) && J.center[1] - this.terrain.heightAt(x, z) > 1.5) {
          cy = J.ring.reduce((t, q) => t + q[1], 0) / J.ring.length;
          J.apex = cy;
        }
        fan(bget(x, z), [J.center[0], cy, J.center[2]], J.ring, kindAt(ni));
      } else if (deg === 1) {
        // rounded cap: a half disc beyond the last row instead of a flat cut across the carriageway
        const e = this.edges[this.adj[ni][0]];
        const end = e.a === ni ? 0 : 1;
        const f = this.endFrame[e.i][end];
        if (!f || e.a === e.b || e.airside || e.runway || e.tunnel) continue;
        // classified dead ends (cul-de-sac bulb, water stop, paved blend: src/world/Junctions.js)
        if (deadEnd(this, ni, bget, LIFT, kindAt(ni))) continue;
        const ox = end ? f.tx : -f.tx, oz = end ? f.tz : -f.tz;
        const cx = (f.l[0] + f.r[0]) / 2, cz = (f.l[2] + f.r[2]) / 2, cy = (f.l[1] + f.r[1]) / 2;
        let lx = f.l[0] - cx, lz = f.l[2] - cz;
        const R = Math.hypot(lx, lz) || 1;
        lx /= R; lz /= R;
        const ring = [f.l];
        for (let k = 1; k < 8; k++) {
          const t = (k / 8) * Math.PI;
          ring.push([cx + (Math.cos(t) * lx + Math.sin(t) * ox) * R, cy, cz + (Math.cos(t) * lz + Math.sin(t) * oz) * R]);
        }
        ring.push(f.r);
        // open fan (no closing triangle between r and l: that edge is the ribbon's end row)
        const b = bget(x, z), base = b.pos.length / 3, kind = kindAt(ni);
        const push = (q) => { b.pos.push(q[0], q[1], q[2]); b.lane.push(0, 0); b.info.push(kind, 30, 1, 0); b.end.push(99, 99, 0, 0); };
        push([cx, cy, cz]);
        ring.forEach(push);
        for (let i = 0; i < ring.length - 1; i++) {
          const p = ring[i], q = ring[i + 1];
          const up = (p[2] - cz) * (q[0] - cx) - (p[0] - cx) * (q[2] - cz) > 0;
          b.idx.push(base, base + 1 + (up ? i : i + 1), base + 1 + (up ? i + 1 : i));
        }
      }
    }
    for (const B of this.bends || []) fan(bget(B.center[0], B.center[2]), [B.center[0], B.center[1] + LIFT, B.center[2]], B.ring, kindAt(B.ni));
    // embankment aprons along the rims of junction fills - every rim chord / arc, not the arms' end rows (the
    // ribbons continue there). Under a sidewalk corner the apron is hidden; beside it (outer-bend arcs, corners
    // without a sidewalk piece) it catches a car cutting the corner.
    for (let ni = 0; ni < this.nodes.length; ni++) {
      const J = this.junctions[ni];
      if (!J || !J.ring?.length) continue;
      if (J.allArms.some((a) => a.e.tunnel)) continue;
      const ring = J.ring, n = ring.length, c = J.center, b = bget(c[0], c[2]);
      // a fill between decks / lifted ramps well above the ground (interchange) is a slab of the bridge: concrete
      // fascia along the rim and an underside, like the decks around it
      const deck = J.allArms.some((a) => a.e.lifted || this.endFrame[a.e.i][a.fromA ? 0 : 1]?.isB) && c[1] - this.terrain.heightAt(c[0], c[2]) > 1.5;
      if (deck && !b.fpos) { b.fpos = []; b.fidx = []; }
      if (deck && !b.bpos) { b.bpos = []; b.bidx = []; b.ppos = []; b.pidx = []; b.pillars = []; }
      const own = new Set(J.allArms.map((a) => a.e));
      const outN = (p, q) => {
        const L = Math.hypot(q[0] - p[0], q[2] - p[2]) || 1;
        let nx = (q[2] - p[2]) / L, nz = -(q[0] - p[0]) / L;
        if (nx * ((p[0] + q[0]) / 2 - c[0]) + nz * ((p[2] + q[2]) / 2 - c[2]) < 0) { nx = -nx; nz = -nz; }
        return [nx, nz];
      };
      // lateral (outward) direction of an end-row corner: from the row's centre to the corner
      const latN = (p) => {
        const f = p.row, mx = (f.l[0] + f.r[0]) / 2, mz = (f.l[2] + f.r[2]) / 2;
        const L = Math.hypot(p[0] - mx, p[2] - mz) || 1;
        return [(p[0] - mx) / L, (p[2] - mz) / L];
      };
      // fan of directions from u to v (shorter way), <= 30 deg apart
      const fanDirs = (u, v) => {
        const a0 = Math.atan2(u[1], u[0]);
        let d = Math.atan2(v[1], v[0]) - a0;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        const m = Math.ceil(Math.abs(d) / 0.8), out = [];
        for (let k = 1; k < m; k++) out.push([Math.cos(a0 + (d * k) / m), Math.sin(a0 + (d * k) / m)]);
        return out;
      };
      // the rim splits into runs between end rows: chords + outer-bend arcs, from one arm's corner to the next
      let start0 = -1;
      for (let i = 0; i < n; i++) if (ring[i].row && ring[(i + n - 1) % n].row === ring[i].row) { start0 = i; break; }
      const runs = [];
      if (start0 < 0) runs.push([...ring, ring[0]]);
      else {
        let cur = [ring[start0]];
        for (let k = 1; k <= n; k++) {
          const p = ring[(start0 + k) % n], prev = cur[cur.length - 1];
          if (prev.row && p.row === prev.row) { if (cur.length > 1) runs.push(cur); cur = [p]; } else cur.push(p);
        }
        if (cur.length > 1) runs.push(cur);
      }
      for (const run of runs) {
        // a kerbed sidewalk corner covers this run (Junctions.sidewalkCorners: its own apron runs along its outer edge)
        if (!deck && run[0].swCorner) continue;
        if (deck) {
          // deck depth and parapet as on the bridge decks (bridgeDeck): 1.35 m fascia, 0.95 m wall, inner face
          // in the physics so nobody drives off the slab
          const PH = 0.95, PT = 0.32;
          for (let i = 1; i < run.length; i++) {
            const p = run[i - 1], q = run[i];
            const L = Math.hypot(q[0] - p[0], q[2] - p[2]);
            if (L < 0.05) continue;
            const [nx, nz] = outN(p, q);
            const ox0 = p[0] + nx * PT, oz0 = p[2] + nz * PT, ox1 = q[0] + nx * PT, oz1 = q[2] + nz * PT;
            let i0 = b.bpos.length / 3;
            // outer face (fascia + wall), top, inner face; double-sided pairs keep it simple
            b.bpos.push(ox0, p[1] + PH, oz0, ox1, q[1] + PH, oz1, ox1, q[1] - 1.35, oz1, ox0, p[1] - 1.35, oz0);
            b.bidx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3, i0, i0 + 2, i0 + 1, i0, i0 + 3, i0 + 2);
            i0 = b.bpos.length / 3;
            b.bpos.push(p[0], p[1] + PH, p[2], q[0], q[1] + PH, q[2], ox1, q[1] + PH, oz1, ox0, p[1] + PH, oz0);
            b.bidx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3, i0, i0 + 2, i0 + 1, i0, i0 + 3, i0 + 2);
            i0 = b.bpos.length / 3;
            b.bpos.push(p[0], p[1] - 0.05, p[2], q[0], q[1] - 0.05, q[2], q[0], q[1] + PH, q[2], p[0], p[1] + PH, p[2]);
            b.bidx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3, i0, i0 + 2, i0 + 1, i0, i0 + 3, i0 + 2);
            const k0 = b.ppos.length / 3;
            b.ppos.push(p[0], p[1] - 0.05, p[2], q[0], q[1] - 0.05, q[2], q[0], q[1] + PH, q[2], p[0], p[1] + PH, p[2]);
            b.pidx.push(k0, k0 + 1, k0 + 2, k0, k0 + 2, k0 + 3);
          }
          continue;
        }
        const pts = [];
        const TH = 0.15;
        const segN = [];
        for (let i = 1; i < run.length; i++) segN.push(outN(run[i - 1], run[i]));
        // first corner: from the arm's side round to the first chord
        if (run[0].row) {
          const u = latN(run[0]);
          pts.push([run[0][0], run[0][1], run[0][2], u[0], u[1], TH]);
          for (const d of fanDirs(u, segN[0])) pts.push([run[0][0], run[0][1], run[0][2], d[0], d[1], TH]);
        }
        for (let i = 0; i < run.length - 1; i++) {
          const p = run[i], q = run[i + 1], nn = segN[i];
          const L = Math.hypot(q[0] - p[0], q[2] - p[2]);
          if (L < 0.05) continue;
          const m = Math.max(1, Math.ceil(L / 5));
          for (let k = 0; k <= m; k++) {
            const t = k / m;
            pts.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t, nn[0], nn[1], TH]);
          }
          // turn between chords at q: fan round the outside
          if (i + 1 < segN.length) for (const d of fanDirs(nn, segN[i + 1])) pts.push([q[0], q[1], q[2], d[0], d[1], TH]);
        }
        const last = run[run.length - 1];
        if (last.row) {
          const v = latN(last);
          for (const d of fanDirs(segN[segN.length - 1], v)) pts.push([last[0], last[1], last[2], d[0], d[1], TH]);
          pts.push([last[0], last[1], last[2], v[0], v[1], TH]);
        }
        this.skirt(b, pts, own);
      }
      if (deck) {
        const i0 = b.fpos.length / 3;
        for (const q of ring) b.fpos.push(q[0], q[1] - 1.35, q[2]);
        for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(ring.map((q) => new THREE.Vector2(q[0], q[2])), [])) b.fidx.push(i0 + i, i0 + j, i0 + k);
      }
    }
    // under every fill: each arm's own strip from the node out to its trim, following the arm's curve. A fill is
    // a polygon between straight chords; an arm that bends inside its trim distance would leave a hole along the
    // chord. The strips sit 12 mm under the fill (plain asphalt, no markings) and only show where the fill does not.
    // height of a plane-less fill (fan from its apex over the rim) at (x, z), or null outside it
    const fanY = (J, x, z) => {
      const c = J.center, r = J.ring, n = r.length;
      for (let i = 0; i < n; i++) {
        const p = r[i], q = r[(i + 1) % n];
        const d = (p[2] - q[2]) * (c[0] - q[0]) + (q[0] - p[0]) * (c[2] - q[2]);
        if (Math.abs(d) < 1e-9) continue;
        const l1 = ((p[2] - q[2]) * (x - q[0]) + (q[0] - p[0]) * (z - q[2])) / d;
        const l2 = ((q[2] - c[2]) * (x - q[0]) + (c[0] - q[0]) * (z - q[2])) / d;
        const l3 = 1 - l1 - l2;
        if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) return l1 * J.apex + l2 * p[1] + l3 * q[1];
      }
      return null;
    };
    const armStrip = (e, fromA, t, plane, ni) => {
      if (!(t > 0.5) || Roads.skipRibbon?.(e, this)) return;
      const n = Math.max(2, Math.ceil(t / 4) + 1), rows = [];
      for (let k = 0; k < n; k++) {
        const d = (k / (n - 1)) * t;
        const p = this.pointAt(e, fromA ? d : e.len - d);
        const hw = p.w / 2, nx = -p.tz, nz = p.tx;
        const lx = p.x + nx * hw, lz = p.z + nz * hw, rx = p.x - nx * hw, rz = p.z - nz * hw;
        const isB = !!(e.br && e.br[p.k] && e.br[Math.min(p.k + 1, e.n - 1)]);
        const off = LIFT - 0.012;
        let yl = plane ? plane.at(lx, lz) + off : p.y + off, yr = plane ? plane.at(rx, rz) + off : p.y + off;
        // a fill without a plane is a fan from its apex to the end rows: the strip follows that fan's slope (its
        // own profile stood up to 0.5 m above a fan whose rim sits lower than the node)
        const f = this.endFrame[e.i][fromA ? 0 : 1], J = this.junctions[ni];
        if (!plane && J?.apex !== undefined && f) {
          const u = d / t;
          yl = fanY(J, lx, lz) ?? J.apex * (1 - u) + (fromA ? f.r[1] : f.l[1]) * u;
          yr = fanY(J, rx, rz) ?? J.apex * (1 - u) + (fromA ? f.l[1] : f.r[1]) * u;
          yl -= 0.012; yr -= 0.012;
        }
        rows.push([lx, yl, lz, rx, yr, rz]);
      }
      const b = bget(...this.nodes[ni]), base = b.pos.length / 3, kind = e.kind === 2 ? 2 : 0;
      for (const r of rows) { b.pos.push(...r); b.lane.push(0, 0, 0, 0); b.info.push(kind, 30, 1, 0, kind, 30, 1, 0); b.end.push(99, 99, 0, 0, 99, 99, 0, 0); }
      for (let k = 1; k < rows.length; k++) {
        const i0 = base + (k - 1) * 2, i1 = i0 + 2;
        // up-facing whichever way the edge runs
        const A = rows[k - 1], B = rows[k];
        const up = (B[0] - A[0]) * (A[5] - A[2]) - (B[2] - A[2]) * (A[3] - A[0]) > 0;
        if (up) b.idx.push(i0, i1, i0 + 1, i1, i1 + 1, i0 + 1); else b.idx.push(i0, i0 + 1, i1, i1, i0 + 1, i1 + 1);
      }
    };
    for (let ni = 0; ni < this.nodes.length; ni++) {
      const J = this.junctions[ni];
      if (!J) continue;
      for (const a of J.allArms) if (!a.e.internal) armStrip(a.e, a.fromA, this.trims[a.e.i][a.fromA ? 0 : 1]?.t || 0, J.plane, ni);
    }
    for (const B of this.bends || []) {
      for (const ei of this.adj[B.ni]) {
        const e = this.edges[ei], end = e.a === B.ni ? 0 : 1;
        armStrip(e, end === 0, this.joinTrim[ei][end], B.plane, B.ni);
      }
    }
    // The final ribbons can differ from the source height profiles on bends and
    // shared junction planes. Conform the heightfield to the actual surface,
    // including long decimated triangles, so soil never protrudes into a lane.
    this.coverageRepair = closeRoadCoverage(this, buckets, bget, Roads.skipRibbon);
    const samples = [], seenSamples = new Set();
    const sample = (x, y, z) => {
      if (this.terrain.heightAt(x, z) < y - 0.075) return;
      const tunnel = this.tunnelFloorAt(x, z, 1);
      if (tunnel !== null && tunnel !== undefined && Math.abs(tunnel - y) < 1) return;
      const key = `${Math.round(x * 2)},${Math.round(z * 2)},${Math.round(y * 20)}`;
      if (seenSamples.has(key)) return;
      seenSamples.add(key); samples.push(x, z, y, 0.08);
    };
    for (const b of buckets.values()) for (let i = 0; i < b.idx.length; i += 3) {
      const a = b.idx[i] * 3, c = b.idx[i + 1] * 3, d = b.idx[i + 2] * 3, p = b.pos;
      sample((p[a] + p[c] + p[d]) / 3, (p[a + 1] + p[c + 1] + p[d + 1]) / 3, (p[a + 2] + p[c + 2] + p[d + 2]) / 3);
      for (const [u, v] of [[a, c], [c, d], [d, a]]) {
        const n = Math.max(1, Math.ceil(Math.hypot(p[v] - p[u], p[v + 2] - p[u + 2]) / 4));
        for (let k = 0; k < n; k++) sample(p[u] + (p[v] - p[u]) * k / n, p[u + 1] + (p[v + 1] - p[u + 1]) * k / n, p[u + 2] + (p[v + 2] - p[u + 2]) * k / n);
      }
    }
    this.groundLowered += conformGround(this.terrain, samples);
    this.physBuckets = new Map();
    for (const [, b] of buckets) {
      if (b.idx.length) {
        this.physBuckets.set(b.key, { verts: new Float32Array(b.pos), idx: new Uint32Array(b.idx) });
        // render-only decals (painted islands, gore areas: src/world/Junctions.js) after the surface, not in physics
        let pos = b.pos, lane = b.lane, info = b.info, end = b.end, idx = b.idx;
        if (b.dpos?.length) {
          const nv = b.pos.length / 3;
          pos = b.pos.concat(b.dpos); lane = b.lane.concat(b.dlane); info = b.info.concat(b.dinfo); end = b.end.concat(b.dend);
          idx = b.idx.concat(b.didx.map((v) => v + nv));
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('aLane', new THREE.Float32BufferAttribute(lane, 2));
        g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 4));
        g.setAttribute('aEnd', new THREE.Float32BufferAttribute(end, 4));
        const nrm = new Float32Array(pos.length);
        for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
        g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
        g.setIndex(idx);
        g.computeBoundingSphere();
        const m = new THREE.Mesh(g, this.material);
        m.receiveShadow = true;
        this.group.add(m);
      }
      if (b.spos && b.spos.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(b.spos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(b.snrm, 3));
        g.setAttribute('aSw', new THREE.Float32BufferAttribute(b.suv, 2));
        g.setIndex(b.sidx);
        g.computeBoundingSphere();
        const m = new THREE.Mesh(g, this.sidewalkMat);
        m.receiveShadow = true;
        this.group.add(m);
      }
      if (b.fpos && b.fpos.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(b.fpos, 3));
        g.setIndex(b.fidx);
        const ng = g.toNonIndexed();
        ng.computeVertexNormals();
        ng.computeBoundingSphere();
        const m = new THREE.Mesh(ng, this.fasciaMat);
        m.castShadow = true;
        m.receiveShadow = true;
        this.group.add(m);
      }
      if ((b.epos && b.epos.length) || (b.apos && b.apos.length)) {
        const ep = b.epos || [], ap = b.apos || [], ne = ep.length / 3;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute([...ep, ...ap], 3));
        g.setIndex([...(b.eidx || []), ...(b.aidx || []).map((v) => v + ne)]);
        g.computeVertexNormals();
        g.computeBoundingSphere();
        const m = new THREE.Mesh(g, this.embankMat);
        m.receiveShadow = true;
        this.group.add(m);
      }
      if (b.kpos && b.kpos.length) {
        // kerb faces + sidewalk tops join the road physics trimesh of this bucket
        const pb = this.physBuckets.get(b.key);
        if (pb) {
          const nv = pb.verts.length / 3;
          const verts = new Float32Array(pb.verts.length + b.kpos.length);
          verts.set(pb.verts); verts.set(b.kpos, pb.verts.length);
          const idx = new Uint32Array(pb.idx.length + b.kidx.length);
          idx.set(pb.idx); idx.set(b.kidx.map((v) => v + nv), pb.idx.length);
          this.physBuckets.set(b.key, { verts, idx });
        } else {
          this.physBuckets.set(b.key, { verts: new Float32Array(b.kpos), idx: new Uint32Array(b.kidx) });
        }
      }
      if (b.bpos && b.bpos.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(b.bpos, 3));
        g.setIndex(b.bidx);
        const parts = [g.toNonIndexed(), ...b.pillars.map((x) => { x.deleteAttribute('uv'); return x.toNonIndexed(); })];
        for (const x of parts) { x.deleteAttribute('normal'); }
        const mg = mergeGeometries(parts, false);
        mg.computeVertexNormals();
        mg.computeBoundingSphere();
        const m = new THREE.Mesh(mg, this.bridgeMat);
        m.castShadow = true;
        m.receiveShadow = true;
        this.group.add(m);
        // parapet walls join the road physics trimesh of this bucket
        const pb = this.physBuckets.get(b.key);
        if (pb && b.ppos.length) {
          const nv = pb.verts.length / 3;
          const verts = new Float32Array(pb.verts.length + b.ppos.length);
          verts.set(pb.verts); verts.set(b.ppos, pb.verts.length);
          const idx = new Uint32Array(pb.idx.length + b.pidx.length);
          idx.set(pb.idx); idx.set(b.pidx.map((v) => v + nv), pb.idx.length);
          this.physBuckets.set(b.key, { verts, idx });
        }
      }
      if (b.apos && b.apos.length) {
        // aprons join the road physics trimesh of this bucket, last (nApron triangles at the end of idx)
        const pb = this.physBuckets.get(b.key) || { verts: new Float32Array(0), idx: new Uint32Array(0) };
        const nv = pb.verts.length / 3;
        const verts = new Float32Array(pb.verts.length + b.apos.length);
        verts.set(pb.verts); verts.set(b.apos, pb.verts.length);
        const idx = new Uint32Array(pb.idx.length + b.aidx.length);
        idx.set(pb.idx); idx.set(b.aidx.map((v) => v + nv), pb.idx.length);
        this.physBuckets.set(b.key, { verts, idx, nApron: b.aidx.length / 3 });
      }
    }
  }

  ribbon(e, bget, lit) {
    const { kind, w } = e;
    const candidates = new Set();
    for (const ni of [e.a, e.b]) {
      if (this.junctions[ni]) candidates.add(this.junctions[ni]);
      for (const ei of this.adj[ni]) {
        const peer = this.edges[ei], next = peer.a === ni ? peer.b : peer.a;
        if (peer.len < 45 && this.junctions[next]) candidates.add(this.junctions[next]);
      }
    }
    const cuts = [];
    for (const J of candidates) if (J.plane) {
      if (!J.cutTriangles) J.cutTriangles = THREE.ShapeUtils.triangulateShape(J.ring.map((p) => new THREE.Vector2(p[0], p[2])), []).map((t) => t.map((i) => J.ring[i]));
      if (!J.bb) J.bb = [Math.min(...J.ring.map((p) => p[0])), Math.max(...J.ring.map((p) => p[0])), Math.min(...J.ring.map((p) => p[2])), Math.max(...J.ring.map((p) => p[2]))];
      cuts.push(J);
    }
    const hw = w / 2;
    // one-way carriageways are tagged in the kind channel: 1.25 = flow a->b, 1.4 = flow b->a
    const kInfo = e.runway ? 4 : e.airside ? 3 : kind === 1 && e.oneway ? (e.oneway > 0 ? 1.25 : 1.4) : kind;
    const endCode = (tr, deg) => (deg === 1 ? CODE.DEAD : tr.code || 0);
    const ta = this.trims[e.i][0] || { t: 0, xwalk: 0 };
    const tb = this.trims[e.i][1] || { t: 0, xwalk: 0 };
    const jt = this.joinTrim?.[e.i] || [0, 0];
    const s0 = Math.max(ta.t || 0, jt[0]), s1 = e.len - Math.max(tb.t || 0, jt[1]);
    if (s1 - s0 < 0.5) return;
    const EF = this.endFrame?.[e.i] || [null, null];
    // trimmed point list
    const P = [];
    const add = (s) => { const p = this.pointAt(e, s); p.s = s; p.isB = !!(e.br && e.br[p.k] && e.br[Math.min(p.k + 1, e.n - 1)]); P.push(p); };
    add(s0);
    for (let k = 0; k < e.n; k++) if (e.cum[k] > s0 + 0.3 && e.cum[k] < s1 - 0.3) {
      P.push({ x: e.pts[2 * k], z: e.pts[2 * k + 1], y: e.y[k], s: e.cum[k], k, isB: !!(e.br && e.br[k]), w: e.wp ? e.wp[k] : e.w });
    }
    add(s1);
    // curb ramps at crosswalks (Roads.sidewalks): rows where the ramps' flat bottoms and flares begin and end, kept
    // through the decimation below
    const extra = [];
    // a cluster link runs under both fills: rows where it comes out from under them (its kerbs start there)
    if (e.internal && e.intTrim) extra.push(e.intTrim[0] + 0.2, e.len - e.intTrim[1] - 0.2);
    if (extra.length) {
      const last = P.pop();
      for (const s of extra) if (s > s0 + 0.5 && s < s1 - 0.5) { add(s); P[P.length - 1].keep = true; }
      P.sort((p, q) => p.s - q.s);
      for (let k = P.length - 1; k > 0; k--) if (!P[k].keep && P.some((q) => q.keep && Math.abs(q.s - P[k].s) < 0.3)) P.splice(k, 1);
      P.push(last);
    }
    // drop points that lie on the chord between their neighbours (straight, evenly sloped stretches):
    // far fewer triangles for road, kerb, sidewalk and physics meshes with identical shape (< 8 cm error)
    const bendPatches = [];
    if (P.length > 2) {
      // (not where the cross slope twists: next to a tilted junction end the quads stay short, a long twisted quad
      // folds along its diagonal - a 4-8 cm ridge across the lanes)
      const twist = (q) => [[EF[0], q - s0], [EF[1], s1 - q]].some(([f, d]) => f?.tiltD && d < f.tiltD && Math.abs(f.dl - f.dr) > 0.03);
      const D = [P[0]];
      for (let k = 1; k < P.length - 1; k++) {
        const a = D[D.length - 1], p = P[k], c = P[k + 1];
        if (p.keep || (c.s - a.s > 3 && twist(p.s)) || p.isB !== a.isB || p.isB !== c.isB || p.s - a.s > 48 || Math.abs(p.w - a.w) > 0.2) { D.push(p); continue; }
        const cx = c.x - a.x, cz = c.z - a.z, cl = Math.hypot(cx, cz) || 1;
        const off = Math.abs(cx * (p.z - a.z) - cz * (p.x - a.x)) / cl;
        const t = (p.s - a.s) / ((c.s - a.s) || 1);
        const yErr = Math.abs(p.y - (a.y + (c.y - a.y) * t));
        if (off > 0.08 || yErr > 0.04) D.push(p);
      }
      D.push(P[P.length - 1]);
      P.length = 0;
      P.push(...D);
    }
    // A graded road that also bends is a twisted surface: every quad between two rows that rotate against each
    // other folds along its diagonal by ~ grade * half-width * turn angle (20 cm on a 15 % hairpin approach).
    // Where that fold would exceed ~2 cm, spread the turn over extra rows on a Catmull-Rom curve through the
    // centreline (rows rotate a little at a time, each fold stays small).
    if (P.length > 2) {
      const crease = new Float32Array(P.length);
      for (let k = 1; k < P.length - 1; k++) {
        const a = P[k - 1], p = P[k], c = P[k + 1];
        const ax = p.x - a.x, az = p.z - a.z, cx = c.x - p.x, cz = c.z - p.z;
        const la = Math.hypot(ax, az) || 1, lc = Math.hypot(cx, cz) || 1;
        const turn = Math.acos(Math.max(-1, Math.min(1, (ax * cx + az * cz) / (la * lc))));
        const grade = Math.max(Math.abs(p.y - a.y) / la, Math.abs(c.y - p.y) / lc);
        crease[k] = grade * ((p.w ?? w) / 2) * turn;
        const hw = (p.w ?? w) / 2;
        if (turn > 0.45 && Math.min(la, lc) / (2 * Math.tan(turn / 2)) < hw * 1.5 && p.s - s0 > 4 * hw && s1 - p.s > 4 * hw) {
          bendPatches.push({ ...p, hw, dx: c.x - a.x, dz: c.z - a.z, grade: (c.y - a.y) / (la + lc) });
        }
      }
      const D = [P[0]];
      for (let k = 0; k < P.length - 1; k++) {
        const need = Math.max(crease[k], crease[k + 1]);
        const p = P[k], c = P[k + 1];
        const L = Math.hypot(c.x - p.x, c.z - p.z);
        // rows no closer than ~0.8 m (their tangents come from neighbour differences)
        const m = Math.min(10, Math.ceil(need / 0.02) - 1, Math.floor(L / 0.8) - 1);
        if (m > 0) {
          // Catmull-Rom control points; a far neighbour (decimated chord) is replaced by a reflection so the curve
          // does not bulge towards it
          let a = P[Math.max(0, k - 1)], d = P[Math.min(P.length - 1, k + 2)];
          if (a === p || Math.hypot(a.x - p.x, a.z - p.z) > 2.5 * L) a = { x: 2 * p.x - c.x, z: 2 * p.z - c.z };
          if (d === c || Math.hypot(d.x - c.x, d.z - c.z) > 2.5 * L) d = { x: 2 * c.x - p.x, z: 2 * c.z - p.z };
          for (let j = 1; j <= m; j++) {
            const t = j / (m + 1), t2 = t * t, t3 = t2 * t;
            const cr = (v0, v1, v2, v3) => 0.5 * (2 * v1 + (-v0 + v2) * t + (2 * v0 - 5 * v1 + 4 * v2 - v3) * t2 + (-v0 + 3 * v1 - 3 * v2 + v3) * t3);
            const x = cr(a.x, p.x, c.x, d.x), z = cr(a.z, p.z, c.z, d.z);
            // height / arc length / width from the point's actual position along the chord (no bunching errors)
            const f = Math.max(0, Math.min(1, ((x - p.x) * (c.x - p.x) + (z - p.z) * (c.z - p.z)) / (L * L || 1)));
            D.push({ x, z, y: p.y + (c.y - p.y) * f, s: p.s + (c.s - p.s) * f, k: p.k, isB: p.isB && c.isB, w: (p.w ?? w) + ((c.w ?? w) - (p.w ?? w)) * f });
          }
        }
        D.push(c);
      }
      if (D.length > P.length) { P.length = 0; P.push(...D); }
    }
    // row geometry first (so folded quads can be removed before anything is emitted)
    let RW = P.map((q, k) => {
      // end rows are shared with the junction fill / mitred neighbour / cap (computeJunctions): exact same vertices
      const ef = k === 0 ? EF[0] : k === P.length - 1 ? EF[1] : null;
      if (ef) return { q, tx: ef.tx, tz: ef.tz, nx: -ef.tz, nz: ef.tx, ms: ef.ms, hq: ef.hw, lx: ef.l[0], yl: ef.l[1], lz: ef.l[2], rx: ef.r[0], yr: ef.r[1], rz: ef.r[2], end: true };
      const kp = Math.max(0, k - 1), kn = Math.min(P.length - 1, k + 1);
      let tx = P[kn].x - P[kp].x, tz = P[kn].z - P[kp].z;
      let tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      // rows next to a mitred joint turn towards its bisector gradually (over ~2 widths), not in one quad
      for (const [f, d] of [[EF[0], q.s - s0], [EF[1], s1 - q.s]]) {
        const L = 2 * (q.w ?? w);
        if (!f?.mitre || d >= L) continue;
        let u = d / L;
        u = u * u * (3 - 2 * u);
        tx = f.tx + (tx - f.tx) * u; tz = f.tz + (tz - f.tz) * u;
        tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
      }
      const nx = -tz, nz = tx;
      let ms = 1;
      if (k > 0 && k < P.length - 1) {
        const ax = q.x - P[k - 1].x, az = q.z - P[k - 1].z;
        const al = Math.hypot(ax, az) || 1;
        ms = 1 / Math.max(0.7, Math.abs((-az / al) * nx + (ax / al) * nz));
      }
      // internal cluster links sit 12 mm under the junction fills they run beneath (no lip where they show)
      const yy = q.y + LIFT - (e.internal ? 0.012 : 0);
      const hq = (q.w ?? w) / 2; // tapered where neighbouring edges differ in width
      // flat across (see endRow) - except next to a junction whose fill is tilted (its plane): the cross slope
      // blends in over the last ~2 widths
      const lx = q.x + nx * hq * ms, lz = q.z + nz * hq * ms, rx = q.x - nx * hq * ms, rz = q.z - nz * hq * ms;
      let yl = yy, yr = yy;
      if (e.internal) {
        // cluster links run under two tilted fills: follow both planes, blended along the link
        const PA = this.junctions[e.a]?.plane, PB = this.junctions[e.b]?.plane;
        if (PA || PB) {
          // on each node's own plane where the neighbouring arms overlap the link (their end rows sit on that
          // plane: a blend reaching over there stood a link 7-20 cm off the arm beside it), blended in between.
          // A node without a plane (deck, saddle) contributes the link's own profile.
          const dA = Math.min(0.3 * e.len, this.armHw(e.a, e)), dB = Math.min(0.3 * e.len, this.armHw(e.b, e));
          let u = Math.max(0, Math.min(1, (q.s - dA) / Math.max(0.5, e.len - dA - dB)));
          u = u * u * (3 - 2 * u);
          const off = LIFT - 0.012;
          const at = (Pl, x, z) => (Pl ? Pl.at(x, z) + off : yy);
          yl = at(PA, lx, lz) * (1 - u) + at(PB, lx, lz) * u;
          yr = at(PA, rx, rz) * (1 - u) + at(PB, rx, rz) * u;
        }
      } else {
        // each tilted end row blends back to the design profile over its tiltD; a ribbon too short for both
        // blends goes from one end row's offset to the other's instead (summing them stood the row next to an
        // end off by the far end's offset: a 15-30 cm ramp right behind the fill)
        const fa = EF[0]?.tiltD ? EF[0] : null, fb = EF[1]?.tiltD ? EF[1] : null, L = s1 - s0;
        if (fa && fb && fa.tiltD + fb.tiltD > L) {
          let t = Math.max(0, Math.min(1, (q.s - s0) / (L || 1)));
          t = t * t * (3 - 2 * t);
          const PA = fa.plane || this.junctions[e.a]?.plane, PB = fb.plane || this.junctions[e.b]?.plane;
          const dlA = PA ? PA.at(lx, lz) + LIFT - yy : fa.dl, dlB = PB ? PB.at(lx, lz) + LIFT - yy : fb.dl;
          const drA = PA ? PA.at(rx, rz) + LIFT - yy : fa.dr, drB = PB ? PB.at(rx, rz) + LIFT - yy : fb.dr;
          yl += dlA * (1 - t) + dlB * t; yr += drA * (1 - t) + drB * t;
        } else {
          for (const [f, d] of [[EF[0], q.s - s0], [EF[1], s1 - q.s]]) {
            if (!f?.tiltD || d >= f.tiltD) continue;
            let u = Math.max(0, d / f.tiltD);
            u = 1 - u * u * (3 - 2 * u);
            const plane = f.plane || this.junctions[f === EF[0] ? e.a : e.b]?.plane;
            yl += (plane ? plane.at(lx, lz) + LIFT - yy : f.dl) * u;
            yr += (plane ? plane.at(rx, rz) + LIFT - yy : f.dr) * u;
          }
        }
      }
      return { q, tx, tz, nx, nz, ms, hq, lx, lz, rx, rz, yl, yr };
    });
    // a side of the ribbon that steps backwards folds its quad over itself (two layers of asphalt at different
    // heights). Next to an imposed end frame that is a row too close to it: drop the row. On a bend tighter
    // than the half-width the inner edge would run backwards: pin it (the inner side pivots on one point).
    for (let pass = 0; pass < 6 && RW.length > 2; pass++) {
      let bad = -1;
      for (let k = 1; k < RW.length && bad < 0; k++) {
        const A = RW[k - 1], B = RW[k];
        if (!A.end && !B.end) continue;
        let tx = A.tx + B.tx, tz = A.tz + B.tz;
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        const dl = (B.lx - A.lx) * tx + (B.lz - A.lz) * tz, dr = (B.rx - A.rx) * tx + (B.rz - A.rz) * tz;
        if (dl < 0.05 || dr < 0.05) bad = B.end ? (A.end ? -2 : k - 1) : k;
      }
      if (bad < 0) break;
      RW.splice(bad, 1);
    }
    for (let k = 1; k < RW.length; k++) {
      const A = RW[k - 1], B = RW[k];
      if (B.end) continue;
      let tx = A.tx + B.tx, tz = A.tz + B.tz;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      if ((B.lx - A.lx) * tx + (B.lz - A.lz) * tz < 0) { B.lx = A.lx; B.lz = A.lz; }
      if ((B.rx - A.rx) * tx + (B.rz - A.rz) * tz < 0) { B.rx = A.rx; B.rz = A.rz; }
    }
    // a pinned run shares one point: give it one height too (each row kept its own, so the fan of slivers around
    // the pivot stood at different heights side by side - 10-30 cm steps across a sharp bend's inner half)
    for (const [X, Z, Y] of [['lx', 'lz', 'yl'], ['rx', 'rz', 'yr']]) {
      for (let k = 0; k < RW.length;) {
        let j = k + 1;
        while (j < RW.length && RW[j][X] === RW[k][X] && RW[j][Z] === RW[k][Z]) j++;
        if (j - k > 1) {
          let m = 0;
          for (let q = k; q < j; q++) m += RW[q][Y];
          m /= j - k;
          const anchored = RW.slice(k, j).find((r) => r.end);
          if (anchored) m = anchored[Y];
          for (let q = k; q < j; q++) RW[q][Y] = m;
        }
        k = j;
      }
    }
    // Offset-loop clipping changes x/z: keep clipped vertices on the shared
    // junction plane instead of retaining the height of their old position.
    const PA = this.junctions[e.a]?.plane, PB = this.junctions[e.b]?.plane;
    if (e.internal && PA && PA === PB) for (const r of RW) {
      r.yl = PA.at(r.lx, r.lz) + LIFT - 0.012;
      r.yr = PA.at(r.rx, r.rz) + LIFT - 0.012;
    }
    // Level the inside of exceptionally tight bends. Offset ribbons overlap
    // when the bend radius is smaller than their half-width; one local plane
    // gives all overlapping triangles exactly the same height.
    if (!e.internal) {
      for (const p of bendPatches) {
        const { hw, dx, dz, grade } = p, length = Math.hypot(dx, dz) || 1;
        const at = (x, z) => p.y + LIFT + grade * ((x - p.x) * dx + (z - p.z) * dz) / length;
        const weight = (x, z) => { const t = Math.max(0, Math.min(1, (Math.hypot(x - p.x, z - p.z) - 2 * hw) / (2 * hw))); return 1 - t * t * (3 - 2 * t); };
        for (const r of RW) for (const [X, Z, Y] of [['lx', 'lz', 'yl'], ['rx', 'rz', 'yr']]) {
          if (r.end) continue;
          r[Y] += (at(r[X], r[Z]) - r[Y]) * weight(r[X], r[Z]);
        }
      }
    }
    const n = RW.length;
    let start = 0;
    while (start < n - 1) {
      let end = start + 1;
      while (end < n - 1 && RW[end].q.s - RW[start].q.s < 260) end++;
      const b = bget((RW[start].q.x + RW[end].q.x) / 2, (RW[start].q.z + RW[end].q.z) / 2);
      const base = b.pos.length / 3;
      const BP = e.br ? [] : null;
      const curb = this.sidewalkWidth(e) > 0;
      const CP = [], rowIndices = [];
      for (let k = start; k <= end; k++) {
        const { q, nx, nz, ms, hq, lx, lz, rx, rz, yl, yr } = RW[k];
        rowIndices.push(b.pos.length / 3);
        b.pos.push(lx, yl, lz, rx, yr, rz);
        if (BP) BP.push({ lx, lz, yl, rx, rz, yr, nx: nx * ms, nz: nz * ms, px: q.x, pz: q.z, y: q.y, isB: q.isB, s: q.s });
        if (curb) CP.push({ lx, lz, yl, rx, rz, yr, nx: nx * ms, nz: nz * ms, isB: q.isB, s: q.s });
        b.lane.push(-hq, q.s, hq, q.s);
        const nm = e.internal ? 1 : 0;
        const li = e.tunnel ? 2 : lit;
        b.info.push(kInfo, hq, nm, li, kInfo, hq, nm, li);
        const dA = q.s - s0, dB = s1 - q.s;
        // marking codes per end (src/world/Junctions.js CODE): crosswalk / stop / yield / arrows at junctions, line
        // fade at dead ends; runways: real ends (threshold markings)
        const fA = e.runway ? (e.rwEnd?.[0] ? 2 : 0) : endCode(ta, this.adj[e.a].length), fB = e.runway ? (e.rwEnd?.[1] ? 2 : 0) : endCode(tb, this.adj[e.b].length);
        b.end.push(dA, dB, fA, fB, dA, dB, fA, fB);
        if (k > start) {
          const i0 = rowIndices[k - start - 1], i1 = rowIndices[k - start];
          // A banked bend is a bilinear surface. One diagonal across its full
          // width can make a ridge; refine only twisted quads, to a 15 mm bound.
          const A = RW[k - 1], B = RW[k];
          const ux = A.rx - A.lx, uz = A.rz - A.lz, vx = B.lx - A.lx, vz = B.lz - A.lz;
          const det = ux * vz - uz * vx;
          let warp = 0;
          if (Math.abs(det) > 0.01) {
            const by = ((A.yr - A.yl) * vz - (B.yl - A.yl) * uz) / det;
            const cy = (ux * (B.yl - A.yl) - vx * (A.yr - A.yl)) / det;
            warp = Math.abs(B.yr - (A.yl + by * (B.rx - A.lx) + cy * (B.rz - A.lz)));
          }
          const div = Math.min(6, Math.max(1, Math.ceil(warp / 0.025)));
          const interp = (a, z, t) => {
            const vi = b.pos.length / 3;
            for (const [key, size] of [['pos', 3], ['lane', 2], ['info', 4], ['end', 4]]) {
              const arr = b[key];
              for (let c = 0; c < size; c++) arr.push(arr[a * size + c] + (arr[z * size + c] - arr[a * size + c]) * t);
            }
            return vi;
          };
          let pa = i0, pb = i1;
          for (let col = 1; col <= div; col++) {
            const a = col === div ? i0 + 1 : interp(i0, i0 + 1, col / div);
            const b1 = col === div ? i1 + 1 : interp(i1, i1 + 1, col / div);
            surfaceTriangle(b, pa, pb, a, cuts);
            surfaceTriangle(b, pb, b1, a, cuts);
            pa = a; pb = b1;
          }
        }
      }
      if (BP) this.bridgeDeck(e, BP, b);
      if (CP.length > 1) this.sidewalks(CP, b, e);
      if (!curb && !e.tunnel && !e.internal) {
        // corners of junctions are where cars cut across: drivable aprons there (from a 15 cm drop); elsewhere a
        // steep embankment face from 25 cm (leaving the road on an embankment is leaving the road)
        const JA = !!this.junctions[e.a], JB = !!this.junctions[e.b];
        for (const sd of [1, -1]) {
          const pts = [];
          for (let k = start; k <= end; k++) {
            const r = RW[k];
            const nearJ = (JA && r.q.s - s0 < 20) || (JB && s1 - r.q.s < 20), th = nearJ ? 0.15 : 0.25;
            pts.push(r.q.isB ? null : sd > 0 ? [r.lx, r.yl, r.lz, r.nx * r.ms, r.nz * r.ms, th, nearJ] : [r.rx, r.yr, r.rz, -r.nx * r.ms, -r.nz * r.ms, th, nearJ]);
          }
          this.skirt(b, pts, e);
        }
      }
      start = end;
    }
  }

  // Embankment under an asphalt edge that stands above the ground. The ground under every surface is kept >= 5 cm
  // below it on the 8 m terrain grid (tools/export.py), so on a side slope, a fill or in the corner between two
  // arms of a junction the cell beside the road can fall away right at the edge: the carriageway reads as a floating
  // slab and a wheel leaving it drops. pts: edge points in order ([x, y, z, outward nx, nz, threshold] or null = no
  // embankment here, e.g. on a deck; apron = false: steep face only); own: the edge(s) the points belong to. Where
  // the drop exceeds the threshold:
  //  - an apron: a drivable 1 : 5 slope from the edge down to the ground (<= 5 m out; steeper for drops > 1 m),
  //    drawn and in the road physics, so a car cutting a corner or running wide rolls down instead of falling;
  //  - a steep face (1 : 0.5, render only) where the apron would land on another road or junction fill.
  skirt(b, pts, own) {
    const T = this.terrain;
    if (!T?.heightAt || pts.length < 2) return;
    const G = pts.map((p) => {
      if (!p) return null;
      const [x, y, z, nx, nz, th = 0.25, apron = true] = p;
      const nl = Math.hypot(nx, nz) || 1;
      const ux = nx / nl, uz = nz / nl;
      const g0 = T.heightAt(x + ux * 0.3, z + uz * 0.3), gap = y - g0;
      const os = Math.max(0.2, Math.min(2, gap * 0.5));
      const sx = x + ux * os, sz = z + uz * os;
      const g = { x, y: y - 0.005, z, ux, uz, os, sx, sz, sy: Math.min(T.heightAt(sx, sz), g0) - 0.3, gap, th, ok: false };
      if (apron && gap >= th) {
        const oa = Math.max(0.3, Math.min(5, gap * 5));
        const ax = x + ux * oa, az = z + uz * oa;
        const mx = x + ux * oa * 0.5, mz = z + uz * oa * 0.5;
        const inFill = this.inJunction(ax, az, y) || this.inJunction(mx, mz, y);
        if (!inFill && !this.onOtherRoad(ax, az, y, own, 0.4, Infinity) && !this.onOtherRoad(mx, mz, y, own, 0.4, Infinity)) {
          g.ok = true; g.oa = oa; g.ax = ax; g.az = az; g.ay = Math.min(T.heightAt(ax, az), y - 0.05) - 0.04;
        } else if (!inFill) g.cliff = true; // a junction fill there covers the ground: no side cliff to soften
      } else if (gap >= th) g.cliff = true; // steep face only (outside a junction's corner zone)
      return g;
    });
    // an apron that stops where the drop goes on (blocked, or past a junction's corner zone) would end in a side
    // cliff as tall as the drop: narrow it to the steep face over its last 6 m instead
    const D = [0];
    for (let k = 1; k < G.length; k++) D.push(D[k - 1] + (G[k] && G[k - 1] ? Math.hypot(G[k].x - G[k - 1].x, G[k].z - G[k - 1].z) : 0));
    const cliffs = [];
    G.forEach((g, k) => { if (g?.cliff) cliffs.push(D[k]); });
    if (cliffs.length) {
      G.forEach((g, k) => {
        if (!g?.ok) return;
        let dEnd = 1e9;
        for (const c of cliffs) dEnd = Math.min(dEnd, Math.abs(D[k] - c));
        if (dEnd >= 6) return;
        const o = g.os + (g.oa - g.os) * (dEnd / 6);
        g.ax = g.x + g.ux * o; g.az = g.z + g.uz * o;
        g.ay = Math.min(T.heightAt(g.ax, g.az), g.y - 0.045) - 0.04;
      });
    }
    for (let k = 1; k < G.length; k++) {
      const A = G[k - 1], B = G[k];
      if (!A || !B || Math.max(A.gap, B.gap) < Math.min(A.th, B.th)) continue;
      if (A.ok && B.ok) {
        if (!b.apos) { b.apos = []; b.aidx = []; }
        const i0 = b.apos.length / 3;
        const P = b.apos;
        // up-facing triangles (consistent normals for the trimesh's internal-edge fix)
        const tri = (i, j, k) => {
          const ax = P[3 * j] - P[3 * i], az = P[3 * j + 2] - P[3 * i + 2], bx = P[3 * k] - P[3 * i], bz = P[3 * k + 2] - P[3 * i + 2];
          if (az * bx - ax * bz >= 0) b.aidx.push(i, j, k); else b.aidx.push(i, k, j);
        };
        // a fan round a corner shares the top vertex: one triangle
        if (A.x === B.x && A.z === B.z) {
          P.push(A.x, A.y, A.z, A.ax, A.ay, A.az, B.ax, B.ay, B.az);
          tri(i0, i0 + 1, i0 + 2);
          continue;
        }
        P.push(A.x, A.y, A.z, A.ax, A.ay, A.az, B.x, B.y, B.z, B.ax, B.ay, B.az);
        tri(i0, i0 + 1, i0 + 2);
        tri(i0 + 2, i0 + 1, i0 + 3);
      } else {
        if (!b.epos) { b.epos = []; b.eidx = []; }
        const i0 = b.epos.length / 3;
        b.epos.push(A.x, A.y, A.z, A.sx, A.sy, A.sz, B.x, B.y, B.z, B.sx, B.sy, B.sz);
        b.eidx.push(i0, i0 + 1, i0 + 2, i0 + 2, i0 + 1, i0 + 3);
      }
    }
  }

  // (cluster links too: their sides between the two fills are kerbed like any street, corners wrap onto them)
  sidewalkWidth(e) { return e.sw && !e.noSidewalk ? (e.w >= 12.5 ? 3.2 : e.lit ? 2.6 : 2.1) : 0; }

  // widest half-width among the other arms at node ni
  armHw(ni, e) {
    let m = 0;
    for (const ei of this.adj[ni]) if (ei !== e.i) m = Math.max(m, this.edges[ei].w / 2);
    return m;
  }

  // a carriageway of an edge not in skip (a Set of edges, or one edge) within margin of (x, z), near height y
  // (margin <= 0.6: the fine index's padding)
  onOtherRoad(x, z, y, skip, margin = 0.3, heightRange = 3) {
    const l = this.fgrid.get(Math.floor(x / 16) * 100003 + Math.floor(z / 16));
    if (!l) return false;
    const set = skip?.has ? skip : null;
    for (let q = 0; q < l.length; q += 2) {
      const f = this.edges[l[q]];
      if (f === skip || (set && set.has(f))) continue;
      const k = l[q + 1], P = f.pts;
      const ax = P[2 * k], az = P[2 * k + 1], dx = P[2 * k + 2] - ax, dz = P[2 * k + 3] - az, L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      const ex = x - ax - dx * t, ez = z - az - dz * t, r = f.w / 2 + margin;
      if (r > 0 && ex * ex + ez * ez < r * r && Math.abs(f.y[k] + (f.y[k + 1] - f.y[k]) * t - y) < heightRange) return true;
    }
    return false;
  }

  // Raised sidewalks (0.14 m kerb + concrete slab) along urban roads: visual + physics.
  // aSw = (u along metres, v across metres from the kerb; v < 0 marks kerb / outer faces).
  sidewalks(CP, b, e) {
    const H = 0.14, W = this.sidewalkWidth(e);
    if (!W) return;
    if (!b.spos) { b.spos = []; b.snrm = []; b.suv = []; b.sidx = []; }
    if (!b.kpos) { b.kpos = []; b.kidx = []; }
    // near a junction (corners are cut there) the slab's outer edge gets a drivable apron down to the ground
    const sA = Math.max(this.trims[e.i][0]?.t || 0, this.joinTrim?.[e.i]?.[0] || 0);
    const sB = e.len - Math.max(this.trims[e.i][1]?.t || 0, this.joinTrim?.[e.i]?.[1] || 0);
    const JA = !!this.junctions[e.a], JB = !!this.junctions[e.b];
    // curb ramps where a crosswalk meets the sidewalk: the kerb is flush with the road from the trim (the corner
    // slab drops there too, Junctions.sidewalkCorners) across the crosswalk band, then rises to full height over
    // MARK.FLARE; a detectable-warning patch (yellow, 0.6 m) lines the flush kerb. The two rows where the ramp ends
    // are sidewalk-only (interpolated along the road edge between ribbon rows: the road's own edge is straight
    // there, so the kerb still sits exactly on it), not ribbon rows.
    const cA = this.trims[e.i][0]?.code || 0, cB = this.trims[e.i][1]?.code || 0;
    const xA = !!(cA & CODE.XW) && JA, xB = !!(cB & CODE.XW) && JB;
    const rise = (s) => {
      let f = 1;
      if (xA) f = Math.min(f, Math.max(0, (s - sA - MARK.XW1) / MARK.FLARE));
      if (xB) f = Math.min(f, Math.max(0, (sB - s - MARK.XW1) / MARK.FLARE));
      return f;
    };
    // rows: the ribbon's, blocked tests once, plus the ramp ends
    const rows = CP.map((p) => ({ p, blk: null }));
    const virt = [];
    if (xA) virt.push(sA + MARK.XW1, sA + MARK.XW1 + MARK.FLARE);
    if (xB) virt.push(sB - MARK.XW1, sB - MARK.XW1 - MARK.FLARE);
    for (const sv of virt) {
      const k = rows.findIndex((r, i) => i > 0 && r.p.s > sv);
      if (k <= 0) continue;
      const a = rows[k - 1].p, c = rows[k].p;
      if (sv - a.s < 0.2 || c.s - sv < 0.2 || a.virt || c.virt) continue;
      const t = (sv - a.s) / (c.s - a.s), L = (u, v) => u + (v - u) * t;
      rows.splice(k, 0, { p: { lx: L(a.lx, c.lx), lz: L(a.lz, c.lz), yl: L(a.yl, c.yl), rx: L(a.rx, c.rx), rz: L(a.rz, c.rz), yr: L(a.yr, c.yr), nx: L(a.nx, c.nx), nz: L(a.nz, c.nz), isB: a.isB || c.isB, s: sv, virt: true }, blk: null, virt: true });
    }
    for (const side of [1, -1]) {
      // rows: kerb bottom, kerb top (face normal), top inner, top outer (up), outer top, outer bottom (face normal)
      let prev = -1, prevK = -1, prow = null;
      const apr = [];
      for (let i = 0; i < rows.length; i++) {
        const R0 = rows[i], p = R0.p;
        const ex = side > 0 ? p.lx : p.rx, ez = side > 0 ? p.lz : p.rz, ey = side > 0 ? p.yl : p.yr;
        const nx = p.nx * side, nz = p.nz * side; // outward (away from the road)
        const nl = Math.hypot(nx, nz) || 1;
        const ox = ex + (nx / nl) * W, oz = ez + (nz / nl) * W;
        // skip where another road's surface lies under the sidewalk (parallel roads, merges); ramp-end rows follow
        // their neighbours
        let blocked;
        if (R0.virt) blocked = !prow;
        else {
          const mx = ex + (nx / nl) * W * 0.5, mz = ez + (nz / nl) * W * 0.5;
          blocked = p.isB || this.sidewalkBlocked(e, ox, oz, ey) || this.sidewalkBlocked(e, mx, mz, ey) || this.inJunction(ox, oz, ey) || this.inJunction(mx, mz, ey) || this.inJunction(ex + (nx / nl) * 0.3, ez + (nz / nl) * 0.3, ey);
        }
        if (blocked) { if (!R0.virt) apr.push(null); prev = -1; prevK = -1; prow = null; continue; }
        const f = rise(p.s);
        const top = ey + Math.max(0.015, H * f);
        const to = Math.max(ey + H, this.terrain.heightAt(ox, oz) + 0.03);
        const gb = Math.min(ey - 0.05, this.terrain.heightAt(ox, oz) - 0.25);
        const base = b.spos.length / 3;
        const fx = -nx / nl, fz = -nz / nl;
        b.spos.push(ex, ey - 0.05, ez, ex, top, ez, ex, top, ez, ox, to, oz, ox, to, oz, ox, gb, oz);
        b.snrm.push(fx, 0, fz, fx, 0, fz, 0, 1, 0, 0, 1, 0, nx / nl, 0, nz / nl, nx / nl, 0, nz / nl);
        b.suv.push(p.s, -1, p.s, -1, p.s, 0, p.s, W, p.s, -2, p.s, -2);
        const kb = b.kpos.length / 3;
        b.kpos.push(ex, ey - 0.05, ez, ex, top, ez, ox, to, oz);
        if (!R0.virt) apr.push((JA && p.s - sA < 25) || (JB && sB - p.s < 25) ? [ox, to, oz, nx / nl, nz / nl, 0.15, true] : null);
        if (prev >= 0) {
          // winding: slab tops face up, kerb faces face the road, outer faces face away from it
          const q = (a0, a1, b0, b1) => side > 0 ? b.sidx.push(a0, a1, b0, a1, b1, b0) : b.sidx.push(a0, b0, a1, a1, b0, b1);
          const flush = f === 0 && prow.f === 0;
          if (!flush) q(prev, prev + 1, base, base + 1); // kerb face (none where the ramp is flush)
          q(prev + 2, prev + 3, base + 2, base + 3); // slab top
          q(prev + 4, prev + 5, base + 4, base + 5); // outer face
          const k = (a0, a1, b0, b1) => b.kidx.push(a0, b0, a1, a1, b0, b1);
          if (!flush) k(prevK, prevK + 1, kb, kb + 1);
          k(prevK + 1, prevK + 2, kb + 1, kb + 2);
          if (flush) {
            // detectable warning along the flush kerb: 0.6 m deep, on the slope, slightly raised (render only)
            const pb = b.spos.length / 3;
            for (const r of [prow, { ex, ez, ey, ox, oz, to }]) {
              const fr = 0.6 / W, y0 = r.ey + 0.015;
              b.spos.push(r.ex, y0 + 0.008, r.ez, r.ex + (r.ox - r.ex) * fr, y0 + (r.to - y0) * fr + 0.008, r.ez + (r.oz - r.ez) * fr);
              b.snrm.push(0, 1, 0, 0, 1, 0);
              b.suv.push(p.s, -3, p.s, -3);
            }
            q(pb, pb + 1, pb + 2, pb + 3);
          }
        }
        prev = base; prevK = kb; prow = { ex, ez, ey, ox, oz, to, f };
      }
      if (apr.some(Boolean)) this.skirt(b, apr, e);
    }
  }

  // another road (different edge, similar height) under this sidewalk point?
  sidewalkBlocked(e, x, z, y) {
    const l = this.fgrid.get(Math.floor(x / 16) * 100003 + Math.floor(z / 16));
    if (!l) return false;
    for (let q = 0; q < l.length; q += 2) {
      const f = this.edges[l[q]];
      if (f === e) continue;
      const k = l[q + 1];
      const ax = f.pts[2 * k], az = f.pts[2 * k + 1], bx = f.pts[2 * k + 2], bz = f.pts[2 * k + 3];
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
      if (d < f.w / 2 + 0.3 && Math.abs(f.y[k] - y) < 2.5) {
        // inside the junction trims of e the neighbour is a junction arm: corners handle that
        return true;
      }
    }
    return false;
  }

  // sidewalk corner pieces around urban junctions: fill between neighbouring arms' sidewalks
  sidewalkCorners(bget) {
    const H = 0.14;
    for (let ni = 0; ni < this.nodes.length; ni++) {
      const J = this.junctions[ni];
      if (!J || !J.arms) continue;
      const arms = J.arms, n = arms.length;
      for (let i = 0; i < n; i++) {
        const A = arms[i], B = arms[(i + 1) % n];
        const WA = this.sidewalkWidth(A.e), WB = this.sidewalkWidth(B.e);
        if (!WA || !WB) continue;
        const pa = this.pointAt(A.e, A.fromA ? A.t : A.e.len - A.t), pb = this.pointAt(B.e, B.fromA ? B.t : B.e.len - B.t);
        const dax = A.fromA ? pa.tx : -pa.tx, daz = A.fromA ? pa.tz : -pa.tz;
        const dbx = B.fromA ? pb.tx : -pb.tx, dbz = B.fromA ? pb.tz : -pb.tz;
        const lax = -daz, laz = dax; // left of A (towards B)
        const rbx = dbz, rbz = -dbx; // right of B (towards A)
        const IA = [pa.x + lax * A.hw, pa.z + laz * A.hw], OA = [pa.x + lax * (A.hw + WA), pa.z + laz * (A.hw + WA)];
        const IB = [pb.x + rbx * B.hw, pb.z + rbz * B.hw], OB = [pb.x + rbx * (B.hw + WB), pb.z + rbz * (B.hw + WB)];
        if (Math.hypot(IA[0] - IB[0], IA[1] - IB[1]) > 40) continue;
        // outer corner: intersection of the two outer kerb lines (extended back towards the node)
        const den = dax * dbz - daz * dbx;
        let C = null;
        if (Math.abs(den) > 0.15) {
          const wx = OB[0] - OA[0], wz = OB[1] - OA[1];
          const ta = (wx * dbz - wz * dbx) / den;
          const c = [OA[0] + dax * ta, OA[1] + daz * ta];
          const nx = J.center[0], nz = J.center[2];
          if (ta < 0.5 && Math.hypot(c[0] - nx, c[1] - nz) < 30 && (c[0] - nx) * (lax + rbx) + (c[1] - nz) * (laz + rbz) > 0) C = c;
        }
        const y = (pa.y + pb.y) / 2 + H;
        // not over another carriageway (a third road squeezing between the arms, a merging ramp)
        // (and not reaching into a carriageway of its own arms: acute corners, arms of very different widths)
        const own = new Set(J.allArms.map((a) => a.e));
        const probe = C ? [OA, C, OB] : [OA, OB];
        probe.push([(IA[0] + OB[0]) / 2, (IA[1] + OB[1]) / 2], [(IB[0] + OA[0]) / 2, (IB[1] + OA[1]) / 2]);
        if (probe.some((r) => this.onOtherRoad(r[0], r[1], y, own, 0.1) || this.onOtherRoad(r[0], r[1], y, null, -0.25))) continue;
        const b = bget(IA[0], IA[1]);
        if (!b.spos) { b.spos = []; b.snrm = []; b.suv = []; b.sidx = []; }
        if (!b.kpos) { b.kpos = []; b.kidx = []; }
        const ring = C ? [IA, OA, C, OB, IB] : [IA, OA, OB, IB];
        // slab top 14 cm over the fill it borders: on the junction's plane where it has one (a flat slab at the
        // arms' mean height stood up to 1 m proud of a sloping junction), else each side at its own arm's height
        const yA = pa.y + LIFT + H, yB = pb.y + LIFT + H;
        const hAt = (r, side) => (J.plane ? J.plane.at(r[0], r[1]) + LIFT + H : side < 0 ? yA : side > 0 ? yB : (yA + yB) / 2);
        const side = (r) => (r === IA || r === OA ? -1 : r === IB || r === OB ? 1 : 0);
        // slab top (fan from the centroid keeps it valid for convex pieces)
        let cx = 0, cz = 0;
        for (const r of ring) { cx += r[0]; cz += r[1]; }
        cx /= ring.length; cz /= ring.length;
        const cy = hAt([cx, cz], 0);
        const base = b.spos.length / 3;
        b.spos.push(cx, cy, cz); b.snrm.push(0, 1, 0); b.suv.push(0, 1);
        for (const r of ring) { b.spos.push(r[0], hAt(r, side(r)), r[1]); b.snrm.push(0, 1, 0); b.suv.push(0, 1); }
        // physics: the corner's kerb is a mountable ramp (its edge on the fill rim, rising to the slab over the
        // piece): a car cutting the corner rides up instead of striking a 14 cm step
        const kb = b.kpos.length / 3;
        b.kpos.push(cx, cy, cz);
        for (const r of ring) b.kpos.push(r[0], hAt(r, side(r)) - (r === IA || r === IB ? H : 0), r[1]);
        for (let k = 0; k < ring.length; k++) {
          const k2 = (k + 1) % ring.length;
          const ax = ring[k][0] - cx, az = ring[k][1] - cz, bx = ring[k2][0] - cx, bz = ring[k2][1] - cz;
          const up = ax * bz - az * bx < 0; // counter-clockwise seen from above
          if (up) { b.sidx.push(base, base + 1 + k, base + 1 + k2); b.kidx.push(kb, kb + 1 + k, kb + 1 + k2); } else { b.sidx.push(base, base + 1 + k2, base + 1 + k); b.kidx.push(kb, kb + 1 + k2, kb + 1 + k); }
        }
        // kerb face along the junction edge IB -> IA, facing the junction
        const fx = (IA[1] - IB[1]), fz = -(IA[0] - IB[0]);
        const fl = Math.hypot(fx, fz) || 1;
        const nx0 = J.center[0], nz0 = J.center[2];
        const sgn = ((IA[0] + IB[0]) / 2 - nx0) * fx + ((IA[1] + IB[1]) / 2 - nz0) * fz > 0 ? -1 : 1;
        const kbase = b.spos.length / 3;
        const tA = hAt(IA, -1), tB = hAt(IB, 1);
        for (const [r, yy] of [[IA, tA - H - 0.05], [IA, tA], [IB, tB - H - 0.05], [IB, tB]]) { b.spos.push(r[0], yy, r[1]); b.snrm.push((sgn * fx) / fl, 0, (sgn * fz) / fl); b.suv.push(0, -1); }
        b.sidx.push(kbase, kbase + 2, kbase + 1, kbase + 1, kbase + 2, kbase + 3);
        b.sidx.push(kbase, kbase + 1, kbase + 2, kbase + 1, kbase + 3, kbase + 2); // both windings: thin face, cheap
        // outer faces OA -> (C) -> OB down into the ground, like the sidewalks' (no floating slab edge on a slope)
        const outer = C ? [OA, C, OB] : [OA, OB];
        for (let k = 1; k < outer.length; k++) {
          const P0 = outer[k - 1], P1 = outer[k];
          const t0 = hAt(P0, side(P0)), t1 = hAt(P1, side(P1));
          const g0 = Math.min(t0 - H - 0.05, this.terrain.heightAt(P0[0], P0[1]) - 0.25), g1 = Math.min(t1 - H - 0.05, this.terrain.heightAt(P1[0], P1[1]) - 0.25);
          let ox = P1[1] - P0[1], oz = -(P1[0] - P0[0]);
          const ol = Math.hypot(ox, oz) || 1;
          if (ox * ((P0[0] + P1[0]) / 2 - nx0) + oz * ((P0[1] + P1[1]) / 2 - nz0) < 0) { ox = -ox; oz = -oz; }
          const ob = b.spos.length / 3;
          for (const [r, yy] of [[P0, g0], [P0, t0], [P1, g1], [P1, t1]]) { b.spos.push(r[0], yy, r[1]); b.snrm.push(ox / ol, 0, oz / ol); b.suv.push(0, -2); }
          b.sidx.push(ob, ob + 2, ob + 1, ob + 1, ob + 2, ob + 3, ob, ob + 1, ob + 2, ob + 1, ob + 3, ob + 2);
        }
        // and a drivable apron from that edge down to the ground (cars cut corners over these slabs)
        const ap = [];
        for (let k = 0; k < outer.length; k++) {
          const P0 = outer[k];
          const dirs = [];
          if (k > 0) dirs.push(outer[k - 1]);
          if (k < outer.length - 1) dirs.push(outer[k + 1]);
          let ux = 0, uz = 0;
          for (const Q of dirs) {
            let ox = Q[1] - P0[1], oz = -(Q[0] - P0[0]);
            const ol = Math.hypot(ox, oz) || 1;
            if (ox * (P0[0] - nx0) + oz * (P0[1] - nz0) < 0) { ox = -ox; oz = -oz; }
            ux += ox / ol; uz += oz / ol;
          }
          ap.push([P0[0], hAt(P0, side(P0)), P0[1], ux, uz, 0.15, true]);
        }
        this.skirt(b, ap, own);
      }
    }
  }

  makeSidewalkMaterial() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.93, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec2 aSw; varying vec2 vSw; varying vec3 vWs;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vSw = aSw; vWs = (modelMatrix * vec4(position, 1.0)).xyz;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          ${LAMP_MAP_GLSL}
          varying vec2 vSw; varying vec3 vWs;
          ${DECK_COVER_GLSL}
          float swHash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            float n = swHash(floor(vWs.xz * 2.0)) * 0.06 + swHash(floor(vWs.xz * 0.5)) * 0.05;
            vec3 concrete = vec3(0.58, 0.565, 0.54) * (0.94 + n);
            vec3 kerb = vec3(0.70, 0.69, 0.66) * (0.95 + n);
            vec3 col = concrete;
            if (vSw.y < -3.5) {
              // island top: mown grass (junction islands, Junctions.js)
              col = vec3(0.30, 0.52, 0.20) * (0.88 + 1.6 * n);
            } else if (vSw.y < -2.5) {
              // detectable warning (curb ramp foot): safety yellow with a grid of truncated domes
              vec2 g = fract(vWs.xz / 0.25) - 0.5;
              col = vec3(0.86, 0.68, 0.10) * (0.92 + n) * (1.0 - 0.22 * step(dot(g, g), 0.06));
            } else if (vSw.y < 0.0) col = vSw.y < -1.5 ? concrete * 0.8 : kerb;
            else {
              float fw = fwidth(vSw.x) + 1e-3;
              float joint = 1.0 - smoothstep(0.02, 0.02 + fw, abs(fract(vSw.x / 1.6) - 0.5) * 1.6 - 0.78);
              col = mix(col, kerb, 1.0 - smoothstep(0.30, 0.34, vSw.y));
              col *= 1.0 - 0.28 * joint * step(0.34, vSw.y);
            }
            diffuseColor.rgb = col;
          }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += diffuseColor.rgb * lampMapLight(vWs) * 2.4;`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          ${deckShadeChunk('vWs')}`);
      Object.assign(sh.uniforms, LAMP_MAP_UNIFORMS, this.terrain?.coverUniforms || {});
      patchWeather(sh, { worldPos: 'vWs', porosity: 0.5 });
    };
    mat.customProgramCacheKey = () => 'sidewalk-v4';
    return mat;
  }

  // continuous deck: outer skirts, underside, parapets (inner faces also go to physics)
  bridgeDeck(e, BP, b) {
    const D = 1.35, PH = 0.95, PT = 0.32;
    if (!b.bpos) { b.bpos = []; b.bidx = []; b.ppos = []; b.pidx = []; b.pillars = []; }
    const quad = (arr, idx, A, B, C, Dd, nx, ny, nz) => {
      const base = arr.length / 3;
      arr.push(...A, ...B, ...C, ...Dd);
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
      const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (cx * nx + cy * ny + cz * nz >= 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    };
    for (let i = 0; i < BP.length - 1; i++) {
      const p = BP[i], q = BP[i + 1];
      if (!(p.isB && q.isB)) continue;
      for (const side of [1, -1]) {
        const ex0 = side > 0 ? p.lx : p.rx, ez0 = side > 0 ? p.lz : p.rz, ey0 = side > 0 ? p.yl : p.yr;
        const ex1 = side > 0 ? q.lx : q.rx, ez1 = side > 0 ? q.lz : q.rz, ey1 = side > 0 ? q.yl : q.yr;
        const ox0 = ex0 + p.nx * PT * side, oz0 = ez0 + p.nz * PT * side;
        const ox1 = ex1 + q.nx * PT * side, oz1 = ez1 + q.nz * PT * side;
        const nX = (p.nx + q.nx) * 0.5 * side, nZ = (p.nz + q.nz) * 0.5 * side;
        // no parapet where another carriageway merges / runs alongside at the same level
        const mx = (ex0 + ex1) / 2 + nX * 1.2, mz = (ez0 + ez1) / 2 + nZ * 1.2;
        const other = this.nearest(mx, mz, 30, (e2) => e2 !== e);
        if (other && other.dist < other.edge.w / 2 + 0.8 && Math.abs(other.y - (ey0 + ey1) / 2) < 2.5) continue;
        // outer skirt (deck side + parapet outer face)
        quad(b.bpos, b.bidx, [ox0, ey0 + PH, oz0], [ox1, ey1 + PH, oz1], [ox1, ey1 - D, oz1], [ox0, ey0 - D, oz0], nX, 0, nZ);
        // parapet top
        quad(b.bpos, b.bidx, [ex0, ey0 + PH, ez0], [ex1, ey1 + PH, ez1], [ox1, ey1 + PH, oz1], [ox0, ey0 + PH, oz0], 0, 1, 0);
        // parapet inner face (visual + physics)
        const A = [ex0, ey0 - 0.05, ez0], B = [ex1, ey1 - 0.05, ez1], C = [ex1, ey1 + PH, ez1], Dd = [ex0, ey0 + PH, ez0];
        quad(b.bpos, b.bidx, A, B, C, Dd, -nX, 0, -nZ);
        quad(b.ppos, b.pidx, A, B, C, Dd, -nX, 0, -nZ);
      }
      // underside
      const lo0 = [p.lx + p.nx * PT, p.yl - D, p.lz + p.nz * PT], lo1 = [q.lx + q.nx * PT, q.yl - D, q.lz + q.nz * PT];
      const ro0 = [p.rx - p.nx * PT, p.yr - D, p.rz - p.nz * PT], ro1 = [q.rx - q.nx * PT, q.yr - D, q.rz - q.nz * PT];
      quad(b.bpos, b.bidx, lo0, lo1, ro1, ro0, 0, -1, 0);
      // pillars every ~30 m
      const k0 = Math.floor(p.s / 30), k1 = Math.floor(q.s / 30);
      if (k1 > k0) {
        const t = (k1 * 30 - p.s) / Math.max(0.01, q.s - p.s);
        const px = p.px + (q.px - p.px) * t, pz = p.pz + (q.pz - p.pz) * t, py = p.y + (q.y - p.y) * t;
        const ground = this.terrain.heightAt(px, pz);
        const top = py - D;
        const hgt = top - Math.min(ground, -0.5);
        const below = this.nearest(px, pz, 30, (e2) => e2 !== e, py - 3);
        const blocked = below && below.dist < below.edge.w / 2 + 2.4 && below.y < py - 3;
        if (hgt > 1.0 && !blocked) {
          const pil = new THREE.BoxGeometry(Math.min(e.w * 0.5, 7), hgt, 1.7);
          pil.rotateY(Math.atan2(q.px - p.px, q.pz - p.pz));
          pil.translate(px, top - hgt / 2, pz);
          b.pillars.push(pil);
          const cap = new THREE.BoxGeometry(e.w * 0.85, 0.7, 2.0);
          cap.rotateY(Math.atan2(q.px - p.px, q.pz - p.pz));
          cap.translate(px, top - 0.35, pz);
          b.pillars.push(cap);
        }
      }
    }
  }

  placeLamps(e) {
    const { pts, y, cum, len, n, w } = e;
    const hw = w / 2;
    let k = 0;
    for (let s = LAMP_STEP * 0.5, idx = 0; s < len; s += LAMP_STEP, idx++) {
      // clear of the junction box and its crosswalks (the kerb returns reach well past nodeR on big corners)
      const rA = Math.max(this.nodeR[e.a] + 4, (this.trims?.[e.i]?.[0]?.t || 0) + MARK.XW1 + 1.5), rB = Math.max(this.nodeR[e.b] + 4, (this.trims?.[e.i]?.[1]?.t || 0) + MARK.XW1 + 1.5);
      if (s < rA || s > len - rB) continue;
      while (k < n - 2 && cum[k + 1] < s) k++;
      const t = (s - cum[k]) / Math.max(1e-3, cum[k + 1] - cum[k]);
      const ax = pts[2 * k], az = pts[2 * k + 1], bx = pts[2 * k + 2], bz = pts[2 * k + 3];
      const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
      const nx = -dz / L, nz = dx / L;
      const side = idx % 2 === 0 ? 1 : -1;
      const isB = e.br && (e.br[k] || e.br[k + 1]);
      const off = isB ? hw + 0.16 : hw + 0.8;
      const px = ax + dx * t + nx * side * off, pz = az + dz * t + nz * side * off;
      const py = isB ? y[k] + (y[k + 1] - y[k]) * t + 0.95 : this.terrain.heightAt(px, pz);
      // lamp arm points towards the road centre
      this.lamps.push(px, py, pz, Math.atan2(-nx * side, -nz * side));
    }
  }

  // stream road-surface trimesh colliders (smooth driving surface exactly matching the visuals)
  // Road surface colliders around (x, z) (src/world/colliderStream.js): the buckets within 250 m of the point at once,
  // the rest nearest first through Streaming's per-frame budget; out of range they are disabled, not removed, and every
  // bucket is built ahead in idle time (prefetch), so relocations only toggle colliders.
  updateColliders(RAPIER, world, x, z, radius, groups) {
    if (!this.colStream) {
      this.colMsPerTri = 0.00045; // build cost estimate, refined by every build
      this.colStream = new ColliderStream({
        cache: Infinity,
        live: (this.colliders ||= new Map()),
        estimate: (key) => (this.physBuckets.get(key)?.idx.length ?? 0) / 3 * this.colMsPerTri,
        build: (key) => {
          const pb = this.physBuckets.get(key);
          if (!pb) return null;
          const t0 = performance.now();
          const desc = this._colRAPIER.ColliderDesc.trimesh(pb.verts, pb.idx, this._colRAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(1.0);
          if (this._colGroups !== undefined) desc.setCollisionGroups(this._colGroups);
          const c = this.colStream.world.createCollider(desc);
          const tris = pb.idx.length / 3;
          if (tris > 500) this.colMsPerTri = this.colMsPerTri * 0.7 + 0.3 * (performance.now() - t0) / tris;
          return c;
        },
      });
      const half = BUCKET / 2;
      this.colStream.prefetchAll(this.physBuckets.keys(), x, z, (k) => [Math.round(k / 1000) * BUCKET + half, (k - Math.round(k / 1000) * 1000) * BUCKET + half]);
    }
    this._colRAPIER = RAPIER;
    this._colGroups = groups;
    const i0 = Math.floor((x - radius) / BUCKET), i1 = Math.floor((x + radius) / BUCKET);
    const j0 = Math.floor((z - radius) / BUCKET), j1 = Math.floor((z + radius) / BUCKET);
    this.colStream.update(world, (visit) => {
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const key = i * 1000 + j;
        if (!this.physBuckets.has(key)) continue;
        // distance from the point to the bucket's square (0 inside)
        const dx = Math.max(i * BUCKET - x, 0, x - (i + 1) * BUCKET), dz = Math.max(j * BUCKET - z, 0, z - (j + 1) * BUCKET);
        visit(key, Math.hypot(dx, dz));
      }
    }, 250);
  }


  // A* route between two world points; returns flat [x,z,...] polyline
  route(x0, z0, x1, z1, startY, endY) {
    const snap = (x, z, y, radius) => {
      if (Number.isFinite(y)) {
        const n = this.nearest(x, z, 80, undefined, y + 2, y - 4);
        if (n && n.dist < n.edge.w / 2 + 3) return n;
      }
      return this.nearest(x, z, radius);
    };
    const A = snap(x0, z0, startY, 2000), B = snap(x1, z1, endY, 3000);
    if (!A || !B) return null;
    const ea = A.edge, eb = B.edge;
    const sA = ea.cum[A.seg] + A.t * (ea.cum[A.seg + 1] - ea.cum[A.seg]);
    const sB = eb.cum[B.seg] + B.t * (eb.cum[B.seg + 1] - eb.cum[B.seg]);
    if (ea === eb && (sA === sB || this.allowedFrom(ea, sB >= sA ? ea.a : ea.b))) {
      const out = [x0, z0, A.x, A.z];
      if (sB >= sA) for (let k = A.seg + 1; k <= B.seg; k++) out.push(ea.pts[k * 2], ea.pts[k * 2 + 1]);
      else for (let k = A.seg; k > B.seg; k--) out.push(ea.pts[k * 2], ea.pts[k * 2 + 1]);
      out.push(B.x, B.z);
      return out;
    }
    const N = this.nodes.length;
    const g = new Float64Array(N + 1).fill(Infinity);
    const prev = new Int32Array(N + 1).fill(-1);
    const prevE = new Int32Array(N + 1).fill(-1);
    const open = new MinHeap();
    const h = (ni) => ni === N ? 0 : Math.hypot(this.nodes[ni][0] - B.x, this.nodes[ni][1] - B.z) * 0.75;
    const costMul = (e) => (e.kind === 1 ? 0.75 : e.kind === 2 ? 1.6 : 1.0);
    if (this.allowedFrom(ea, ea.b)) { g[ea.a] = sA * costMul(ea); open.push(ea.a, g[ea.a] + h(ea.a)); }
    if (this.allowedFrom(ea, ea.a)) { g[ea.b] = Math.min(g[ea.b], (ea.len - sA) * costMul(ea)); open.push(ea.b, g[ea.b] + h(ea.b)); }
    const goal = new Map();
    if (this.allowedFrom(eb, eb.a)) goal.set(eb.a, sB * costMul(eb));
    if (this.allowedFrom(eb, eb.b)) goal.set(eb.b, (eb.len - sB) * costMul(eb));
    let found = -1;
    const closed = new Uint8Array(N + 1);
    while (open.size) {
      const cur = open.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === N) { found = prev[N]; break; }
      if (goal.has(cur) && g[cur] + goal.get(cur) < g[N]) {
        g[N] = g[cur] + goal.get(cur); prev[N] = cur; open.push(N, g[N]);
      }
      for (const ei of this.adj[cur]) {
        const e = this.edges[ei];
        if (!this.allowedFrom(e, cur)) continue;
        const nb = e.a === cur ? e.b : e.a;
        const ng = g[cur] + e.len * costMul(e);
        if (ng < g[nb]) { g[nb] = ng; prev[nb] = cur; prevE[nb] = ei; open.push(nb, ng + h(nb)); }
      }
    }
    if (found < 0) return null;
    const chain = [];
    for (let c = found; prev[c] >= 0; c = prev[c]) chain.push([prevE[c], prev[c], c]);
    chain.reverse();
    const out = [x0, z0, A.x, A.z];
    const appendEdge = (e, from) => {
      if (e.a === from) for (let k = 0; k < e.n; k++) out.push(e.pts[2 * k], e.pts[2 * k + 1]);
      else for (let k = e.n - 1; k >= 0; k--) out.push(e.pts[2 * k], e.pts[2 * k + 1]);
    };
    // first partial edge from A to the first chain node
    const firstNode = chain.length ? chain[0][1] : found;
    if (firstNode === ea.a) for (let k = A.seg; k >= 0; k--) out.push(ea.pts[2 * k], ea.pts[2 * k + 1]);
    else for (let k = A.seg + 1; k < ea.n; k++) out.push(ea.pts[2 * k], ea.pts[2 * k + 1]);
    for (const [ei, from] of chain) appendEdge(this.edges[ei], from);
    if (found === eb.a) for (let k = 0; k <= B.seg; k++) out.push(eb.pts[2 * k], eb.pts[2 * k + 1]);
    else for (let k = eb.n - 1; k > B.seg; k--) out.push(eb.pts[2 * k], eb.pts[2 * k + 1]);
    out.push(B.x, B.z);
    return out;
  }

  update(night, camera, drawDistance = 1) {
    this.uniforms.uNight.value = night;
    if (!camera) return;
    for (const m of this.detailMeshes) {
      const s = m.geometry.boundingSphere;
      m.visible = camera.position.distanceToSquared(s.center) < (1500 * drawDistance + s.radius) ** 2;
    }
  }

  // a street lamp was knocked down at (x, z): its pool on the asphalt goes dark
  addDeadLamp(x, z) {
    this.uniforms.uDead.value[this.deadIdx].set(x, z);
    this.deadIdx = (this.deadIdx + 1) % 24;
    this.uniforms.uDeadN.value = Math.min(24, this.uniforms.uDeadN.value + 1);
  }
}

// convex hull (Andrew's monotone chain) of [x, y, z] points in the XZ plane, counter-clockwise
function hull2d(pts) {
  const P = pts.slice().sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  if (P.length < 3) return P;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[2] - o[2]) - (a[2] - o[2]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of P) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (v[p] <= v[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const k = this.k, v = this.v;
    const top = k[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && v[l] < v[m]) m = l;
        if (r < k.length && v[r] < v[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}
