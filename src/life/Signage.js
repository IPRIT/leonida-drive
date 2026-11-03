import { Instancer } from './Instancer.js';
import { propMaterial, glowMaterial, billboardFaceMaterial } from './materials.js';
import { billboardFrameGeo, billboardFaceGeo, bladeBackGeo, bladeFaceGeo, neonStripGeo, BOARD } from './geometry.js';
import { makeAdTexture, makeNeonTexture, adCell, neonCell, adAtlasScale, AD_COLS, AD_ROWS, NEON_WORDS, AD_IDS } from './ads.js';
import { hash2, PointGrid, quality } from './util.js';
import { updateSets } from './Beach.js';

const ROOF_AREAS = new Set(['Downtown', 'Ocean Beach', 'Washington Beach', 'Crosstown', 'Bayside', 'Little Cuba', 'Shoreline', 'Vice Decor District', 'Salton', 'La Perle', 'Rockridge', 'Tequesta']);
const BLADE_AREAS = new Set(['Ocean Beach', 'Washington Beach', 'Little Cuba', 'Downtown', 'Vice Decor District', 'Crosstown', 'Bayside', 'Shoreline', 'La Perle', 'Capri', 'Port Gellhorn', 'Key Lento']);
const TOWER_AREAS = new Set(['Downtown', 'Bayside', 'Shoreline', 'Crosstown', 'Ocean Beach', 'Washington Beach', 'Salton', 'Tequesta', 'Rialto Islands']);
const NEON = [0xff3fa4, 0x29f0e0, 0xb04dff, 0x4dd2ff, 0xff8a3d, 0xff5fd2];
const AD_REPEAT_MIN = 400; // metres: the same ad never shows up twice within this distance (when the atlas allows)

// Roadside & rooftop billboards with original fictional ads, neon blade signs and neon tower outlines.
export class Signage {
  constructor(game, root, colliders) {
    this.game = game;
    const t0 = performance.now();
    const q = (quality(game).vegRadius ?? 1) * (game.settings?.drawDist ?? 1);
    const prof = {};
    let tp = performance.now();
    const lap = (k) => { const n = performance.now(); prof[k] = +(n - tp).toFixed(1); tp = n; };
    const boards = this.placeHighway(game); lap('highway');
    boards.push(...this.placeRooftops(game)); lap('roof');
    const blades = this.placeBlades(game); lap('blades');
    const strips = this.placeStrips(game); lap('strips');
    this.boards = boards;

    const frameMat = propMaterial();
    const maxTex = game.renderer?.capabilities?.maxTextureSize || 4096;
    this.adScale = adAtlasScale(quality(game).name, !!game.mobile?.active, maxTex);
    this.adTex = makeAdTexture(game.renderer, this.adScale);
    const faceMat = billboardFaceMaterial(this.adTex, [1 / AD_COLS, 1 / AD_ROWS]);
    lap('adTex');
    this.neonTex = makeNeonTexture();
    lap('neonTex');
    const bladeMat = glowMaterial({ map: this.neonTex, cell: [1 / NEON_WORDS.length, 1], data: true, additive: true, day: 0.45, night: 2.4, fadeFar: 1100, key: 'blade' });
    const backMat = propMaterial();
    const stripMat = glowMaterial({ data: true, day: 0.22, night: 3.4, key: 'strip' });
    this.materials = [frameMat, faceMat, bladeMat, backMat, stripMat];

    const nTall = boards.filter((b) => !b.roof).length, nRoof = boards.length - nTall;
    this.sets = {
      tall: new Instancer(root, billboardFrameGeo(false), frameMat, { capacity: Math.max(1, nTall), radius: 2600 * q, castShadow: true, name: 'life-billboards', moveStep: 80 }),
      roof: new Instancer(root, billboardFrameGeo(true), frameMat, { capacity: Math.max(1, nRoof), radius: 2200 * q, castShadow: true, name: 'life-roof-billboards', moveStep: 80 }),
      faces: new Instancer(root, billboardFaceGeo(), faceMat, { capacity: Math.max(1, boards.length * 2), radius: 2600 * q, colors: false, data: 'aData', name: 'life-ads', moveStep: 80 }),
      bladeBack: new Instancer(root, bladeBackGeo(), backMat, { capacity: Math.max(1, blades.length), radius: 1100 * q, name: 'life-blades', moveStep: 50 }),
      bladeFace: new Instancer(root, bladeFaceGeo(), bladeMat, { capacity: Math.max(1, blades.length), radius: 1100 * q, data: 'aData', name: 'life-blade-neon', moveStep: 50, renderOrder: 2 }),
      strips: new Instancer(root, neonStripGeo(), stripMat, { capacity: Math.max(1, strips.length), radius: 4000, data: 'aData', name: 'life-neon-strips', moveStep: 150 }),
    };
    const S = this.sets;
    // signs mounted on buildings, by building id: they come down with the building (detach)
    this.attached = new Map();
    const att = (bid, set, i, x, y, z) => { if (bid === undefined) return; let l = this.attached.get(bid); if (!l) this.attached.set(bid, (l = [])); l.push({ set, i, x, y, z }); };
    const deal = this.dealAds(boards, AD_IDS.length, AD_REPEAT_MIN);
    for (let bi = 0; bi < boards.length; bi++) {
      const b = boards[bi];
      att(b.bid, b.roof ? S.roof : S.tall, (b.roof ? S.roof : S.tall).add(b.x, b.y, b.z, b.yaw), b.x, b.y, b.z);
      const cy = b.y + (b.roof ? BOARD.cyRoof : BOARD.cyTall);
      const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw), d = BOARD.depth / 2 + 0.02;
      const broken = hash2(b.x, b.z, 41) < 0.12 ? 1 : 0;
      const c1 = adCell(deal.ads[bi * 2]), c2 = adCell(deal.ads[bi * 2 + 1]);
      att(b.bid, S.faces, S.faces.add(b.x + fx * d, cy, b.z + fz * d, b.yaw, 1, 1, 1, 0xffffff, [c1[0], c1[1], broken, hash2(b.x, b.z, 44) * 10]), b.x, cy, b.z);
      att(b.bid, S.faces, S.faces.add(b.x - fx * d, cy, b.z - fz * d, b.yaw + Math.PI, 1, 1, 1, 0xffffff, [c2[0], c2[1], broken, hash2(b.x, b.z, 45) * 10]), b.x, cy, b.z);
      if (!b.roof) colliders.cyl(b.x, b.y + 5.5, b.z, 0.65, 5.5);
    }
    for (const s of blades) {
      att(s.bid, S.bladeBack, S.bladeBack.add(s.x, s.y, s.z, s.yaw), s.x, s.y, s.z);
      const c = neonCell(s.word);
      att(s.bid, S.bladeFace, S.bladeFace.add(s.x, s.y, s.z, s.yaw, 1, 1, 1, s.color, [c[0], c[1], s.flicker, 0]), s.x, s.y, s.z);
    }
    for (const s of strips) att(s.bid, S.strips, S.strips.add(s.x, s.y, s.z, s.yaw, s.len, s.h, 1, s.color, [0, 0, s.flicker, 0]), s.x, s.y, s.z);
    for (const s of Object.values(S)) s.finalize();
    this.list = Object.values(S);
    lap('instances');
    this.stats = {
      highway: nTall, rooftop: nRoof, blades: blades.length, strips: strips.length, ms: performance.now() - t0,
      ads: AD_IDS.length, adScale: this.adScale, adRepeatMin: Math.round(deal.minRepeat),
    };
    this.prof = prof;
  }

  // Deals ad cells to board faces (2 per board) in a hash-shuffled board order: each face takes, from the least-used
  // ads that differ from the other face and have no identical face within minDist metres, the one whose nearest twin
  // is farthest away (deterministic: hash-ordered candidates). If none qualifies, the farthest-twin ad wins.
  // O(faces * ads * placed) once at init (~240 faces x 68 ads). Returns { ads: Int32Array, minRepeat: metres }.
  dealAds(boards, nAds, minDist) {
    const n = boards.length, ads = new Int32Array(n * 2), used = new Int32Array(nAds);
    const px = new Float64Array(n * 2), pz = new Float64Array(n * 2), pa = new Int32Array(n * 2);
    let placed = 0, minRepeat = Infinity;
    const order = boards.map((b, i) => [hash2(b.x, b.z, 42), i]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
    const cand = Array.from({ length: nAds }, (_, a) => a), key = new Float64Array(nAds);
    const R2 = minDist * minDist;
    for (const bi of order) {
      const b = boards[bi];
      for (let f = 0; f < 2; f++) {
        for (let a = 0; a < nAds; a++) key[a] = used[a] + hash2(b.x + a * 13.7, b.z - a * 7.3, 43 + f) * 0.5;
        cand.sort((p, q) => key[p] - key[q]);
        // least-used tier first; inside the first tier that has a qualifying ad take the one whose twin is farthest away
        let best = -1, bestD = -1, tier = -1;
        for (const a of cand) {
          if (f === 1 && a === ads[bi * 2]) continue;
          if (bestD >= R2 && used[a] > tier) break;
          let d2 = Infinity;
          for (let k = 0; k < placed; k++) if (pa[k] === a) d2 = Math.min(d2, (px[k] - b.x) ** 2 + (pz[k] - b.z) ** 2);
          if (d2 > bestD) { best = a; bestD = d2; tier = used[a]; }
        }
        ads[bi * 2 + f] = best; used[best]++;
        if (bestD < Infinity) minRepeat = Math.min(minRepeat, Math.sqrt(bestD));
        px[placed] = b.x; pz[placed] = b.z; pa[placed] = best; placed++;
      }
    }
    return { ads, minRepeat: minRepeat === Infinity ? 0 : minRepeat };
  }

  placeHighway(game) {
    const { roads, terrain } = game;
    const out = [];
    const grid = new PointGrid(256);
    const G = terrain.G;
    // runways and airfield pieces are highway-wide edges too: no billboards along them or on the drawn pavement
    const lm = game.landmarks, hidden = lm?.hidden;
    const airfield = (q) => q.runway || q.airside || !!hidden?.has(q.i);
    for (const e of roads.edges) {
      if (e.kind !== 1 || e.len < 300 || airfield(e)) continue;
      for (let s = 160 + hash2(e.i, 7, 31) * 400; s < e.len - 140; s += 520) {
        if (out.length >= 90) return out;
        const p = roads.pointAt(e, s);
        if (e.br && (e.br[p.k] || e.br[p.k + 1])) continue;
        const side = hash2(e.i, s, 32) < 0.5 ? 1 : -1;
        const nx = -p.tz * side, nz = p.tx * side;
        const off = e.w / 2 + 11 + hash2(e.i, s, 33) * 5;
        const x = p.x + nx * off, z = p.z + nz * off;
        if (grid.any(x, z, 480)) continue;
        const h = terrain.heightAt(x, z);
        if (h < 0.5 || Math.abs(h - p.y) > 5) continue;
        const g = terrain.groundAt(x, z);
        if (g === G.water || g === G.road || g === G.building) continue;
        const n2 = roads.nearest(x, z, 40);
        if (n2 && n2.dist < n2.edge.w / 2 + 7) continue;
        const n3 = roads.nearest(x, z, 90, airfield);
        if (n3 && n3.dist < n3.edge.w / 2 + 40) continue;
        if (lm?.deckAt?.(x, z) != null) continue;
        if (game.buildings?.query && game.buildings.query(x, z, 20).length) continue;
        const a = 0.28;
        const vx = -p.tx * Math.cos(a) - nx * Math.sin(a), vz = -p.tz * Math.cos(a) - nz * Math.sin(a);
        out.push({ x, y: h - 0.2, z, yaw: Math.atan2(vx, vz), roof: false });
        grid.add(x, z);
      }
    }
    return out;
  }

  placeRooftops(game) {
    const B = game.buildings, out = [];
    if (!B?.recs) return out;
    const grid = new PointGrid(256);
    const cands = [];
    B.recs.forEach((r, id) => {
      if (!r || r.removed) return;
      const tall = r.style === 2 || r.style === 5;
      if (!(r.style === 0 || r.style === 1 || tall)) return;
      if (r.height < 14 || r.height > (tall ? 34 : 60)) return;
      const p = B.list[id].p;
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]); }
      if (x1 - x0 < 17 || z1 - z0 < 17) return;
      cands.push({ id, r, k: hash2(r.cx, r.cz, 51) });
    });
    cands.sort((a, b) => a.k - b.k);
    for (const c of cands) {
      if (out.length >= 30) break;
      const { r } = c;
      if (grid.any(r.cx, r.cz, 220)) continue;
      const area = game.world3d?.areaAt?.(r.cx, r.cz)?.name;
      if (!ROOF_AREAS.has(area)) continue;
      const n = game.roads.nearest(r.cx, r.cz, 160);
      if (!n) continue;
      const vx = n.x - r.cx, vz = n.z - r.cz;
      out.push({ x: r.cx, y: r.top + (r.style === 1 ? 2.6 : 0), z: r.cz, yaw: Math.atan2(vx, vz), roof: true, bid: c.id });
      grid.add(r.cx, r.cz);
    }
    return out;
  }

  placeBlades(game) {
    const B = game.buildings, out = [];
    if (!B?.recs) return out;
    const grid = new PointGrid(64);
    B.recs.forEach((r, id) => {
      if (!r || r.removed || out.length >= 110) return;
      if (!(r.style === 0 || r.style === 1) || r.height < 7.5 || r.height > 32) return;
      if (hash2(r.cx, r.cz, 61) > 0.45) return;
      if (grid.any(r.cx, r.cz, 55)) return;
      const area = game.world3d?.areaAt?.(r.cx, r.cz)?.name;
      if (!BLADE_AREAS.has(area)) return;
      const p = B.list[id].p;
      const n = p.length / 2;
      let A = 0;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; A += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
      const sgn = A > 0 ? 1 : -1; // shoelace > 0 → outward normal = (dz, -dx)
      let best = null;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 6) continue;
        const nx = ((bz - az) / L) * sgn, nz = (-(bx - ax) / L) * sgn;
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        const rd = game.roads.nearest(mx + nx * 5, mz + nz * 5, 28);
        if (!rd) continue;
        // road must be in front of this facade
        const fx = rd.x - mx, fz = rd.z - mz;
        if (fx * nx + fz * nz < 2) continue;
        const d = rd.dist - rd.edge.w / 2;
        if (!best || d < best.d) best = { d, mx, mz, nx, nz };
      }
      if (!best || best.d > 18) return;
      const out1 = 1.2;
      const y = r.base + Math.max(3.6, Math.min(r.height - 3.1, r.height * 0.58));
      const k = hash2(r.cx, r.cz, 62);
      out.push({
        x: best.mx + best.nx * out1, y, z: best.mz + best.nz * out1, yaw: Math.atan2(best.nx, best.nz),
        word: Math.floor(k * NEON_WORDS.length), color: NEON[Math.floor(hash2(r.cx, r.cz, 63) * NEON.length)],
        flicker: hash2(r.cx, r.cz, 64) < 0.15 ? 1 + k * 5 : 0, bid: id,
      });
      grid.add(r.cx, r.cz);
    });
    return out;
  }

  placeStrips(game) {
    const B = game.buildings, out = [];
    if (!B?.recs) return out;
    B.recs.forEach((r, id) => {
      if (!r || r.removed || out.length >= 2400) return;
      if (!(r.style === 2 || r.style === 5) || r.height < 45) return;
      if (hash2(r.cx, r.cz, 71) > 0.75) return;
      const area = game.world3d?.areaAt?.(r.cx, r.cz)?.name;
      if (!TOWER_AREAS.has(area)) return;
      // real-world (IRL) towers with setbacks: ring the highest roof part, not the whole lot (it would float in the air)
      let p = B.list[id].p, top = r.top;
      if (r.irl && r.roofs?.length) {
        const hi = r.roofs.reduce((a, f) => (f.y > a.y ? f : a));
        if (hi.p?.length >= 6) { p = hi.p; top = hi.y; }
      }
      const n = p.length / 2;
      let A = 0;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; A += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
      const sgn = A > 0 ? 1 : -1; // shoelace > 0 → outward normal = (dz, -dx)
      const color = NEON[Math.floor(hash2(r.cx, r.cz, 72) * 4)];
      const color2 = NEON[Math.floor(hash2(r.cx, r.cz, 73) * 4)];
      const bands = [top - 0.9];
      if (!r.irl && hash2(r.cx, r.cz, 74) < 0.3) bands.push(r.base + r.height * 0.5);
      const flick = hash2(r.cx, r.cz, 75) < 0.08 ? 3 : 0;
      for (const [bi, y] of bands.entries()) {
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
          const L = Math.hypot(bx - ax, bz - az);
          if (L < 4) continue;
          const ex = (bx - ax) / L, ez = (bz - az) / L;
          const nx = ez * sgn, nz = -ex * sgn;
          out.push({ x: (ax + bx) / 2 + nx * 0.16, y, z: (az + bz) / 2 + nz * 0.16, yaw: Math.atan2(-ez, ex), len: L + 0.3, h: bi ? 0.7 : 1.3, color: bi ? color2 : color, flicker: flick, bid: id });
        }
      }
    });
    return out;
  }

  update(cam, dt, force = false) { updateSets(this.list, cam, dt, force || this._detached, 2); this._detached = false; }

  /**
   * A building (or part of it) came down: hide the signs mounted on it. fallen(x, y, z) -> true for positions that
   * went with it (null = all). Returns the hidden positions (for debris / sparks).
   */
  detach(id, fallen = null) {
    const l = this.attached?.get(id);
    if (!l) return [];
    const out = [];
    for (const a of l) {
      if (a.gone || (fallen && !fallen(a.x, a.y, a.z))) continue;
      a.gone = true;
      a.set.setHidden(a.i, true);
      out.push(a);
    }
    if (out.length) this._detached = true;
    return out;
  }
}
