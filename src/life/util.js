// Shared helpers for the "life" workstream (beach props, signage, birds, collectibles, races, photo mode).

// Deterministic PRNG (mulberry32)
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stable 0..1 hash of a world position (+ salt)
export function hash2(x, z, salt = 0) {
  let h = Math.imul((Math.floor(x) | 0) ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul((Math.floor(z) | 0) + salt * 0x9e3779b1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function fill(s, params) {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
}

// i18n with inline English fallback: tr(game, 'life.race.go', 'GO!')
export function tr(game, key, fallback, params) {
  const s = game?.i18n?.t?.(key, params);
  return s && s !== key ? s : fill(fallback, params);
}

export function money(game, n) {
  return game?.i18n?.money?.(n) ?? `$${Math.round(n).toLocaleString('en-US')}`;
}

// All rewards go through the central economy (docs/ECONOMY.md, workstream L, src/economy): its high-level calls
// (collect / medal / speedTrap) when present, else game.economy.earn(reason, amount, pos, meta), else player.addMoney.
// Online the server recomputes/validates the claim. Returns the amount granted (shown in our pop-ups).
export function earn(game, reason, amount, pos, meta = {}) {
  amount = Math.round(amount);
  if (!(amount > 0)) return 0;
  const p = game?.player;
  const at = pos || (p?.focus ? { x: p.focus.x, y: p.focus.y, z: p.focus.z } : undefined);
  const eco = game?.economy;
  if (eco?.earn) {
    let g = 0;
    try { const r = eco.earn(reason, amount, at, meta); g = typeof r === 'number' ? r : amount; } catch (e) { console.warn('[life] economy.earn', e); }
    return granted(game, g, at, reason);
  }
  if (!p) return 0;
  if (p.addMoney) p.addMoney(amount, at, reason); // emits money:pickup itself
  else { p.money = (p.money || 0) + amount; game.events.emit('money:pickup', { amount, position: at, reason }); }
  return amount;
}

// economy calls don't emit money:pickup (the HUD's +$ pop): do it for amounts they granted
export function granted(game, amount, pos, reason) {
  if (amount > 0) game.events?.emit('money:pickup', { amount, position: pos, reason });
  return amount > 0 ? amount : 0;
}

// active quality profile (game.quality, or the renderer's profile when bootstrap did not attach it)
export function quality(game) {
  return game?.quality || game?.render?.profile || {};
}

export function isOnline(game) {
  return game?.online === true || game?.mode === 'online';
}

// Progress persistence: localStorage only in single-player and only for what the economy doesn't already store
// (it keeps found postcards, medals and trap bests: single-player in its save, online on the server).
export function restore(game, key, def) {
  return isOnline(game) ? def : loadJSON(key, def);
}
export function persist(game, key, value) {
  if (!isOnline(game)) saveJSON(key, value);
}

// economy progress snapshot (or null): { found: Set<id>, medals: { trialId: bitmask 1 gold | 2 silver | 4 bronze }, traps: { trapId: kmh } }
export function ecoProgress(game) {
  const e = game?.economy;
  return e ? { found: e.found, medals: e.medals, traps: e.traps } : null;
}
export const MEDAL_BIT = { gold: 1, silver: 2, bronze: 4 };

export function loadJSON(key, def) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v ?? def;
  } catch { return def; }
}

export function saveJSON(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ }
}

// 83456 ms -> "1:23.45"
export function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '--:--.--';
  const neg = ms < 0;
  ms = Math.abs(ms);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const c = Math.floor((ms % 1000) / 10);
  return `${neg ? '-' : ''}${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const smooth = (x, a, b) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// land vehicles that can race / trigger speed traps
export const LAND_KINDS = new Set(['car', 'truck', 'bus', 'van', 'small', 'motorcycle', 'bicycle']);

// Simple uniform spatial hash for "is anything within r" queries during placement.
export class PointGrid {
  constructor(cell = 64) { this.cell = cell; this.map = new Map(); }
  key(i, j) { return i * 73856093 ^ j * 19349663; }
  add(x, z, v = true) {
    const k = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    let l = this.map.get(k);
    if (!l) this.map.set(k, (l = []));
    l.push(x, z, v);
  }
  // true if a point closer than r exists
  any(x, z, r) {
    const c = this.cell, r2 = r * r;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) {
      for (let j = Math.floor((z - r) / c); j <= Math.floor((z + r) / c); j++) {
        const l = this.map.get(this.key(i, j));
        if (!l) continue;
        for (let q = 0; q < l.length; q += 3) {
          const dx = l[q] - x, dz = l[q + 1] - z;
          if (dx * dx + dz * dz < r2) return true;
        }
      }
    }
    return false;
  }
  // random stored value in the ring rMin..rMax (reservoir sampling; low-rate use)
  sample(x, z, rMin, rMax, rnd = Math.random) {
    const c = this.cell, a2 = rMin * rMin, b2 = rMax * rMax;
    let pick = null, n = 0;
    for (let i = Math.floor((x - rMax) / c); i <= Math.floor((x + rMax) / c); i++) {
      for (let j = Math.floor((z - rMax) / c); j <= Math.floor((z + rMax) / c); j++) {
        const l = this.map.get(this.key(i, j));
        if (!l) continue;
        for (let q = 0; q < l.length; q += 3) {
          const dx = l[q] - x, dz = l[q + 1] - z, d2 = dx * dx + dz * dz;
          if (d2 < a2 || d2 > b2) continue;
          n++;
          if (rnd() * n < 1) pick = l[q + 2];
        }
      }
    }
    return pick;
  }

  // nearest stored value within r (or null)
  nearest(x, z, r) {
    const c = this.cell;
    let best = null, bd = r * r;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) {
      for (let j = Math.floor((z - r) / c); j <= Math.floor((z + r) / c); j++) {
        const l = this.map.get(this.key(i, j));
        if (!l) continue;
        for (let q = 0; q < l.length; q += 3) {
          const dx = l[q] - x, dz = l[q + 1] - z, d2 = dx * dx + dz * dz;
          if (d2 < bd) { bd = d2; best = l[q + 2]; }
        }
      }
    }
    return best;
  }
}

// run fn once the UI web fonts are available (canvas text is redrawn with them); 6 s timeout
let fontPromise = null;
export function whenFontsReady(fn) {
  if (typeof document === 'undefined' || !document.fonts) return;
  fontPromise ||= Promise.race([
    Promise.all(['40px "Russo One"', '500 30px Oswald', '700 30px Oswald', '30px Yellowtail'].map((f) => document.fonts.load(f).catch(() => null))),
    new Promise((r) => setTimeout(r, 6000)),
  ]);
  fontPromise.then(() => fn());
}
