import { REGIONS, DESTINATIONS } from '../../world/regions.js';
import { blip, esc } from '../Hud.js';
import { mapSourceLink, MAP_SOURCE } from '../icons.js';
import { Tab } from './Tab.js';
import { GP } from '../../core/input.js';

const MAP_MPP = 4;

// MAP: pan/zoom, region/district/landmark labels, waypoint + GPS route, double-click teleport, fast travel list.
export class MapTab extends Tab {
  constructor(menu) {
    super(menu, 'map');
    this.icon = 'map';
    const world = this.game.worldData;
    this.world = world;
    this.mapImage = menu.mapImage;
    this.x0 = world.bounds[0];
    this.z0 = world.bounds[1];
    this.view = { cx: -1500, cz: 0, mpp: 14 };
    this.hover = null;
    this.kbMode = false;
    this._last = '';
    // waypoint actions sit at the top of the side panel (not over the map): the map's own controls (POI filter
    // top-left, zoom right, scale bottom-right, phone bottom sheet) keep the whole map area on any screen size
    this.el.innerHTML = `
      <div class="mapwrap" data-nav data-key="map"><canvas id="bigmap"></canvas><div class="cross"></div></div>
      <div id="map-info"><div class="t">—</div><div class="s"></div></div>
      <div class="mattr"></div>
      <div id="map-side"><div id="map-actions"></div><div class="mside"></div></div>`;
    this.wrap = this.el.querySelector('.mapwrap');
    this.canvas = this.el.querySelector('#bigmap');
    this.ctx = this.canvas.getContext('2d');
    this.info = this.el.querySelector('#map-info');
    this.bindMap();
    this.el.querySelector('#map-actions').addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'clear') this.ui.setWaypoint(null);
      if (a === 'tp') this.teleportWaypoint();
    });
    this.el.querySelector('#map-side').addEventListener('click', (e) => {
      const d = e.target.closest('.dest');
      if (d) this.goDest(DESTINATIONS[+d.dataset.i]);
    });
  }

  build() {
    const tp = this.can('teleport');
    this.el.querySelector('#map-actions').innerHTML = `
      <button class="mbtn" data-nav data-act="clear" tabindex="-1">${esc(this.t('map.clear'))}</button>
      ${tp ? `<button class="mbtn primary" data-nav data-act="tp" tabindex="-1">${esc(this.t('map.teleport'))}</button>` : ''}`;
    this.el.querySelector('.mattr').innerHTML = esc(this.t('credits.data', { source: '\u0000' })).replace('\u0000', mapSourceLink(MAP_SOURCE.host));
    const sub = (a) => (a === 'National Park' ? this.t('area.nationalPark') : a);
    this.el.querySelector('#map-side .mside').innerHTML = `
      <h3>${esc(this.t(tp ? 'map.fastTravel' : 'map.destinations'))}</h3>
      <div id="dests">${DESTINATIONS.map((d, i) => `<div class="dest" data-nav data-i="${i}"><span>${esc(d.name)}</span><small>${esc(sub(d.area))}</small></div>`).join('')}</div>
      <div class="legend">
        <div><span class="dot" style="background:#fff"></span>${esc(this.t('map.legend.you'))}</div>
        <div><span class="dot" style="background:#c95cff"></span>${esc(this.t('map.legend.route'))}</div>
        <div><span class="dot" style="background:#f5c84c"></span>${esc(this.t('map.legend.landmarks'))}</div>
        <div class="mhelp">${this.t(tp ? 'map.help' : 'map.helpOnline')}</div>
      </div>`;
    this._last = '';
  }

  // vector full map from the cartography module (workstream H) replaces the canvas when available
  mountCartography() {
    const carto = this.game.cartography;
    if (this.full || !carto?.createFullMap) return;
    try {
      this.full = carto.createFullMap(this.wrap, {
        onTeleport: this.can('teleport') ? (x, z, name) => this.ui.teleport(x, z, name) : null,
        onWaypoint: (w) => this.ui.setWaypoint(w),
        canTeleport: this.can('teleport'),
      });
      this.canvas.style.display = 'none';
      this.info.style.display = 'none';
      this.el.classList.add('carto'); // the full map shows its own attribution (bottom right): no second credit line
    } catch (e) {
      console.error('[ui] cartography full map failed, using the built-in map', e);
      this.full = null;
    }
  }

  show() {
    this.mountCartography();
    const p = this.game.player.focus;
    if (this.full) { this.full.show?.({ x: p.x, z: p.z }); return; }
    this.view.cx = p.x;
    this.view.cz = p.z;
    this.view.mpp = 6;
    this.kbMode = false;
    requestAnimationFrame(() => this.resize());
    this.resize();
  }

  hide() { this.full?.hide?.(); }

  // first show it on the map (card with waypoint / teleport); a second press on the same row acts right away
  goDest(d) {
    if (this.full?.focusPlace && this._destShown !== d) { this._destShown = d; this.full.focusPlace(d.x, d.z, d.name); return; }
    this._destShown = null;
    if (this.can('teleport')) this.ui.teleport(d.x, d.z, d.name);
    else { this.ui.setWaypoint({ x: d.x, z: d.z }); this.full?.show?.({ x: d.x, z: d.z }); }
  }

  defaultFocus() { return this.wrap; }

  hints() {
    const h = [[['Arrows'], 'menu.hint.pan'], [['+', '−'], 'menu.hint.zoom'], ['Enter', 'menu.hint.waypoint']];
    if (this.can('teleport')) h.push(['Space', 'menu.hint.teleport']);
    h.push(['Tab', 'menu.hint.list']);
    return h;
  }

  hint(label) {
    if (label === 'menu.hint.teleport') this.teleportWaypoint();
    if (label === 'menu.hint.list') this.toggleList();
  }

  resize() {
    this._last = '';
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = Math.max(1, r.width * dpr);
    this.canvas.height = Math.max(1, r.height * dpr);
    this.dpr = dpr;
    this.cw = r.width;
    this.ch = r.height;
  }

  toWorld(sx, sy) { return { x: this.view.cx + (sx - this.cw / 2) * this.view.mpp, z: this.view.cz + (sy - this.ch / 2) * this.view.mpp }; }
  toScreen(x, z) { return [(x - this.view.cx) / this.view.mpp + this.cw / 2, (z - this.view.cz) / this.view.mpp + this.ch / 2]; }

  // mouse + touch: drag to pan, pinch / wheel to zoom, tap = waypoint, double tap = teleport (singleplayer)
  bindMap() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    const pts = new Map();
    let drag = null, moved = false, pinch = null, lastTap = 0;
    const local = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    c.addEventListener('pointerdown', (e) => {
      try { c.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) { drag = { x: e.clientX, y: e.clientY, cx: this.view.cx, cz: this.view.cz }; moved = false; c.classList.add('drag'); }
      else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), mpp: this.view.mpp };
        drag = null;
        moved = true;
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.menu.open || this.menu.tab !== this) return;
      if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const r = c.getBoundingClientRect();
        const target = Math.min(40, Math.max(0.8, pinch.mpp * pinch.d / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y))));
        this.zoomAt(target / this.view.mpp, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      } else if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
        if (moved) { this.view.cx = drag.cx - dx * this.view.mpp; this.view.cz = drag.cz - dy * this.view.mpp; }
      }
      if (e.pointerType === 'mouse') { this.kbMode = false; const [x, y] = local(e); this.hover = this.toWorld(x, y); }
    });
    const end = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (!pts.size) { drag = null; c.classList.remove('drag'); }
    };
    c.addEventListener('pointerup', (e) => {
      const tap = !!drag && !moved && pts.size === 1;
      end(e);
      if (!tap) return;
      const [x, y] = local(e);
      const w = this.toWorld(x, y);
      this.hover = w;
      const now = performance.now();
      if (now - lastTap < 330 && this.can('teleport')) { lastTap = 0; this.ui.teleport(w.x, w.z); return; }
      lastTap = now;
      this.ui.setWaypoint(w);
    });
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = local(e);
      this.zoomAt(e.deltaY > 0 ? 1.18 : 0.85, x, y);
    }, { passive: false });
    window.addEventListener('resize', () => { if (this.menu.open) this.resize(); });
  }

  zoomAt(f, sx = this.cw / 2, sy = this.ch / 2) {
    const before = this.toWorld(sx, sy);
    this.view.mpp = Math.min(40, Math.max(0.8, this.view.mpp * f));
    const after = this.toWorld(sx, sy);
    this.view.cx += before.x - after.x;
    this.view.cz += before.z - after.z;
  }

  preview(d) {
    if (this.full) { this.full.show?.({ x: d.x, z: d.z }); return; }
    this.view.cx = d.x; this.view.cz = d.z; this.view.mpp = Math.min(this.view.mpp, 6);
  }

  // keyboard / gamepad focus previews a destination; mouse hover must not move the map (only a click does)
  onFocus(el, { mouse = false } = {}) {
    if (el.classList.contains('dest') && !mouse) this.preview(DESTINATIONS[+el.dataset.i]);
    this.wrap.classList.toggle('kb', el === this.wrap && this.kbMode);
  }

  teleportWaypoint() {
    if (!this.can('teleport')) return;
    const w = this.game.player.waypoint;
    if (w) this.ui.teleport(w.x, w.z);
    else this.ui.feed({ title: this.t('feed.gps'), text: this.t('notify.noWaypoint'), icon: 'pin', color: '#c95cff' });
  }

  toggleList() {
    if (this.menu.focus === this.wrap) this.menu.setFocus(this.el.querySelector('.dest'));
    else this.menu.setFocus(this.wrap);
  }

  // Esc / B closes an open place card before closing the menu
  back() { return !!this.full?.back?.(); }

  // map focused: arrows pan instead of moving focus
  nav(dir, focus) { return focus === this.wrap; }

  activate(el) {
    if (el !== this.wrap || this.full) return false;
    this.ui.setWaypoint({ x: this.view.cx, z: this.view.cz });
    return true;
  }

  key(inp, dt) {
    if (inp.pressed('Tab') || inp.gpPressedBtn(GP.RS)) this.toggleList();
    if (inp.pressed('Delete') || inp.gpPressedBtn(GP.X)) this.ui.setWaypoint(null);
    if (inp.pressed('Space') || inp.gpPressedBtn(GP.Y)) { this.teleportWaypoint(); return; }
    if (this.menu.focus !== this.wrap || this.full) return;
    let px = 0, py = 0;
    if (inp.held('ArrowLeft') || inp.held('KeyA') || inp.gpHeld(GP.LEFT)) px -= 1;
    if (inp.held('ArrowRight') || inp.held('KeyD') || inp.gpHeld(GP.RIGHT)) px += 1;
    if (inp.held('ArrowUp') || inp.held('KeyW') || inp.gpHeld(GP.UP)) py -= 1;
    if (inp.held('ArrowDown') || inp.held('KeyS') || inp.gpHeld(GP.DOWN)) py += 1;
    px += inp.axis(0, 0.18);
    py += inp.axis(1, 0.18);
    if (px || py) {
      const sp = 520 * dt * this.view.mpp;
      this.view.cx += px * sp;
      this.view.cz += py * sp;
      this.setKb();
    }
    let z = 0;
    if (inp.held('Equal') || inp.held('NumpadAdd') || inp.held('PageUp')) z -= 1;
    if (inp.held('Minus') || inp.held('NumpadSubtract') || inp.held('PageDown')) z += 1;
    z += inp.gpValue(GP.LT) - inp.gpValue(GP.RT);
    if (Math.abs(z) > 0.05) { this.zoomAt(Math.exp(z * dt * 2.2)); this.setKb(); }
  }

  setKb() {
    this.kbMode = true;
    this.hover = { x: this.view.cx, z: this.view.cz };
    this.wrap.classList.add('kb');
  }

  update(dt) {
    if (this.full) { this.full.update?.(dt, this.game.input); return; }
    this.draw();
  }

  draw() {
    const ctx = this.ctx, W = this.cw, H = this.ch;
    if (!W) { this.resize(); return; }
    const g = this.game, pl = g.player;
    const route = pl.route;
    const wp = pl.waypoint;
    const key = `${this.view.cx.toFixed(1)}|${this.view.cz.toFixed(1)}|${this.view.mpp.toFixed(3)}|${W}|${H}|${wp?.x}|${route?.length}|${pl.focus.x.toFixed(0)}|${pl.focus.z.toFixed(0)}|${this.hover?.x?.toFixed(0)}|${this.hover?.z?.toFixed(0)}|${this.i18n.lang}`;
    if (key === this._last) return;
    this._last = key;
    const font = this.i18n.font('ui');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#243548';
    ctx.fillRect(0, 0, W, H);
    const k = MAP_MPP / this.view.mpp;
    const [ox, oy] = this.toScreen(this.x0, this.z0);
    ctx.imageSmoothingEnabled = this.view.mpp > MAP_MPP * 0.75;
    ctx.drawImage(this.mapImage, ox, oy, this.mapImage.width * k, this.mapImage.height * k);
    if (route && route.length >= 4) {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const path = () => { ctx.beginPath(); for (let i = 0; i < route.length; i += 2) { const [x, y] = this.toScreen(route[i], route[i + 1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); } };
      path(); ctx.strokeStyle = 'rgba(30,0,50,0.85)'; ctx.lineWidth = 7; ctx.stroke();
      path(); ctx.strokeStyle = '#c95cff'; ctx.lineWidth = 4; ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const big = Math.max(13, Math.min(30, 260 / this.view.mpp));
    for (const r of REGIONS) {
      const [x, y] = this.toScreen(r.x, r.z);
      if (x < -200 || x > W + 200 || y < -50 || y > H + 50) continue;
      label(ctx, r.name.toUpperCase(), x, y, `${big}px "Russo One", ${font}`, r.water ? '#bfe6ff' : '#fff');
    }
    if (this.view.mpp < 7) {
      ctx.globalAlpha = Math.min(1, (7 - this.view.mpp) / 2);
      for (const d of this.world.districts) {
        if (d.type !== 'd' || d.n < 6) continue;
        const [x, y] = this.toScreen(d.x, d.z);
        if (x < -100 || x > W + 100 || y < -30 || y > H + 30) continue;
        label(ctx, d.name.toUpperCase(), x, y, `500 13px ${font}`, '#f1f1f1');
      }
      ctx.globalAlpha = 1;
    }
    if (this.view.mpp < 3.5) {
      for (const lm of this.world.landmarks) {
        const [x, y] = this.toScreen(lm.x, lm.z);
        if (x < 0 || x > W || y < 0 || y > H) continue;
        ctx.save(); ctx.translate(x, y); blip(ctx, '#f5c84c', 5); ctx.restore();
        label(ctx, lm.name, x, y - 15, `500 12px ${font}`, '#ffe9a8');
      }
    }
    for (const b of this.ui.hud.playerBlips || []) {
      const [x, y] = this.toScreen(b.x, b.z);
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      ctx.save(); ctx.translate(x, y); blip(ctx, b.color || '#ffd23f', 6); ctx.restore();
      if (b.label) label(ctx, b.label, x, y - 16, `500 12px ${font}`, '#fff');
    }
    if (wp) {
      const [x, y] = this.toScreen(wp.x, wp.z);
      ctx.save(); ctx.translate(x, y); blip(ctx, '#c95cff', 9); ctx.restore();
    }
    const [px, py] = this.toScreen(pl.focus.x, pl.focus.z);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(pl.heading);
    ctx.beginPath();
    ctx.moveTo(0, -12); ctx.lineTo(9, 10); ctx.lineTo(0, 5); ctx.lineTo(-9, 10); ctx.closePath();
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2.5; ctx.stroke(); ctx.fill();
    ctx.restore();
    // scale bar (bottom, away from the side panel)
    const meters = niceStep(this.view.mpp * 120);
    const len = meters / this.view.mpp;
    const rtl = this.i18n.dir === 'rtl';
    const bx = rtl ? 24 : W - 40 - len;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(bx - 10, H - 44, len + 20, 30);
    ctx.fillStyle = '#fff';
    ctx.fillRect(bx, H - 24, len, 3);
    ctx.font = `500 12px ${font}`;
    ctx.fillText(meters >= 1000 ? this.t('map.km', { n: meters / 1000 }) : this.t('map.m', { n: meters }), bx + len / 2, H - 34);
    const h = this.hover;
    if (h) {
      const a = this.ui.hud.areaAt(h.x, h.z);
      this.info.querySelector('.t').textContent = a.name;
      this.info.querySelector('.s').textContent = `${this.ui.hud.subLabel(a.sub)} · ${Math.round(h.x)}, ${Math.round(-h.z)}`;
    }
  }
}

function label(ctx, text, x, y, font, color) {
  ctx.font = font;
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function niceStep(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
