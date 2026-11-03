// HUD radar: heading-up vector map (cached tiles), speed/altitude zoom, GPS route, waypoint with edge arrow,
// blips, remote players, north marker, soft edges. Allocation-free per frame once tiles are cached.
import { drawTiles } from './tiles.js';
import { PALETTES } from './style.js';
import { strokeRoute, nearestRouteIndex, lastRouteIndexWithin, ROUTE_STYLE } from './route.js';
import { shieldSprite } from './shields.js';
import { PlayerOverlay } from './Players.js';

// route shields on the radar: world spacing between anchors per route kind, max radar m/px shown
const RADAR_SHIELDS = { I: 430, US: 430, SR: 400 };
const SHIELD_MAX_MPP = 4.2;
const SHIELD_CELL = 512;

const TILE_OPTS = { margin: 0.1, prefetchUp: true, prefetchDown: false };

const TAU = Math.PI * 2;

function roundRectPath(p, x, y, w, h, r) {
  p.moveTo(x + r, y);
  p.arcTo(x + w, y, x + w, y + h, r);
  p.arcTo(x + w, y + h, x, y + h, r);
  p.arcTo(x, y + h, x, y, r);
  p.arcTo(x, y, x + w, y, r);
  p.closePath();
  return p;
}

export class Radar {
  constructor(carto) {
    this.carto = carto;
    this.players = new PlayerOverlay(arrow, { budget: 24, labelBudget: 8, small: true });
    this.pool = carto.pool;
    this.zoom = 1;
    this.mpp = 1.4;
    this.view = { cx: 0, cz: 0, mpp: 1.4, rot: 0, ox: 0, oy: 0, w: 0, h: 0, dpr: 1 };
    this.w = 0; this.h = 0; this.dpr = 0;
    this.clip = null; this.border = null; this.vignette = null;
    this.lim = [0, 0];
    this.northLabel = 'N';
    this.font = '600 11px Oswald, "Arial Narrow", sans-serif';
    this.wpPulse = 0;
    this.time = 0;
    this.stats = { frames: 0, ms: 0, max: 0 };
    this.buildShieldAnchors(carto.map);
  }

  // fixed world anchors along every numbered route (stable while driving / rotating), bucketed in a grid
  buildShieldAnchors(map) {
    const set = map?.sets?.rt, routes = map?.routes;
    const xs = [], zs = [], rs = [];
    if (set && routes) {
      for (let i = 0; i < set.n; i++) {
        const r = set.parts[i * 4], route = routes[r];
        const step = route && RADAR_SHIELDS[route.kind];
        if (!step) continue;
        const s0 = set.start[i], n = set.start[i + 1] - s0, xy = set.xy;
        let acc = step * 0.5;
        for (let k = 1; k < n; k++) {
          const ax = xy[(s0 + k - 1) * 2], az = xy[(s0 + k - 1) * 2 + 1], bx = xy[(s0 + k) * 2], bz = xy[(s0 + k) * 2 + 1];
          const L = Math.hypot(bx - ax, bz - az);
          let t = 0;
          while (acc <= L - t) { t += acc; acc = step; xs.push(ax + (bx - ax) * (t / L)); zs.push(az + (bz - az) * (t / L)); rs.push(r); }
          acc -= L - t;
        }
      }
    }
    const n = xs.length;
    this.sh = { n, x: Float32Array.from(xs), z: Float32Array.from(zs), r: Int16Array.from(rs), a: new Float32Array(n), seen: new Int32Array(n).fill(-9),
      grid: new Map(), placed: new Float32Array(64 * 3), routes: routes || [], spr: [] };
    for (let i = 0; i < n; i++) {
      const key = Math.floor(xs[i] / SHIELD_CELL) * 65536 + Math.floor(zs[i] / SHIELD_CELL);
      let l = this.sh.grid.get(key);
      if (!l) this.sh.grid.set(key, (l = []));
      l.push(i);
    }
  }

  // shields near the player, kept upright, faded in / out, never on the player arrow or on top of each other
  drawShields(ctx, w, h, ox, oy, mpp, dt, dpr) {
    const S = this.sh;
    if (!S || !S.n) return;
    const frame = this.stats.frames;
    const on = mpp <= SHIELD_MAX_MPP;
    if (!on && !this._shieldsOn) return;
    this._shieldsOn = false;
    const R = Math.hypot(Math.max(ox, w - ox), Math.max(oy, h - oy)) * mpp + 60;
    const c0 = Math.floor((this._px - R) / SHIELD_CELL), c1 = Math.floor((this._px + R) / SHIELD_CELL);
    const r0 = Math.floor((this._pz - R) / SHIELD_CELL), r1 = Math.floor((this._pz + R) / SHIELD_CELL);
    const P = S.placed;
    let np = 0;
    const k = Math.min(1, dt * 5);
    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = r0; cz <= r1; cz++) {
        const list = S.grid.get(cx * 65536 + cz);
        if (!list) continue;
        for (let li = 0; li < list.length; li++) {
          const i = list[li];
          if (S.seen[i] < frame - 1) S.a[i] = 0; // was off-screen: start from transparent
          S.seen[i] = frame;
          const x = this.sx(S.x[i], S.z[i]), y = this.sy(S.x[i], S.z[i]);
          let want = on && x > 16 && x < w - 16 && y > 14 && y < h - 14 && (x - ox) * (x - ox) + (y - oy) * (y - oy) > 900;
          if (want) {
            for (let q = 0; q < np; q++) {
              const dx = Math.abs(P[q * 3] - x), dy = Math.abs(P[q * 3 + 1] - y);
              if ((dx < 30 && dy < 24) || (P[q * 3 + 2] === S.r[i] && dx * dx + dy * dy < 110 * 110)) { want = false; break; }
            }
          }
          S.a[i] += ((want ? 1 : 0) - S.a[i]) * k;
          if (S.a[i] < 0.02) continue;
          this._shieldsOn = true;
          if (want && np < 64) { P[np * 3] = x; P[np * 3 + 1] = y; P[np * 3 + 2] = S.r[i]; np++; }
          const ri = S.r[i];
          let sp = S.spr[ri];
          if (!sp) { const route = S.routes[ri]; sp = S.spr[ri] = shieldSprite(route.kind, route.num, dpr, 0.86); }
          ctx.globalAlpha = S.a[i];
          ctx.drawImage(sp.canvas, x - sp.w / 2, y - sp.h / 2, sp.w, sp.h);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  setup(ctx, w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr;
    const r = Math.min(16, h * 0.12);
    this.clip = roundRectPath(new Path2D(), 0, 0, w, h, r);
    this.border = roundRectPath(new Path2D(), 1, 1, w - 2, h - 2, r - 1);
    // soft inner shadow, pre-rendered once
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * dpr); c.height = Math.ceil(h * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.save();
    g.clip(this.clip);
    g.shadowColor = 'rgba(0, 0, 0, 0.6)';
    g.shadowBlur = 16 * dpr;
    g.lineWidth = 40;
    g.strokeStyle = '#000';
    g.stroke(roundRectPath(new Path2D(), -20, -20, w + 40, h + 40, r + 20));
    g.restore();
    // faint top light
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(255,255,255,0.06)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0)');
    g.save(); g.clip(this.clip); g.fillStyle = grad; g.fillRect(0, 0, w, h); g.restore();
    this.vignette = c;
    this.pool.setDpr('radar', dpr);
    if (this.sh) this.sh.spr = []; // shield sprites are rendered for the device pixel ratio
  }

  sx(x, z) { return this._ox + (this._c * (x - this._px) - this._s * (z - this._pz)) / this._mpp; }
  sy(x, z) { return this._oy + (this._s * (x - this._px) + this._c * (z - this._pz)) / this._mpp; }

  drawPlayers(ctx, list, w, h, rot) {
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      const x = this.sx(o.x, o.z), y = this.sy(o.x, o.z);
      if (x < -8 || x > w + 8 || y < -8 || y > h + 8) continue;
      if (o.heading === undefined) pin(ctx, x, y, o.color || '#ffd23f', 4.5);
      else arrow(ctx, x, y, rot + o.heading, 6.5, o.color || '#4fd1ff');
    }
  }

  draw(ctx, w, h, s, dt) {
    const t0 = performance.now();
    const dpr = ctx.canvas.width / w;
    if (w !== this.w || h !== this.h || dpr !== this.dpr || !this.clip) this.setup(ctx, w, h, dpr);
    const game = this.carto.game;
    const pl = game?.player;
    // zoom: out with speed and altitude
    const speed = s.speedKmh || 0;
    const target = 1 + Math.min(1.5, speed / 130);
    this.zoom += (target - this.zoom) * Math.min(1, dt * 1.4);
    const alt = s.radarAlt || 0;
    const mppT = 1.35 * this.zoom * (alt > 0 ? 1 + alt / 110 : 1);
    this.mpp += (mppT - this.mpp) * Math.min(1, dt * 3);
    const mpp = this.mpp;
    const ox = w * 0.5, oy = h * 0.62;
    const rot = s.heading || 0;
    const v = this.view;
    v.cx = s.x; v.cz = s.z; v.mpp = mpp; v.rot = rot; v.ox = ox; v.oy = oy; v.w = w; v.h = h; v.dpr = dpr;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clip(this.clip);
    ctx.fillStyle = PALETTES.radar.water;
    ctx.fillRect(0, 0, w, h);
    drawTiles(ctx, this.pool, 'radar', v, TILE_OPTS);

    const cos = Math.cos(rot), sin = Math.sin(rot);
    this.time += dt;
    // GPS route (world transform is still set by drawTiles); clipped by the radar frame
    const route = s.route || pl?.route;
    if (route && route.length >= 4) {
      const R = Math.hypot(w, h) * mpp;
      const i0 = nearestRouteIndex(route, s.x, s.z);
      const i1 = lastRouteIndexWithin(route, i0, s.x, s.z, R);
      strokeRoute(ctx, route, i0, i1, mpp, this.time, ROUTE_STYLE.radar);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._c = cos; this._s = sin; this._px = s.x; this._pz = s.z; this._ox = ox; this._oy = oy; this._mpp = mpp;
    // route shields (interstate / US / state road numbers)
    this.drawShields(ctx, w, h, ox, oy, mpp, dt, dpr);

    // blips (parked vehicles etc.)
    if (s.blips) {
      for (let i = 0; i < s.blips.length; i++) {
        const b = s.blips[i];
        const x = this.sx(b.x, b.z), y = this.sy(b.x, b.z);
        if (x < -6 || x > w + 6 || y < -6 || y > h + 6) continue;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(x - 5, y - 5, 10, 10);
        ctx.fillStyle = b.color || '#5cc0ff';
        ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
      }
    }
    // remote players (arrows in their colour): cartography.setPlayers() and/or the HUD's playerBlips
    if (this.carto.playersOn()) this.players.draw(ctx, this.carto.players.length ? this.carto.players : (s.playerBlips || []), this.view);
    // north marker on the rim
    {
      const dx = Math.sin(rot), dy = -Math.cos(rot);
      const e = clampToRect(dx * 1e4, dy * 1e4, ox - 11, oy - 11, w - ox - 11, h - oy - 11, this.lim);
      const nx = ox + e[0], ny = oy + e[1];
      ctx.beginPath();
      ctx.arc(nx, ny, 9.5, 0, TAU);
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = this.font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.northLabel, nx, ny + 0.5);
    }
    // waypoint (clamped to the rim with an edge arrow)
    const wp = s.waypoint !== undefined ? s.waypoint : pl?.waypoint;
    if (wp) {
      this.wpPulse = (this.wpPulse + dt) % 1.6;
      const x = this.sx(wp.x, wp.z) - ox, y = this.sy(wp.x, wp.z) - oy;
      const lim = clampToRect(x, y, ox - 22, oy - 22, w - ox - 22, h - oy - 22, this.lim);
      const px = ox + lim[0], py = oy + lim[1];
      const clamped = lim[0] !== x || lim[1] !== y;
      if (clamped) {
        // off-radar: arrow beyond the pin, pointing towards the waypoint
        const a = Math.atan2(y, x);
        const ca = Math.cos(a), sa = Math.sin(a);
        ctx.beginPath();
        ctx.moveTo(px + ca * 19, py + sa * 19);
        ctx.lineTo(px + ca * 11 - sa * 6, py + sa * 11 + ca * 6);
        ctx.lineTo(px + ca * 11 + sa * 6, py + sa * 11 - ca * 6);
        ctx.closePath();
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.fillStyle = '#c95cff';
        ctx.fill();
      } else {
        const pr = this.wpPulse / 1.6;
        ctx.beginPath();
        ctx.arc(px, py, 7 + pr * 12, 0, TAU);
        ctx.globalAlpha = 0.7 * (1 - pr);
        ctx.strokeStyle = '#c95cff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      pin(ctx, px, py, '#c95cff', 7);
    }
    // player arrow
    arrow(ctx, ox, oy, 0, 9, '#ffffff');
    // soft edges + frame
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.vignette, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.restore();
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 2;
    ctx.stroke(this.border);
    ctx.restore();
    const ms = performance.now() - t0;
    this.stats.frames++;
    this.stats.ms += ms;
    if (ms > this.stats.max) this.stats.max = ms;
  }
}

function clampToRect(x, y, left, top, right, bottom, out) {
  const sx = x < 0 ? left / -x : right / Math.max(x, 1e-6);
  const sy = y < 0 ? top / -y : bottom / Math.max(y, 1e-6);
  const s = Math.min(1, sx, sy);
  out[0] = x * s; out[1] = y * s;
  return out;
}

export function arrow(ctx, x, y, angle, size, color) {
  const c = Math.cos(angle) * size, s = Math.sin(angle) * size;
  // tip (0,-1.25), right (0.95,1.05), notch (0,0.5), left (-0.95,1.05) — rotated by angle
  ctx.beginPath();
  ctx.moveTo(x + 1.25 * s, y - 1.25 * c);
  ctx.lineTo(x + 0.95 * c - 1.05 * s, y + 0.95 * s + 1.05 * c);
  ctx.lineTo(x - 0.5 * s, y + 0.5 * c);
  ctx.lineTo(x - 0.95 * c - 1.05 * s, y - 0.95 * s + 1.05 * c);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth = 2.2;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fill();
}

export function pin(ctx, x, y, color, r = 7) {
  ctx.beginPath();
  ctx.arc(x, y, r + 2, 0, TAU);
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.36, 0, TAU);
  ctx.fillStyle = '#fff';
  ctx.fill();
}
