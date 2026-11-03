// Full-screen (pause menu) map: vector tiles + animated label layer, inertial pan, zoom around the cursor,
// pinch, keyboard / gamepad, POI layer with category filters and clustering, hover cards, waypoint / teleport.
import { drawTiles } from './tiles.js';
import { LabelLayer } from './Labels.js';
import { PALETTES } from './style.js';
import { CATEGORY_IDS, FLAG, iconSvg } from './poi.js';
import { arrow } from './Radar.js';
import { PlayerOverlay } from './Players.js';
import { strokeRoute, ROUTE_STYLE } from './route.js';
import { areaSubLabel } from '../world/regions.js';

const TILE_OPTS = { prefetchUp: true, prefetchDown: false };

const MIN_MPP = 0.28, MAX_MPP = 30;
const ATTR_URL = 'https://map.stateofleonida.net/';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const GP = { A: 0, B: 1, X: 2, Y: 3, LT: 6, RT: 7 };

let cssDone = false;
function injectCss() {
  if (cssDone || typeof document === 'undefined') return;
  cssDone = true;
  const st = document.createElement('style');
  st.id = 'ldm-css';
  st.textContent = `
.ldm-root { position: absolute; inset: 0; overflow: hidden; background: #14273f; font-family: Oswald, 'Arial Narrow', sans-serif; color: #fff;
  --ldm-panel: rgba(12, 14, 20, 0.78); --ldm-line: rgba(255, 255, 255, 0.12); --ldm-accent: var(--pink, #ff3fa4); user-select: none; touch-action: none; }
.ldm-root canvas.ldm-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: grab; }
.ldm-root.drag canvas.ldm-canvas { cursor: grabbing; }
.ldm-root.hot canvas.ldm-canvas { cursor: pointer; }
.ldm-glass { background: var(--ldm-panel); backdrop-filter: blur(10px) saturate(1.2); -webkit-backdrop-filter: blur(10px) saturate(1.2);
  border: 1px solid var(--ldm-line); border-radius: 12px; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35); }
.ldm-btn { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 8px; cursor: pointer;
  font: 500 14px/1 Oswald, 'Arial Narrow', sans-serif; letter-spacing: 0.6px; color: #fff; }
.ldm-btn.ldm-glass { background: var(--ldm-panel); border: 1px solid var(--ldm-line); border-radius: 12px; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(10px) saturate(1.2); -webkit-backdrop-filter: blur(10px) saturate(1.2); }
.ldm-zoom { position: absolute; inset-inline-end: 14px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; overflow: hidden; }
.ldm-zoom .ldm-btn { width: 40px; height: 40px; font-size: 22px; font-weight: 400; }
.ldm-zoom .ldm-btn + .ldm-btn { border-top: 1px solid var(--ldm-line); }
.ldm-zoom .ldm-btn:hover, .ldm-cats .ldm-cat:hover { background: rgba(255, 255, 255, 0.1); }
.ldm-poibtn:hover { background: rgba(34, 38, 48, 0.86); }
.ldm-zoom svg { width: 18px; height: 18px; }
.ldm-poibtn { position: absolute; inset-inline-start: 14px; top: 14px; height: 38px; padding: 0 14px; font-size: 14px; }
.ldm-poibtn .sw { width: 30px; height: 17px; border-radius: 9px; background: rgba(255, 255, 255, 0.22); position: relative; transition: background .2s; flex: none; }
.ldm-poibtn .sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: #fff; transition: transform .2s; }
.ldm-poibtn.on .sw { background: var(--ldm-accent); }
.ldm-poibtn.on .sw::after { transform: translateX(13px); }
.ldm-poibtn .chev { opacity: .7; font-size: 11px; transition: transform .2s; }
.ldm-root.cats-open .ldm-poibtn .chev { transform: rotate(180deg); }
.ldm-cats { position: absolute; inset-inline-start: 14px; top: 58px; width: 250px; padding: 8px; opacity: 0; transform: translateY(-6px); pointer-events: none;
  transition: opacity .18s, transform .18s; max-height: calc(100% - 140px); overflow-y: auto; }
.ldm-root.cats-open .ldm-cats { opacity: 1; transform: none; pointer-events: auto; }
.ldm-cats .ldm-cat { display: flex; width: 100%; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; font-size: 14px; font-weight: 400; justify-content: flex-start; }
.ldm-cats .ldm-cat svg { flex: none; transition: opacity .15s, filter .15s; }
.ldm-cats .ldm-cat .n { margin-inline-start: auto; opacity: .55; font-size: 12px; font-variant-numeric: tabular-nums; }
.ldm-cats .ldm-cat .ck { width: 16px; height: 16px; border-radius: 4px; border: 1.5px solid rgba(255,255,255,.5); flex: none; display: grid; place-items: center; font-size: 11px; }
.ldm-cats .ldm-cat.on .ck { background: var(--ldm-accent); border-color: var(--ldm-accent); }
.ldm-cats .ldm-cat:not(.on) svg { opacity: .35; filter: grayscale(1); }
.ldm-cats .row { display: flex; gap: 6px; padding: 2px 4px 8px; border-bottom: 1px solid var(--ldm-line); margin-bottom: 6px; }
.ldm-cats .row .ldm-btn { padding: 6px 10px; border-radius: 7px; background: rgba(255,255,255,.08); font-size: 12px; }
.ldm-bottom { position: absolute; inset-inline-end: 14px; bottom: 12px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; pointer-events: none; }
.ldm-scale { padding: 5px 10px 6px; font-size: 12px; text-align: center; }
.ldm-scale i { display: block; height: 4px; margin-top: 4px; border: 2px solid #fff; border-top: 0; transition: width .15s; }
.ldm-attr { pointer-events: auto; font-size: 11px; padding: 3px 8px; border-radius: 6px; background: rgba(0, 0, 0, 0.55); color: rgba(255,255,255,.75); letter-spacing: .3px; }
.ldm-attr a { color: #fff; text-decoration: underline; text-underline-offset: 2px; }
.ldm-info { position: absolute; inset-inline-start: 14px; bottom: 30px; padding: 8px 12px; min-width: 200px; pointer-events: none; opacity: 0; transition: opacity .2s; }
.ldm-info.on { opacity: 1; }
.ldm-info b { display: block; font-family: 'Russo One', Oswald, sans-serif; font-weight: 400; font-size: 17px; letter-spacing: .5px; }
.ldm-info small { opacity: .7; font-size: 12px; letter-spacing: .5px; }
.ldm-card { position: absolute; left: 0; top: 0; width: 290px; padding: 12px 14px 10px; opacity: 0; pointer-events: none; transition: opacity .14s; will-change: transform; }
.ldm-card.show { opacity: 1; }
.ldm-card.sel { pointer-events: auto; }
.ldm-card .hd { display: flex; gap: 10px; align-items: flex-start; }
.ldm-card .hd svg { flex: none; margin-top: 2px; }
.ldm-card .hd b { display: block; font-size: 17px; font-weight: 500; line-height: 1.2; letter-spacing: .3px; }
.ldm-card .hd small { display: block; font-size: 12px; opacity: .72; margin-top: 2px; letter-spacing: .4px; }
.ldm-card .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.ldm-card .chips span { font-size: 11px; padding: 2px 7px; border-radius: 9px; background: rgba(255,255,255,.12); letter-spacing: .4px; }
.ldm-card .real { margin-top: 8px; font-size: 12.5px; line-height: 1.35; opacity: .9; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }
.ldm-card .real i { display: block; font-style: normal; font-size: 10.5px; letter-spacing: 1px; text-transform: uppercase; opacity: .6; font-family: Oswald, sans-serif; margin-bottom: 1px; }
.ldm-card .acts { display: flex; gap: 8px; margin-top: 10px; }
.ldm-card .acts .ldm-btn { flex: 1; height: 32px; border-radius: 8px; background: rgba(255,255,255,.12); font-size: 13px; }
.ldm-card .acts .ldm-btn.primary { background: var(--ldm-accent); color: #fff; }
.ldm-card .acts .ldm-btn:hover { filter: brightness(1.15); }
.ldm-card .src { margin-top: 8px; font-size: 10.5px; opacity: .55; }
.ldm-card .ldm-x { position: absolute; top: 6px; right: 6px; width: 28px; height: 28px; border-radius: 8px; border: 0; background: transparent; color: inherit; font-size: 20px; line-height: 1; opacity: .6; cursor: pointer; }
.ldm-card .ldm-x:hover { opacity: 1; background: rgba(255,255,255,.12); }
.ldm-card.sel .hd { padding-right: 22px; }
.ldm-card .src a { color: inherit; }
.ldm-card .src a.irl { padding: 0 5px; border-radius: 6px; background: rgba(255,255,255,.16); text-decoration: none; font-weight: 500; letter-spacing: .5px; }
.ldm-cross { position: absolute; left: 50%; top: 50%; width: 34px; height: 34px; transform: translate(-50%, -50%); pointer-events: none; opacity: 0; transition: opacity .2s;
  background: linear-gradient(#fff, #fff) center/2px 100% no-repeat, linear-gradient(#fff, #fff) center/100% 2px no-repeat; filter: drop-shadow(0 0 2px #000); }
.ldm-root.kb .ldm-cross { opacity: .9; }
/* small screens (phones, small windows): tighter chrome; portrait phones get the card as a bottom sheet */
@media (max-width: 760px), (max-height: 520px) {
  .ldm-poibtn { inset-inline-start: 10px; top: 10px; height: 34px; padding: 0 11px; font-size: 13px; }
  .ldm-cats { inset-inline-start: 10px; top: 50px; width: min(250px, calc(100% - 20px)); max-height: calc(100% - 100px); }
  .ldm-zoom { inset-inline-end: 10px; }
  .ldm-zoom .ldm-btn { width: 36px; height: 36px; font-size: 20px; }
  .ldm-bottom { inset-inline-end: 10px; bottom: 8px; gap: 4px; }
  .ldm-scale { padding: 3px 8px 4px; font-size: 11px; }
  .ldm-attr { font-size: 10px; padding: 2px 6px; }
  .ldm-info { inset-inline-start: 10px; bottom: 8px; min-width: 0; max-width: 46%; padding: 6px 10px; }
  .ldm-info b { font-size: 14px; }
  .ldm-info small { font-size: 11px; }
  .ldm-card { width: min(290px, calc(100% - 16px)); padding: 10px 12px 9px; }
}
.ldm-root.compact .ldm-card { left: 8px; right: 8px; top: auto; bottom: 8px; width: auto; transform: none !important; }
.ldm-root.compact.card .ldm-info, .ldm-root.compact.card .ldm-bottom { opacity: 0; }
.ldm-root.compact .ldm-cross { width: 28px; height: 28px; }
`;
  document.head.appendChild(st);
}

const ICON_PLUS = '<svg viewBox="0 0 24 24"><path d="M11 5h2v14h-2zM5 11h14v2H5z" fill="currentColor"/></svg>';
const ICON_MINUS = '<svg viewBox="0 0 24 24"><path d="M5 11h14v2H5z" fill="currentColor"/></svg>';
const ICON_LOCATE = '<svg viewBox="0 0 24 24"><path d="M12 2l7 18-7-4-7 4z" fill="currentColor"/></svg>';

export class FullMap {
  constructor(carto, container, opts = {}) {
    injectCss();
    this.carto = carto;
    this.game = carto.game;
    this.t = carto.t;
    // keyActions: which keys/buttons this map handles itself. The pause menu (MapTab) already handles
    // Space/Y (teleport) and Delete/X (clear), so by default only Enter/A (waypoint at the crosshair) is on.
    const ka = opts.keyActions === true ? { waypoint: true, teleport: true, clear: true }
      : { waypoint: true, teleport: false, clear: false, ...(opts.keyActions || {}) };
    this.opts = { info: true, ...opts, keyActions: ka };
    this.canTeleport = opts.canTeleport ?? !!opts.onTeleport;
    this.pool = carto.pool;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.view = { cx: 0, cz: 0, mpp: 4, rot: 0, ox: 0, oy: 0, w: 0, h: 0, dpr: this.dpr };
    this.target = null; // { mpp, ax, az, sx, sy } zoom animation around an anchor
    this.vel = { x: 0, z: 0 };
    this.visible = false;
    this.dirty = true;
    this.kb = false;
    this.hover = null;
    this.selected = null;
    this.pointers = new Map();
    this.samples = [];
    this.labels = new LabelLayer(carto.map, carto.regions, { dpr: this.dpr });
    this.players = new PlayerOverlay(arrow);
    const ps = carto.poiSettings();
    this.labels.setPoi(ps.on, ps.cats);
    this.stats = { frames: 0, ms: 0, max: 0, labelMs: 0 };

    const root = (this.root = document.createElement('div'));
    root.className = 'ldm-root';
    root.innerHTML = `
      <canvas class="ldm-canvas"></canvas>
      <div class="ldm-cross"></div>
      <button class="ldm-btn ldm-glass ldm-poibtn" data-act="poi"><span class="sw"></span><span class="lbl"></span><span class="chev">▼</span></button>
      <div class="ldm-glass ldm-cats"></div>
      <div class="ldm-glass ldm-zoom">
        <button class="ldm-btn" data-act="in">${ICON_PLUS}</button>
        <button class="ldm-btn" data-act="out">${ICON_MINUS}</button>
        <button class="ldm-btn" data-act="locate">${ICON_LOCATE}</button>
      </div>
      <div class="ldm-glass ldm-info"><b></b><small></small></div>
      <div class="ldm-bottom">
        <div class="ldm-glass ldm-scale"><span></span><i></i></div>
        <div class="ldm-attr"></div>
      </div>
      <div class="ldm-glass ldm-card"></div>`;
    container.appendChild(root);
    const q = (s) => root.querySelector(s);
    this.el = {
      canvas: q('.ldm-canvas'), poiBtn: q('.ldm-poibtn'), cats: q('.ldm-cats'), zoom: q('.ldm-zoom'), info: q('.ldm-info'),
      infoT: q('.ldm-info b'), infoS: q('.ldm-info small'), scale: q('.ldm-scale span'), scaleBar: q('.ldm-scale i'),
      attr: q('.ldm-attr'), card: q('.ldm-card'),
    };
    if (!this.opts.info) this.el.info.style.display = 'none';
    this.ctx = this.el.canvas.getContext('2d');
    this.renderTexts();
    this.bind();
    this.ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.resize()) : null;
    this.ro?.observe(root);
  }

  // ---- texts / DOM ---------------------------------------------------------------------------------------------
  renderTexts() {
    const t = this.t;
    this.el.attr.innerHTML = `${esc(t('data'))}: <a href="${ATTR_URL}" target="_blank" rel="noopener noreferrer">map.stateofleonida.net</a>`;
    this.el.poiBtn.querySelector('.lbl').textContent = t('poi');
    const z = this.el.zoom.querySelectorAll('button');
    z[0].title = t('zoomIn'); z[1].title = t('zoomOut'); z[2].title = t('locate');
    this.renderCats();
    this.lastScale = null;
    if (this.selected || this.hover) this.showCard(this.selected || this.hover, !!this.selected);
  }

  renderCats() {
    const t = this.t, L = this.labels;
    const counts = {};
    for (const p of L.pois) counts[p.cat] = (counts[p.cat] || 0) + 1;
    this.el.poiBtn.classList.toggle('on', L.poiOn);
    const html = `<div class="row"><button class="ldm-btn" data-cats="all">${esc(t('all'))}</button><button class="ldm-btn" data-cats="none">${esc(t('none'))}</button></div>`
      + `<button class="ldm-btn ldm-cat ${this.carto.playersOn() ? 'on' : ''}" data-act="players" aria-pressed="${this.carto.playersOn()}"><span class="ck">${this.carto.playersOn() ? '✓' : ''}</span><span style="color:#4fd1ff">➤</span><span>${esc(t('players'))}</span><span class="n" data-player-count>${this.carto.players.length}</span></button>`
      + CATEGORY_IDS.filter((id) => counts[id]).map((id) => `<button class="ldm-btn ldm-cat ${L.cats.has(id) ? 'on' : ''}" data-cat="${id}">`
        + `<span class="ck">${L.cats.has(id) ? '✓' : ''}</span>${iconSvg(id, 18)}<span>${esc(t(`cat.${id}`))}</span><span class="n">${counts[id]}</span></button>`).join('');
    // show() calls this on every open: re-parse the ~6 KB panel only when it changed (2-7 ms otherwise)
    if (html !== this._catsHtml) { this._catsHtml = html; this.el.cats.innerHTML = html; }
  }

  applyPoi(on, cats) {
    this.labels.setPoi(on, cats);
    this.carto.savePoiSettings(on, [...this.labels.cats]);
    this.renderCats();
    this.dirty = true;
  }

  bind() {
    const root = this.root, cv = this.el.canvas;
    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act) this.emitClick();
      if (act === 'in') this.zoomBy(0.5);
      else if (act === 'out') this.zoomBy(2);
      else if (act === 'locate') this.flyTo(this.player(), Math.min(this.view.mpp, 2.5));
      else if (act === 'players') this.carto.savePlayers(!this.carto.playersOn());
      else if (act === 'poi') {
        if (e.target.closest('.sw') || !this.labels.poiOn) this.applyPoi(!this.labels.poiOn);
        root.classList.toggle('cats-open', this.labels.poiOn && !e.target.closest('.sw') ? !root.classList.contains('cats-open') : false);
      }
      const cat = e.target.closest('[data-cat]')?.dataset.cat;
      if (cat) {
        const cats = new Set(this.labels.cats);
        if (cats.has(cat)) cats.delete(cat); else cats.add(cat);
        this.applyPoi(true, [...cats]);
        this.emitClick();
      }
      const all = e.target.closest('[data-cats]')?.dataset.cats;
      if (all) { this.carto.savePlayers(all === 'all'); this.applyPoi(true, all === 'all' ? CATEGORY_IDS : []); this.emitClick(); }
    });
    // canvas gestures
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture?.(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY, x0: e.offsetX, y0: e.offsetY });
      this.vel.x = this.vel.z = 0;
      this.target = null;
      this.moved = false;
      this.samples.length = 0;
      this.pinch = null;
      if (this.pointers.size === 2) this.startPinch();
      root.classList.remove('cats-open');
      this.setKb(false);
    });
    cv.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) { this.hoverAt(e.offsetX, e.offsetY); return; }
      const dx = e.offsetX - p.x, dy = e.offsetY - p.y;
      p.x = e.offsetX; p.y = e.offsetY;
      if (this.pointers.size >= 2) { this.updatePinch(); return; }
      if (Math.abs(p.x - p.x0) + Math.abs(p.y - p.y0) > (e.pointerType === 'touch' ? 10 : 5)) { this.moved = true; root.classList.add('drag'); }
      if (!this.moved) return;
      this.view.cx -= dx * this.view.mpp;
      this.view.cz -= dy * this.view.mpp;
      this.clampView();
      this.dirty = true;
      const t = performance.now();
      this.samples.push({ t, x: this.view.cx, z: this.view.cz });
      while (this.samples.length && t - this.samples[0].t > 100) this.samples.shift();
      this.hideCard(false);
    });
    const up = (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      this.pointers.delete(e.pointerId);
      root.classList.remove('drag');
      if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; this.moved = true; return; }
      if (this.moved) {
        const s = this.samples;
        if (s.length >= 2) {
          const a = s[0], b = s[s.length - 1];
          const dt = Math.max(16, b.t - a.t) / 1000;
          this.vel.x = (b.x - a.x) / dt; this.vel.z = (b.z - a.z) / dt;
          if (performance.now() - b.t > 60) this.vel.x = this.vel.z = 0;
        }
        return;
      }
      if (e.type !== 'pointerup') return;
      if (e.pointerType === 'touch') {
        const now = performance.now(), last = this.lastTap;
        this.lastTap = { t: now, x: e.offsetX, y: e.offsetY };
        if (last && now - last.t < 300 && Math.hypot(last.x - e.offsetX, last.y - e.offsetY) < 30) {
          this.lastTap = null;
          this.zoomBy(0.5, e.offsetX, e.offsetY);
          return;
        }
      }
      this.click(e.offsetX, e.offsetY);
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { if (!this.pointers.size) this.setHover(null); if (!this.kb) this.el.info.classList.remove('on'); });
    cv.addEventListener('dblclick', (e) => {
      if (!this.canTeleport || !this.opts.onTeleport) { this.zoomBy(0.5, e.offsetX, e.offsetY); return; }
      const w = this.toWorld(e.offsetX, e.offsetY);
      this.teleportTo(w.x, w.z);
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const f = Math.exp(clamp(d, -300, 300) * (e.ctrlKey ? 0.01 : 0.0022));
      this.zoomBy(f, e.offsetX, e.offsetY, true);
      this.setKb(false);
    }, { passive: false });
    this.el.card.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      this.emitClick();
      const sel = this.selected;
      if (act === 'close') this.hideCard(true);
      else if (act === 'wp' && sel) {
        if (this.waypointNear(sel.x, sel.z)) { this.opts.onClear ? this.opts.onClear() : this.opts.onWaypoint?.(null); this.dirty = true; }
        else this.waypointAt(sel.x, sel.z, sel.name);
        this.hideCard(true);
      } else if (act === 'tp' && sel) this.teleportTo(sel.x, sel.z, sel.name);
    });
  }

  emitClick() { this.game?.events?.emit?.('ui:click', {}); }

  startPinch() {
    const [a, b] = [...this.pointers.values()];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mpp: this.view.mpp, anchor: this.toWorld(mx, my) };
  }

  updatePinch() {
    if (!this.pinch) this.startPinch();
    const [a, b] = [...this.pointers.values()];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const v = this.view;
    v.mpp = clamp(this.pinch.mpp * this.pinch.d / d, MIN_MPP, MAX_MPP);
    v.cx = this.pinch.anchor.x - (mx - v.w / 2) * v.mpp;
    v.cz = this.pinch.anchor.z - (my - v.h / 2) * v.mpp;
    this.clampView();
    this.dirty = true;
  }

  // ---- coordinates -------------------------------------------------------------------------------------------
  toWorld(sx, sy) { const v = this.view; return { x: v.cx + (sx - v.w / 2) * v.mpp, z: v.cz + (sy - v.h / 2) * v.mpp }; }
  toScreen(x, z) { const v = this.view; return [(x - v.cx) / v.mpp + v.w / 2, (z - v.cz) / v.mpp + v.h / 2]; }
  center() { return { x: this.view.cx, z: this.view.cz }; }

  player() {
    const p = this.game?.player;
    const f = p?.focus || this.carto.lab?.player;
    return f ? { x: f.x, z: f.z } : { x: this.view.cx, z: this.view.cz };
  }

  clampView() {
    const b = this.carto.bounds, v = this.view;
    v.cx = clamp(v.cx, b[0], b[2]);
    v.cz = clamp(v.cz, b[1], b[3]);
  }

  zoomBy(f, sx = this.view.w / 2, sy = this.view.h / 2, smooth = true) {
    const base = this.target ? this.target.mpp : this.view.mpp;
    const mpp = clamp(base * f, MIN_MPP, MAX_MPP);
    const a = this.toWorld(sx, sy);
    this.target = { mpp, ax: a.x, az: a.z, sx, sy };
    if (!smooth) this.stepZoom(1);
    this.dirty = true;
  }

  flyTo(p, mpp = this.view.mpp) {
    this.fly = { x0: this.view.cx, z0: this.view.cz, m0: this.view.mpp, x1: p.x, z1: p.z, m1: clamp(mpp, MIN_MPP, MAX_MPP), t: 0 };
    this.target = null;
    this.vel.x = this.vel.z = 0;
  }

  stepZoom(k) {
    const T = this.target, v = this.view;
    if (!T) return;
    const lm = Math.log(v.mpp) + (Math.log(T.mpp) - Math.log(v.mpp)) * k;
    v.mpp = Math.exp(lm);
    if (Math.abs(Math.log(T.mpp / v.mpp)) < 0.002) { v.mpp = T.mpp; this.target = null; }
    v.cx = T.ax - (T.sx - v.w / 2) * v.mpp;
    v.cz = T.az - (T.sy - v.h / 2) * v.mpp;
    this.clampView();
    this.dirty = true;
  }

  // ---- actions -------------------------------------------------------------------------------------------------
  click(sx, sy) {
    const group = this.carto.playersOn() && this.players.hit(sx, sy);
    if (group) {
      const span = Math.max(group.x1 - group.x0, group.z1 - group.z0, 20);
      this.flyTo({ x: (group.x0 + group.x1) / 2, z: (group.z0 + group.z1) / 2 }, Math.min(this.view.mpp / 2.5, span * 1.6 / Math.min(this.view.w, this.view.h)));
      this.emitClick();
      return;
    }
    const hit = this.labels.hit(sx, sy);
    if (hit?.kind === 'cluster') {
      const g = hit.cluster;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const p of g.members) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
      const span = Math.max(x1 - x0, z1 - z0, 60);
      this.flyTo({ x: (x0 + x1) / 2, z: (z0 + z1) / 2 }, Math.min(this.view.mpp / 2.5, span / Math.min(this.view.w, this.view.h) * 1.6));
      this.emitClick();
      return;
    }
    if (hit?.kind === 'poi') {
      const p = hit.poi;
      this.selected = this.poiInfo(p, hit.id);
      this.labels.selectedId = hit.id;
      this.dirty = true;
      this.showCard(this.selected, true);
      this.emitClick();
      return;
    }
    if (this.selected) { this.hideCard(true); this.dirty = true; return; }
    const wp = this.game?.player?.waypoint || this.carto.lab?.waypoint;
    if (wp) {
      const [wx, wy] = this.toScreen(wp.x, wp.z);
      if (Math.hypot(wx - sx, wy - sy) < 14) { this.opts.onClear ? this.opts.onClear() : this.opts.onWaypoint?.(null); this.hideCard(true); this.dirty = true; return; }
    }
    const w = this.toWorld(sx, sy);
    this.selected = this.placeInfo(w.x, w.z);
    this.labels.selectedId = null;
    this.waypointAt(w.x, w.z);
    this.showCard(this.selected, true);
  }

  /** Side-list destination: glide there and open its card (waypoint / teleport buttons); nothing is set yet. */
  focusPlace(x, z, name) {
    if (!this.visible) this.show({ x, z });
    this.flyTo({ x, z }, Math.min(this.view.mpp, 4));
    const info = this.placeInfo(x, z);
    if (name) info.place = { ...info.place, name };
    this.selected = info;
    this.labels.selectedId = null;
    this.showCard(info, true);
    this.dirty = true;
  }

  waypointNear(x, z) {
    const wp = this.game?.player?.waypoint || this.carto.lab?.waypoint;
    return !!wp && Math.hypot(wp.x - x, wp.z - z) < 1;
  }

  /** Esc / B: close an open card first (MapTab.back). → true when something was closed. */
  back() {
    if (!this.selected && !this.cardInfo) return false;
    this.hideCard(true);
    this.dirty = true;
    return true;
  }

  waypointAt(x, z, name) {
    this.opts.onWaypoint?.({ x, z, name });
    this.dirty = true;
  }

  teleportTo(x, z, name) {
    if (!this.canTeleport || !this.opts.onTeleport) return;
    this.emitClick();
    this.opts.onTeleport(x, z, name || undefined);
    this.hideCard(true);
  }

  // ---- hover / card ------------------------------------------------------------------------------------------
  hoverAt(sx, sy) {
    this.mouse = { x: sx, y: sy };
    const hit = this.labels.hit(sx, sy);
    this.setHover(hit);
    if (this.opts.info) this.updateInfo(this.toWorld(sx, sy));
  }

  setHover(hit) {
    const id = hit?.id || null;
    this.root.classList.toggle('hot', !!hit);
    if (id === this.labels.hoverId) return;
    this.labels.hoverId = id;
    this.dirty = true;
    if (this.selected) return;
    if (hit?.kind === 'poi') this.showCard(this.poiInfo(hit.poi, id), false);
    else if (hit?.kind === 'cluster') this.showCard({ cluster: hit.cluster, x: hit.cluster.x, z: hit.cluster.z, id }, false);
    else this.hideCard(false);
  }

  poiInfo(p, id) {
    return { id, poi: p, x: p.x, z: p.z, name: p.name && !p.generic ? p.name : p.name || '', cat: p.cat };
  }

  placeInfo(x, z) {
    const a = this.carto.areaAt(x, z);
    return { id: null, x, z, place: a };
  }

  showCard(info, selected) {
    const t = this.t, el = this.el.card;
    let html = '';
    if (info.poi) {
      const p = info.poi;
      const where = [p.street, p.district, p.area].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
      const chips = [];
      if (p.flags & FLAG.landmark && p.cat !== 'landmark') chips.push(t('cat.landmark'));
      if (p.flags & FLAG.enterable) chips.push(t('enterable'));
      if (p.flags & FLAG.safehouse) chips.push(t('safehouse'));
      if (p.flags & FLAG.demolished) chips.push(t('demolished'));
      if (p.flags & FLAG.closed) chips.push(t('closed'));
      if (p.flags & FLAG.unconfirmed) chips.push(t('unconfirmed'));
      html = `<div class="hd">${iconSvg(p.cat, 26)}<div><b>${esc(p.name || t('unnamed'))}</b><small>${esc(t(`cat.${p.cat}`))}${where ? ' · ' + esc(where) : ''}</small></div></div>`
        + (chips.length ? `<div class="chips">${chips.map((c) => `<span>${esc(c)}</span>`).join('')}</div>` : '')
        + (p.real ? `<div class="real"><i>${esc(t('inspired'))}</i>${esc(p.real)}</div>` : '');
    } else if (info.cluster) {
      const g = info.cluster;
      html = `<div class="hd">${iconSvg(g.cat, 26)}<div><b>${esc(t('places', { n: g.n, count: g.n }))}</b><small>${esc(t('zoomCluster'))}</small></div></div>`;
    } else if (info.place) {
      const a = info.place;
      html = `<div class="hd">${iconSvg('other', 26).replace(/#8f969e/, '#c95cff')}<div><b>${esc(a.name)}</b><small>${esc(areaSubLabel(a.sub, this.game?.i18n))} · ${Math.round(info.x)}, ${Math.round(-info.z)}</small></div></div>`;
    }
    if (selected) {
      const has = this.waypointNear(info.x, info.z);
      html = `<button class="ldm-x" data-act="close" aria-label="${esc(t('close'))}">×</button>` + html;
      html += `<div class="acts"><button class="ldm-btn${this.canTeleport || has ? '' : ' primary'}" data-act="wp">${esc(t(has ? 'clearWaypoint' : 'setWaypoint'))}</button>`
        + (this.canTeleport && this.opts.onTeleport ? `<button class="ldm-btn primary" data-act="tp">${esc(t('teleport'))}</button>` : '') + '</div>';
    }
    if (info.poi) {
      // deep link to the exact marker on the fan map (+ its real-world prototype view when it has one)
      const p = info.poi;
      const url = /^L\d+$/.test(p.id) ? `${ATTR_URL}?marker=${encodeURIComponent(p.id)}` : ATTR_URL;
      const irl = url !== ATTR_URL && (p.flags & FLAG.irl || p.real)
        ? ` · <a class="irl" href="${url}&irl" target="_blank" rel="noopener noreferrer" title="${esc(t('irlTitle'))}">${esc(t('irl'))}</a>` : '';
      html += `<div class="src">${esc(t('data'))}: <a href="${url}" target="_blank" rel="noopener noreferrer" title="${esc(t('openMarker'))}">map.stateofleonida.net</a>${irl}</div>`;
    }
    el.innerHTML = html;
    el.classList.add('show');
    el.classList.toggle('sel', !!selected);
    this.root.classList.add('card');
    this.cardInfo = info;
    this._cardW = el.offsetWidth || 290; this._cardH = el.offsetHeight || 120; // one layout read per card change
    this._cardKey = null;
    this.placeCard();
  }

  placeCard() {
    const info = this.cardInfo;
    if (!info) return;
    const el = this.el.card;
    if (this.compact) return; // bottom sheet (CSS)
    const [x, y] = this.toScreen(info.x, info.z);
    const w = this._cardW || 290, h = this._cardH || 120;
    let px = x + 18, py = y - h / 2;
    if (px + w > this.view.w - 64) px = x - 18 - w;
    py = clamp(py, 60, this.view.h - h - 60);
    px = clamp(px, 8, this.view.w - w - 8);
    const key = `${px | 0},${py | 0}`;
    if (key !== this._cardKey) { this._cardKey = key; el.style.transform = `translate3d(${px | 0}px, ${py | 0}px, 0)`; }
  }

  hideCard(clearSelection) {
    if (clearSelection) { this.selected = null; this.labels.selectedId = null; }
    if (this.selected && !clearSelection) return;
    this.cardInfo = null;
    this.el.card.classList.remove('show', 'sel');
    this.root.classList.remove('card');
  }

  updateInfo(w) {
    const a = this.carto.areaAt(w.x, w.z);
    const key = a.name + '|' + Math.round(w.x / 10) + '|' + Math.round(w.z / 10);
    if (key === this._infoKey) return;
    this._infoKey = key;
    this.el.info.classList.add('on');
    this.el.infoT.textContent = a.name;
    this.el.infoS.textContent = `${areaSubLabel(a.sub, this.game?.i18n)} · ${Math.round(w.x)}, ${Math.round(-w.z)}`;
  }

  setKb(on) {
    if (this.kb === on) return;
    this.kb = on;
    this.root.classList.toggle('kb', on);
    if (on) { this.setHover(null); this.hideCard(true); }
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------
  resize() {
    const r = this.root.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    // DPR-aware but capped: the canvas (and every cached tile) costs w*h*dpr² pixels per frame / of memory
    const lowEnd = !!this.game?.mobile?.device?.lowEnd;
    const budget = lowEnd ? 2.4e6 : 4.6e6;
    let dpr = Math.min(window.devicePixelRatio || 1, lowEnd ? 1.5 : 2);
    if (w * h * dpr * dpr > budget) dpr = Math.max(1, Math.sqrt(budget / (w * h)));
    dpr = Math.round(dpr * 4) / 4;
    this.root.classList.toggle('compact', w < 560);
    this.compact = w < 560;
    if (w === this.view.w && h === this.view.h && dpr === this.dpr) return;
    this.dpr = dpr;
    this.view.w = w; this.view.h = h; this.view.dpr = dpr;
    this.el.canvas.width = Math.round(w * dpr);
    this.el.canvas.height = Math.round(h * dpr);
    this.pool.setDpr('map', dpr);
    this.labels.setDpr(dpr);
    this.dirty = true;
  }

  show(at) {
    if (this.visible && at) {
      // already open (e.g. previewing a destination from the side list): glide there
      this.flyTo(at, Math.min(this.view.mpp, 4));
      this.dirty = true;
      return;
    }
    this.visible = true;
    this.root.style.display = '';
    this.resize();
    const p = at || this.player();
    this.view.cx = p.x; this.view.cz = p.z;
    this.view.mpp = 2.2 * 1.8;
    this.clampView();
    this.flyTo(p, 2.2);
    this.hideCard(true);
    this.labels.setPoi(...Object.values(this.carto.poiSettings()));
    this.renderCats();
    this.dirty = true;
    this.lastFrame = performance.now();
  }

  hide() {
    this.visible = false;
    this.root.style.display = 'none';
    this.root.classList.remove('cats-open');
    this.hideCard(true);
    this.pointers.clear();
    this.pool.shrink('map', 12);
  }

  // input: InputManager-like ({ held, pressed, axis, gpValue, gpHeld, gpPressedBtn }) — optional
  update(dt, input) {
    if (!this.visible) return;
    const t0 = performance.now();
    dt = Math.min(dt || 0.016, 0.1);
    if (!this.view.w) this.resize();
    const v = this.view;
    // keyboard / gamepad
    if (input) this.handleInput(dt, input);
    // fly animation
    if (this.fly) {
      const F = this.fly;
      F.t = Math.min(1, F.t + dt / 0.65);
      const e = F.t < 0.5 ? 4 * F.t * F.t * F.t : 1 - Math.pow(-2 * F.t + 2, 3) / 2;
      v.cx = F.x0 + (F.x1 - F.x0) * e;
      v.cz = F.z0 + (F.z1 - F.z0) * e;
      v.mpp = Math.exp(Math.log(F.m0) + (Math.log(F.m1) - Math.log(F.m0)) * e);
      if (F.t >= 1) this.fly = null;
      this.dirty = true;
    }
    // zoom animation (exponential approach in log space)
    if (this.target) this.stepZoom(1 - Math.exp(-dt * 14));
    // inertia
    if (!this.pointers.size && (this.vel.x || this.vel.z)) {
      v.cx += this.vel.x * dt; v.cz += this.vel.z * dt;
      const f = Math.exp(-dt * 4.5);
      this.vel.x *= f; this.vel.z *= f;
      if (Math.hypot(this.vel.x, this.vel.z) < v.mpp * 6) this.vel.x = this.vel.z = 0;
      this.clampView();
      this.dirty = true;
    }
    // player / route / players changes
    const pl = this.player();
    const wp = this.game?.player?.waypoint || this.carto.lab?.waypoint;
    const route = this.game?.player?.route || this.carto.lab?.route;
    const S = this._sig || (this._sig = new Float64Array(6));
    const s0 = pl.x | 0, s1 = pl.z | 0, s2 = wp ? wp.x | 0 : 1e9, s3 = wp ? wp.z | 0 : 1e9, s4 = route?.length || 0, s5 = this.carto.playersVersion;
    if (S[0] !== s0 || S[1] !== s1 || S[2] !== s2 || S[3] !== s3 || S[4] !== s4 || S[5] !== s5) {
      S[0] = s0; S[1] = s1; S[2] = s2; S[3] = s3; S[4] = s4; S[5] = s5;
      this.dirty = true;
    }
    this.time = (this.time || 0) + dt;
    if (route && route.length >= 4) this.dirty = true; // animated route flow
    if (this.pool.wants.size || this.pool.inflight.size) this.dirty = true; // tiles still arriving
    if (this._playerCount !== this.carto.players.length) {
      this._playerCount = this.carto.players.length;
      const count = this.el.cats.querySelector('[data-player-count]');
      if (count) count.textContent = String(this._playerCount);
    }
    const tl = performance.now();
    if (this.labels.update(v, dt, this.dirty)) this.dirty = true;
    this.stats.labelMs = performance.now() - tl;
    if (this.tileArrived) { this.tileArrived = false; this.dirty = true; }
    if (this.dirty) {
      this.dirty = false;
      this.draw(pl, wp, route);
      if (this.cardInfo) this.placeCard();
      this.updateScale();
      if (this.kb && this.opts.info) this.updateInfo(this.center());
    }
    const ms = performance.now() - t0;
    this.stats.frames++;
    this.stats.ms += ms;
    this.stats.max = Math.max(this.stats.max * 0.995, ms);
  }

  handleInput(dt, inp) {
    let px = 0, py = 0;
    if (inp.held?.('ArrowLeft') || inp.held?.('KeyA') || inp.gpHeld?.(14)) px -= 1;
    if (inp.held?.('ArrowRight') || inp.held?.('KeyD') || inp.gpHeld?.(15)) px += 1;
    if (inp.held?.('ArrowUp') || inp.held?.('KeyW') || inp.gpHeld?.(12)) py -= 1;
    if (inp.held?.('ArrowDown') || inp.held?.('KeyS') || inp.gpHeld?.(13)) py += 1;
    px += inp.axis?.(0, 0.18) || 0;
    py += inp.axis?.(1, 0.18) || 0;
    if (px || py) {
      const sp = 620 * dt * this.view.mpp;
      this.view.cx += px * sp; this.view.cz += py * sp;
      this.clampView();
      this.fly = null;
      this.dirty = true;
      this.setKb(true);
    }
    let z = 0;
    if (inp.held?.('Equal') || inp.held?.('NumpadAdd') || inp.held?.('PageUp')) z -= 1;
    if (inp.held?.('Minus') || inp.held?.('NumpadSubtract') || inp.held?.('PageDown')) z += 1;
    z += (inp.gpValue?.(GP.LT) || 0) - (inp.gpValue?.(GP.RT) || 0);
    z -= inp.axis?.(3, 0.25) || 0;
    if (Math.abs(z) > 0.05) {
      const v = this.view;
      v.mpp = clamp(v.mpp * Math.exp(z * dt * 2.4), MIN_MPP, MAX_MPP);
      this.target = null;
      this.dirty = true;
      this.setKb(true);
    }
    const ka = this.opts.keyActions;
    if (ka.waypoint && (inp.pressed?.('Enter') || inp.pressed?.('NumpadEnter') || inp.gpPressedBtn?.(GP.A))) {
      const c = this.center();
      this.waypointAt(c.x, c.z);
      this.setKb(true);
    }
    if (ka.teleport && (inp.pressed?.('Space') || inp.gpPressedBtn?.(GP.Y))) {
      const wp = this.game?.player?.waypoint || this.carto.lab?.waypoint;
      const c = wp || this.center();
      this.teleportTo(c.x, c.z);
    }
    if (ka.clear && (inp.pressed?.('Delete') || inp.gpPressedBtn?.(GP.X))) { this.opts.onClear ? this.opts.onClear() : this.opts.onWaypoint?.(null); this.dirty = true; }
  }

  updateScale() {
    const mpp = this.view.mpp;
    const meters = niceStep(mpp * 110);
    const len = Math.round(meters / mpp);
    const key = `${meters}|${len}`;
    if (key === this.lastScale) return;
    this.lastScale = key;
    this.el.scale.textContent = meters >= 1000 ? this.t('km', { n: meters / 1000 }) : this.t('m', { n: meters });
    this.el.scaleBar.style.width = `${len}px`;
  }

  draw(pl, wp, route) {
    const ctx = this.ctx, v = this.view, dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = PALETTES.map.water;
    ctx.fillRect(0, 0, this.el.canvas.width, this.el.canvas.height);
    v.ox = v.w / 2; v.oy = v.h / 2; v.rot = 0; v.dpr = dpr;
    drawTiles(ctx, this.pool, 'map', v, TILE_OPTS);
    // GPS route, under the labels (world transform still active)
    if (route && route.length >= 4) strokeRoute(ctx, route, 0, (route.length >> 1) - 1, v.mpp, this.time, ROUTE_STYLE.map);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.labels.draw(ctx, v);
    // remote players
    if (this.carto.playersOn()) this.players.draw(ctx, this.carto.players, v);
    // waypoint
    if (wp) {
      const [x, y] = this.toScreen(wp.x, wp.z);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - 7, y - 13);
      ctx.arc(x, y - 17, 8.1, Math.PI * 0.83, Math.PI * 0.17);
      ctx.closePath();
      ctx.fillStyle = '#c95cff';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 2;
      ctx.stroke(); ctx.fill();
      ctx.beginPath(); ctx.arc(x, y - 17, 3.2, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    }
    // player
    const [px, py] = this.toScreen(pl.x, pl.z);
    const ph = this.game?.player?.heading ?? this.carto.lab?.heading ?? 0;
    ctx.beginPath();
    ctx.arc(px, py, 17, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.fill();
    arrow(ctx, px, py, ph, 10, '#ffffff');
  }

  destroy() {
    this.hide();
    this.ro?.disconnect();
    this.root.remove();
    this.carto.fullMaps.delete(this);
  }
}

function niceStep(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
