import * as THREE from 'three';
import { GLOBAL_UNIFORMS } from '../core/globals.js';
import { postcardGeo } from './geometry.js';
import { tr, earn, granted, money, restore, persist, ecoProgress, PointGrid, rng, hash2, whenFontsReady } from './util.js';
import { collectiblePay, COLLECTIBLES } from '../economy/rules.js';

const U = GLOBAL_UNIFORMS;
const STORE = 'leonida.collectibles';
export const POSTCARD_COUNT = 60;
// payouts: docs/ECONOMY.md via src/economy/rules.js — $1,000 per card, every 10 found +$10,000, all 60 +$100,000

// 60 hidden "Leonida postcards": glowing spinning cards at landmarks, pier heads, rooftops, hilltops and scenic spots.
// Pick-up pays through game.economy.collect(id) (set bonuses included), emits 'collectible:pickup' and, every 10 found,
// 'collectible:set' {count, total, bonus, complete} (informational: the economy already paid the bonus).
// Progress: game.economy.found (its save / the server); localStorage 'leonida.collectibles' only without an economy.
export class Collectibles {
  constructor(game, root, hud, extra = {}) {
    this.game = game;
    this.hud = hud;
    this.spots = placePostcards(game, extra);
    this.total = this.spots.length;
    this.ids = new Set(this.spots.map((s) => s.id));
    let saved = restore(game, STORE, []);
    if (!Array.isArray(saved)) saved = [];
    this.collected = new Set(saved.filter((id) => this.ids.has(id)));
    this.mergeEconomy();
    // progress may arrive later (save restored, server state applied)
    game.events.on('economy:change', () => { if (this.mergeEconomy()) this.rebuild(); });

    const tex = makePostcardTexture(game.renderer);
    this.texture = tex;
    const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.5, roughness: 0.45, metalness: 0.0 });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = U.uTime;
      sh.uniforms.uNight = U.uNight;
      const spin = `
        float lfPh = instanceMatrix[3].x * 0.13 + instanceMatrix[3].z * 0.07;
        float lfA = uTime * 1.7 + lfPh;
        float lfC = cos(lfA), lfS = sin(lfA);`;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          ${spin}
          objectNormal.xz = vec2(lfC * objectNormal.x + lfS * objectNormal.z, -lfS * objectNormal.x + lfC * objectNormal.z);`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          transformed.xz = vec2(lfC * transformed.x + lfS * transformed.z, -lfS * transformed.x + lfC * transformed.z);
          transformed.y += sin(uTime * 2.1 + lfPh) * 0.14;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uNight; uniform float uTime;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance *= (0.65 + 1.6 * uNight) * (0.9 + 0.1 * sin(uTime * 5.0));`);
    };
    mat.customProgramCacheKey = () => 'life-postcard';
    this.cards = new THREE.InstancedMesh(postcardGeo().scale(1.25, 1.25, 1.25), mat, this.total);
    this.cards.name = 'life-postcards';
    this.cards.frustumCulled = false;
    this.cards.castShadow = false;
    root.add(this.cards);

    const haloMat = new THREE.ShaderMaterial({
      uniforms: { uTime: U.uTime, uNight: U.uNight },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        uniform float uTime;
        varying vec2 vUv; varying float vFade;
        void main() {
          vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          vec4 mv = viewMatrix * vec4(c, 1.0);
          float d = -mv.z;
          float s = 3.2 * (1.0 + 0.12 * sin(uTime * 3.0 + c.x));
          mv.xy += position.xy * s;
          vUv = position.xy;
          vFade = smoothstep(2.0, 8.0, d) * (1.0 - smoothstep(180.0, 320.0, d));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uNight;
        varying vec2 vUv; varying float vFade;
        void main() {
          float r = length(vUv) * 2.0;
          float a = pow(max(0.0, 1.0 - r), 2.2);
          vec3 col = mix(vec3(1.0, 0.62, 0.25), vec3(1.0, 0.3, 0.7), r);
          gl_FragColor = vec4(col * a * vFade * (0.55 + 1.3 * uNight), 1.0);
        }`,
    });
    this.halos = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), haloMat, this.total);
    this.halos.name = 'life-postcard-halos';
    this.halos.frustumCulled = false;
    this.halos.renderOrder = 4;
    root.add(this.halos);
    this.materials = [mat, haloMat];
    this.rebuild();
    this._t = 0;
    this._retry = 0;
  }

  get count() { return this.collected.size; }

  // found ids from the economy (single-player save or the server)
  mergeEconomy() {
    const ids = ecoProgress(this.game)?.found;
    if (!ids) return false;
    let changed = false;
    for (const id of ids) if (this.ids.has(id) && !this.collected.has(id)) { this.collected.add(id); changed = true; }
    return changed;
  }

  rebuild() {
    const m = new THREE.Matrix4();
    let k = 0;
    for (const s of this.spots) {
      if (this.collected.has(s.id)) continue;
      m.makeTranslation(s.x, s.y, s.z);
      this.cards.setMatrixAt(k, m);
      this.halos.setMatrixAt(k, m);
      k++;
    }
    this.cards.count = k;
    this.halos.count = k;
    this.cards.instanceMatrix.needsUpdate = true;
    this.halos.instanceMatrix.needsUpdate = true;
    this.live = this.spots.filter((s) => !this.collected.has(s.id));
  }

  update(dt, game) {
    if (this._retry > 0) this._retry -= dt;
    const p = game.player;
    if (!p?.focus || !this.live.length) return;
    const f = p.focus;
    const v = p.mode === 'vehicle' ? p.controllable : null;
    const air = v && (v.kind === 'heli' || v.kind === 'plane');
    const r = !v ? 2.4 : air ? 8 : v.kind === 'boat' ? 6 : 5.2;
    const L = this.live;
    for (let i = 0; i < L.length; i++) {
      const s = L[i];
      const dx = s.x - f.x, dz = s.z - f.z;
      if (dx * dx + dz * dz > r * r) continue;
      if (Math.abs(s.y - f.y - (v ? 0.6 : 0.9)) > r + 1.6) continue;
      this.pickup(s);
      break;
    }
  }

  pickup(s) {
    const g = this.game;
    if (this.collected.has(s.id) || this._retry > 0) return;
    const pos = { x: s.x, y: s.y, z: s.z };
    const eco = g.economy;
    let paid;
    if (eco?.collect) {
      const got = eco.collect(s.id, pos);
      // refused (claim cooldown): leave the card in the world and retry shortly
      if (eco.found && !eco.found.has(s.id)) { this._retry = 0.6; return; }
      paid = granted(g, got, pos, 'collectible');
      this.collected.add(s.id);
    } else {
      this.collected.add(s.id);
      paid = earn(g, 'collectible', collectiblePay(this.collected.size, this.total), pos, { id: s.id, count: this.collected.size });
      persist(g, STORE, [...this.collected]);
    }
    this.rebuild();
    const n = this.collected.size; // what the player sees (economy-found ids are merged into it)
    let extra = '', bonus = 0;
    if (n % COLLECTIBLES.every === 0 || n === this.total) {
      const complete = n >= this.total;
      bonus = (collectiblePay(n, this.total) - COLLECTIBLES.each) * (g.economy?.incomeScale?.('collectible') ?? 1); // ×2 online
      extra = complete ? tr(g, 'life.pc.complete', 'ALL POSTCARDS FOUND!') : tr(g, 'life.pc.milestone', 'Set bonus');
      if (bonus > 0) extra += ` +${money(g, bonus)}`;
      g.events.emit('collectible:set', { kind: 'postcard', count: n, total: this.total, bonus, complete });
    }
    this.hud.pop(tr(g, 'life.pc.title', 'POSTCARD FOUND'), `${n} / ${this.total}`, extra || s.name, paid ? `+${money(g, paid)}` : '', 3.2, '#f5c84c');
    g.events.emit('collectible:pickup', { id: s.id, kind: 'postcard', name: s.name, count: n, total: this.total, reward: paid, bonus, position: pos });
  }

  // for map/radar integration: uncollected spots are secret, so only expose collected ones + nearest hint
  nearest(x, z) {
    let best = null, bd = Infinity;
    for (const s of this.live) { const d = Math.hypot(s.x - x, s.z - z); if (d < bd) { bd = d; best = s; } }
    return best ? { spot: best, dist: bd } : null;
  }

  // lab helper: forget local progress (the economy's found set is not touched)
  reset() {
    this.collected.clear();
    persist(this.game, STORE, []);
    this.rebuild();
  }
}

// ------------------------------------------------------------------------------------------------ placement
function inside(poly, x, z) {
  let c = false;
  for (let i = 0, j = poly.length / 2 - 1; i < poly.length / 2; j = i++) {
    const xi = poly[i * 2], zi = poly[i * 2 + 1], xj = poly[j * 2], zj = poly[j * 2 + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

function buildingAt(game, x, z) {
  const B = game.buildings;
  if (!B?.query) return -1;
  for (const id of B.query(x, z, 90)) if (inside(B.list[id].p, x, z)) return id;
  return -1;
}

// a point on a building roof 1.5 m in from its first corner (clear of the crown/setback)
function roofSpot(game, id) {
  const B = game.buildings, r = B.recs[id];
  // real-world towers: stand on the highest roof part (nudged in from its first corner), not on the lot outline
  if (r.irl && r.roofs?.length) {
    const hi = r.roofs.reduce((a, f) => (f.y > a.y ? f : a));
    const q = hi.p;
    if (q?.length >= 6) {
      let cx = 0, cz = 0;
      for (let i = 0; i < q.length; i += 2) { cx += q[i]; cz += q[i + 1]; }
      cx /= q.length / 2; cz /= q.length / 2;
      const dx = cx - q[0], dz = cz - q[1], L = Math.hypot(dx, dz) || 1;
      return { x: q[0] + (dx / L) * 1.8, y: hi.y + 1.5, z: q[1] + (dz / L) * 1.8 };
    }
  }
  const p = B.list[id].p;
  const dx = r.cx - p[0], dz = r.cz - p[1], L = Math.hypot(dx, dz) || 1;
  return { x: p[0] + (dx / L) * 1.8, y: r.top + 1.5, z: p[1] + (dz / L) * 1.8 };
}

function roadSide(game, x, z) {
  const n = game.roads.nearest(x, z, 600, (e) => e.kind !== 1);
  if (!n) return null;
  const off = n.edge.w / 2 + 2.5;
  const sx = n.x - n.dir[1] * off, sz = n.z + n.dir[0] * off;
  if (buildingAt(game, sx, sz) >= 0) return { x: n.x, y: n.y + 1.5, z: n.z };
  return { x: sx, y: Math.max(game.terrain.heightAt(sx, sz), n.y) + 1.5, z: sz };
}

export function placePostcards(game, extra = {}) {
  const { terrain } = game;
  const W = game.worldData || {};
  const out = [];
  const grid = new PointGrid(256);
  const add = (x, y, z, kind, minSep = 250) => {
    if (out.length >= POSTCARD_COUNT || !Number.isFinite(x + y + z)) return false;
    if (grid.any(x, z, minSep)) return false;
    const name = game.world3d?.areaAt?.(x, z)?.name || 'Leonida';
    out.push({ id: `pc_${Math.round(x)}_${Math.round(z)}`, x, y, z, kind, name });
    grid.add(x, z);
    return true;
  };
  // 1. landmarks (rooftop if the landmark is a tall building, else beside it)
  for (const l of W.landmarks || []) {
    const b = buildingAt(game, l.x, l.z);
    if (b >= 0) {
      const r = game.buildings.recs[b];
      if (r && r.height > 50) { const s = roofSpot(game, b); add(s.x, s.y, s.z, 'rooftop', 150); continue; }
      const s = roadSide(game, l.x, l.z);
      if (s) add(s.x, s.y, s.z, 'landmark', 150);
      continue;
    }
    const h = terrain.heightAt(l.x, l.z);
    add(l.x, Math.max(h, 0) + 1.5, l.z, h < 0 ? 'sea' : 'landmark', 150);
  }
  // 2. pier heads
  for (const p of extra.piers || []) if (p.end) add(p.end.x, p.end.y + 1.5, p.end.z, 'pier', 300);
  // 3. the tallest towers (helicopter challenge)
  const recs = (game.buildings?.recs || []).map((r, id) => ({ r, id })).filter((o) => o.r && !o.r.removed && o.r.height > 60).sort((a, b) => b.r.height - a.r.height);
  let roofs = 0;
  for (const { id } of recs) { if (roofs >= 3) break; const s = roofSpot(game, id); if (add(s.x, s.y, s.z, 'rooftop', 350)) roofs++; }
  // 4. hilltops
  const hills = [];
  const CELL = 400;
  for (let z = terrain.z0 + CELL / 2; z < terrain.z1; z += CELL) {
    for (let x = terrain.x0 + CELL / 2; x < terrain.x1; x += CELL) {
      let best = -1, bx = 0, bz = 0;
      for (let j = -CELL / 2; j < CELL / 2; j += 16) for (let i = -CELL / 2; i < CELL / 2; i += 16) {
        const h = terrain.heightAt(x + i, z + j);
        if (h > best) { best = h; bx = x + i; bz = z + j; }
      }
      if (best > 28) hills.push({ x: bx, z: bz, h: best });
    }
  }
  hills.sort((a, b) => b.h - a.h);
  let nh = 0;
  for (const hl of hills) { if (nh >= 8) break; if (buildingAt(game, hl.x, hl.z) >= 0) continue; if (add(hl.x, hl.h + 1.5, hl.z, 'hilltop', 1400)) nh++; }
  // 5. lifeguard tower platforms (walk up the ramp)
  let nt = 0;
  for (const t of extra.towers || []) {
    if (nt >= 5) break;
    const fx = Math.sin(t.yaw), fz = Math.cos(t.yaw);
    if (add(t.x + fx * 1.4, t.y + 2.66 + 1.2, t.z + fz * 1.4, 'tower', 900)) nt++;
  }
  // 6. districts (beside the nearest street)
  const ds = (W.districts || []).filter((d) => d.n >= 15).sort((a, b) => hash2(a.x, a.z, 81) - hash2(b.x, b.z, 81));
  for (const d of ds) {
    if (out.length >= 46) break;
    const s = roadSide(game, d.x + (hash2(d.x, d.z, 82) - 0.5) * d.r * 0.6, d.z + (hash2(d.x, d.z, 83) - 0.5) * d.r * 0.6);
    if (s) add(s.x, s.y, s.z, 'district', 650);
  }
  // 7. fill with deterministic scenic road spots across the state
  const R = rng(1987);
  for (let tries = 0; tries < 4000 && out.length < POSTCARD_COUNT; tries++) {
    const e = game.roads.edges[Math.floor(R() * game.roads.edges.length)];
    if (!e || e.kind === 1 || e.len < 60) continue;
    const p = game.roads.pointAt(e, e.len * (0.2 + R() * 0.6));
    if (p.y < 0.5) continue;
    const off = e.w / 2 + 2.5, side = R() < 0.5 ? 1 : -1;
    const x = p.x - p.tz * off * side, z = p.z + p.tx * off * side;
    if (buildingAt(game, x, z) >= 0) continue;
    add(x, Math.max(terrain.heightAt(x, z), p.y) + 1.5, z, 'scenic', 900);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ texture
function drawPostcard(canvas) {
  const W = 1024, H = 352;
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  // front (left half): retro "Greetings from Leonida"
  const fw = 512;
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#2a1a5e'); sky.addColorStop(0.45, '#ff3fa4'); sky.addColorStop(0.75, '#ffb347'); sky.addColorStop(1, '#29d0e0');
  g.fillStyle = sky; g.fillRect(0, 0, fw, H);
  // sun with stripes
  g.save(); g.beginPath(); g.arc(fw / 2, 210, 110, 0, Math.PI * 2); g.clip();
  const sun = g.createLinearGradient(0, 100, 0, 320); sun.addColorStop(0, '#fff3a0'); sun.addColorStop(1, '#ff4f7a');
  g.fillStyle = sun; g.fillRect(0, 90, fw, 240);
  g.fillStyle = '#ff7ab8'; for (let i = 0; i < 6; i++) g.fillRect(0, 222 + i * 16, fw, 3 + i * 1.5);
  g.restore();
  // sea
  g.fillStyle = '#1aa6c0'; g.fillRect(0, 262, fw, H - 262);
  g.fillStyle = 'rgba(255,255,255,0.35)'; for (let i = 0; i < 14; i++) g.fillRect(30 + ((i * 97) % 440), 275 + (i % 5) * 14, 40, 3);
  // palms
  const palm = (x, y, s, flip) => {
    g.save(); g.translate(x, y); g.scale(flip ? -s : s, s); g.strokeStyle = '#1b1030'; g.fillStyle = '#1b1030'; g.lineCap = 'round';
    g.lineWidth = 9; g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(20, -90, 4, -190); g.stroke();
    for (const a of [-2.8, -2.2, -1.6, -1.0, -0.4, 0.2]) { g.beginPath(); g.moveTo(4, -190); g.quadraticCurveTo(4 + Math.cos(a) * 50, -215 + Math.sin(a) * 18, 4 + Math.cos(a) * 95, -175 + Math.sin(a) * 40); g.lineWidth = 8; g.stroke(); }
    g.restore();
  };
  palm(60, 352, 1.1, false); palm(470, 352, 0.95, true);
  // lettering
  g.textAlign = 'center';
  g.font = "52px Yellowtail, 'Brush Script MT', cursive";
  g.lineWidth = 6; g.strokeStyle = '#2a1a5e'; g.strokeText('Greetings from', fw / 2, 74); g.fillStyle = '#fff'; g.fillText('Greetings from', fw / 2, 74);
  g.font = "108px 'Russo One', 'Arial Black', Impact, sans-serif";
  const grd = g.createLinearGradient(0, 100, 0, 200); grd.addColorStop(0, '#fff6a0'); grd.addColorStop(1, '#ff8a3d');
  g.lineWidth = 12; g.strokeStyle = '#2a1a5e'; g.strokeText('LEONIDA', fw / 2, 190);
  g.fillStyle = grd; g.fillText('LEONIDA', fw / 2, 190);
  g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 10; g.strokeRect(5, 5, fw - 10, H - 10);
  // back (right half)
  g.fillStyle = '#f4ecd8'; g.fillRect(fw, 0, fw, H);
  g.strokeStyle = '#c9b88f'; g.lineWidth = 2; g.beginPath(); g.moveTo(fw + 260, 30); g.lineTo(fw + 260, H - 30); g.stroke();
  for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(fw + 290, 170 + i * 42); g.lineTo(fw + 490, 170 + i * 42); g.stroke(); }
  g.fillStyle = '#ff3fa4'; g.fillRect(fw + 400, 26, 86, 100);
  g.fillStyle = '#29d0e0'; g.fillRect(fw + 408, 34, 70, 84);
  g.fillStyle = '#ffd23a'; g.beginPath(); g.arc(fw + 443, 80, 20, 0, 7); g.fill();
  g.strokeStyle = 'rgba(40,30,80,0.55)'; g.lineWidth = 3; g.beginPath(); g.arc(fw + 380, 90, 44, 0, 7); g.stroke();
  for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(fw + 300, 70 + i * 10); g.bezierCurveTo(fw + 340, 60 + i * 10, fw + 370, 80 + i * 10, fw + 420, 70 + i * 10); g.stroke(); }
  g.fillStyle = '#5a4a7a'; g.textAlign = 'left';
  g.font = "26px Yellowtail, 'Brush Script MT', cursive";
  g.fillText('Wish you were here!', fw + 30, 90);
  g.fillText('Sun, sand & speeding.', fw + 30, 140);
  g.font = "18px Oswald, 'Arial Narrow', sans-serif"; g.fillStyle = '#8a7a5a';
  g.fillText('POSTCARD · STATE OF LEONIDA', fw + 30, H - 30);
  g.fillStyle = '#fff'; g.fillRect(W - 6, 0, 6, 6); // white corner used by the card edges
}

function makePostcardTexture(renderer) {
  const canvas = document.createElement('canvas');
  drawPostcard(canvas);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(4, renderer?.capabilities?.getMaxAnisotropy?.() || 1);
  whenFontsReady(() => { drawPostcard(canvas); tex.needsUpdate = true; });
  return tex;
}
