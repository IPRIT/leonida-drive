import { Tab } from './Tab.js';
import { esc } from '../Hud.js';
import { icon, CATEGORY_ICON } from '../icons.js';
import { CATEGORIES, buildModels, colorCss, colorNum, fold } from '../vehicles-data.js';
import { drawThumb } from '../thumbs.js';
import { GP } from '../../core/input.js';
import { VEHICLE_DESCRIPTIONS_AR } from '../../i18n/vehicle-descriptions-ar.js';

// Optional data from the vehicles workstream (A): VEHICLE_CATALOG enriches game.vehicles.catalog entries by id.
const OPTIONAL = import.meta.glob(['../../vehicle/catalog.js', '../../vehicle/catalog/index.js']);
const FAVS_KEY = 'leonida.favs';
const RECENT_KEY = 'leonida.recent';
const CARD_BATCH = 24; // cards per idle-time prebuild slice
const LIVE_DELAY = 0.3; // s of a stable selection before the live turntable starts (static preview until then)
const SWAP_DELAY = 0.14; // s: the turntable model swap waits for the selection to settle (arrow-key browsing)

const load = (k) => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

// VEHICLES control panel: categories (+ favourites, recent), search, cards with live previews, stats, paint,
// spawn & drive. Previews come from ui.thumbs (game.thumbnails service or the fallback renderer).
//
// Performance model: one card per catalog vehicle is built once (in idle time when possible) and kept; filters,
// search, economy and selection only patch classes / badges of existing cards. Thumbnails are drawn when a card
// comes near the viewport (IntersectionObserver gives the size, so no layout reads), off-screen cards skip
// rendering (content-visibility in styles.css). The live turntable starts once the selection is stable.
export class VehiclesTab extends Tab {
  constructor(menu) {
    super(menu, 'vehicles');
    this.icon = 'car';
    this.cat = 'all';
    this.query = '';
    this.sel = null;
    this.colors = {};
    this.favs = new Set(load(FAVS_KEY));
    this.recent = load(RECENT_KEY);
    this.big = [];
    this.turn = null;
    this.cards = new Map(); // id → card element
    this._cardsKey = null;
    this.thumbs = menu.ui.thumbs;
    this.thumbs?.onReady((id) => this.paint(id));
    this.own = 'all'; // economy filter: owned | all | affordable
    this._ecoHooked = null;
    this.loadOptional();
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('input', (e) => {
      if (e.target.matches('input[type=search]')) { this.query = e.target.value; this.renderGrid(); }
      if (e.target.matches('input[type=color]')) { this.colors[this.sel] = colorNum(e.target.value); this.renderPaint(); }
    });
    this.el.addEventListener('keydown', (e) => {
      if (!e.target.matches('input[type=search]')) return;
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        e.target.blur();
        const first = this.firstCard();
        if (first && e.key !== 'Escape') this.menu.setFocus(first);
      }
    });
  }

  async loadOptional() {
    for (const l of Object.values(OPTIONAL)) {
      try {
        const m = await l();
        if (Array.isArray(m.VEHICLE_CATALOG)) this.big = m.VEHICLE_CATALOG;
      } catch (e) { console.warn('[ui] optional vehicle module failed', e); }
    }
    this.dirty = true;
    if (this.menu.open && this.menu.tab === this) this.ensure();
  }

  models() {
    const list = this.game.vehicles?.catalog || [];
    const sig = `${list.length}|${list.map((e) => e.id).join(',').length}|${this.big.length}`;
    if (sig !== this._sig) { this._sig = sig; this._models = buildModels(list, this.big); this._byId = new Map(this._models.map((m) => [m.id, m])); }
    return this._models;
  }

  model(id) { this.models(); return this._byId.get(id); }

  // ---- economy (game.economy, docs/ECONOMY.md); without it every vehicle is free and spawnable ----
  get eco() {
    const e = this.game.economy || null;
    if (e && this._ecoHooked !== e) {
      this._ecoHooked = e;
      e.onChange?.(() => { if (this.menu.open && this.menu.tab === this) this.refreshEconomy(); });
    }
    return e;
  }
  owns(id) { const e = this.eco; return e ? !!e.owns?.(id) : true; }
  priceOf(m) { return this.eco?.price?.(m.id) ?? m.price ?? 0; }
  money() { return this.eco?.money ?? this.game.player?.money ?? 0; }
  isStarter(id) { const e = this.eco; return !!(e?.isStarter?.(id) ?? e?.starters?.has?.(id)); }
  sellPrice(m) { return this.eco?.sellPrice?.(m.id) ?? Math.round(this.priceOf(m) * 0.55); }

  // cards persist, so a refresh keeps the scroll position and only patches what changed
  refreshEconomy() {
    this.renderGrid();
    const fb = this.menu.focus;
    if (!fb || !this.el.contains(fb) || fb.classList.contains('hidden')) { const d = this.defaultFocus(); if (d) this.menu.setFocus(d, { scroll: false, silent: true }); }
  }

  count(c) {
    const models = this.models();
    if (c === 'all') return models.length;
    if (c === 'favs') return models.filter((m) => this.favs.has(m.id)).length;
    if (c === 'recent') return this.recent.filter((id) => this._byId.has(id)).length;
    return models.filter((m) => m.cat === c).length;
  }

  build() {
    this.buildShell();
    this.renderGrid();
  }

  // idle-time build (Menu.scheduleIdle): the shell, then the cards in small batches
  prebuild(dl) {
    if (this.dirty) { this.dirty = false; this.buildShell(); }
    this.syncCards(dl);
  }

  prebuildPending() { return this.dirty || (!!this.gridEl && this._cardsKey !== this.cardsKey()) || this._cardsDone === false; }

  buildShell() {
    const cats = ['all', 'favs', 'recent', ...CATEGORIES].filter((c) => c !== 'other' || this.count('other') > 0);
    const special = { all: ['veh.all', 'car'], favs: ['veh.favs', 'starFill'], recent: ['veh.recent', 'clock'] };
    this.disposeTurntable();
    this.el.innerHTML = `
      <div class="veh">
        <aside class="vcats">${cats.map((c) => {
          const n = this.count(c);
          const label = special[c] ? this.t(special[c][0]) : this.t(`cat.${c}`);
          const ic = special[c] ? special[c][1] : CATEGORY_ICON[c];
          return `<div class="vcat ${c === this.cat ? 'on' : ''} ${n || special[c] ? '' : 'empty'}" ${n || special[c] ? 'data-nav' : ''} data-cat="${c}">${icon(ic)}<span>${esc(label)}</span><small>${n}</small></div>`;
        }).join('')}</aside>
        <section class="vmain">
          <div class="vtop">
            <label class="vsearch" data-nav data-key="search">${icon('search')}<input type="search" tabindex="-1" spellcheck="false" placeholder="${esc(this.t('veh.search'))}" value="${esc(this.query)}"></label>
            ${this.eco ? `<div class="chips vown">${['owned', 'all', 'affordable'].map((f) => `<button class="chip ${f === this.own ? 'on' : ''}" data-nav data-act="own" data-v="${f}" tabindex="-1">${esc(this.t(`veh.filter.${f}`))}</button>`).join('')}</div>` : ''}
            <span class="vcount"></span>
          </div>
          ${this.game.online ? `<div class="vnote">${icon('clock')}<span>${esc(this.t('veh.onlineLimit'))}</span></div>` : ''}
          <div class="vgrid"><div class="vempty hidden"></div></div>
        </section>
        <aside class="vdetail"><div class="dthumb"><canvas class="tcv"></canvas><div class="ph"></div></div><div class="dinfo"></div></aside>
      </div>`;
    this._shellEco = !!this.eco;
    this.gridEl = this.el.querySelector('.vgrid');
    this.emptyEl = this.gridEl.firstElementChild;
    this.countEl = this.el.querySelector('.vcount');
    this.detailEl = this.el.querySelector('.vdetail');
    this.dthumb = this.el.querySelector('.dthumb');
    this.infoEl = this.el.querySelector('.dinfo');
    this.cards.clear();
    this._cardsKey = null;
    this._cardsDone = false;
    this._detailHtml = null;
    this._picked = null;
    this._previewId = null;
    this._sigGrid = null;
    this.observer?.disconnect();
    // previews by visibility: a card near the viewport requests + draws its thumbnail; the observer entry gives
    // its size, so drawing never forces a layout
    this.observer = 'IntersectionObserver' in window ? new IntersectionObserver((ents) => this.onVisible(ents), { root: this.gridEl, rootMargin: '200px 0px' }) : null;
  }

  // what the static part of the cards depends on (rebuild all cards when it changes)
  cardsKey() { return `${this._sig}|${this.i18n.lang}|${!!this.thumbs?.available()}|${!!this.eco}`; }

  // creates missing cards in catalog order; with an idle deadline only as many as fit. → true when complete
  syncCards(dl) {
    if (!this.gridEl) return false;
    const models = this.models();
    const key = this.cardsKey();
    if (key !== this._cardsKey) {
      for (const c of this.cards.values()) { this.observer?.unobserve(c); c.remove(); }
      this.cards.clear();
      this._cardsKey = key;
      this._cardsDone = false;
      this._sigGrid = null;
      this._lbl = { speed: esc(this.t('veh.stat.speed')), hand: esc(this.t('veh.stat.handling')), cur: `<span class="cur">${esc(this.t('veh.current'))}</span>`, lock: `<span class="lockov">${icon('lock')}<b>${esc(this.t('veh.locked'))}</b></span>`, favOn: esc(this.t('veh.favRemove')), favOff: esc(this.t('veh.favAdd')) };
    }
    if (this.cards.size >= models.length) { this._cardsDone = true; return true; }
    const thumbs = !!this.thumbs?.available();
    const eco = this.eco, cash = this.money(), cur = this.game.player?.controllable?.catalogId;
    let i = this.cards.size;
    while (i < models.length) {
      const end = Math.min(models.length, i + CARD_BATCH);
      let html = '';
      const states = [];
      for (let k = i; k < end; k++) { const s = this.cardState(models[k], eco, cash, cur); states.push(s); html += this.cardHTML(models[k], s, thumbs); }
      this.gridEl.insertAdjacentHTML('beforeend', html);
      let el = this.gridEl.lastElementChild;
      for (let k = end - 1; k >= i; k--, el = el.previousElementSibling) {
        el._m = models[k];
        el._s = states[k - i];
        el._thumb = el.firstElementChild;
        el._on = true;
        el._order = '';
        this.cards.set(models[k].id, el);
        this.observer?.observe(el);
      }
      i = end;
      if (dl && (dl.didTimeout || dl.timeRemaining() < 4)) break; // idle slice used up (or forced by timeout): one batch
    }
    this._cardsDone = this.cards.size >= models.length;
    return this._cardsDone;
  }

  // dynamic part of a card (economy, favourite, current vehicle)
  cardState(m, eco, cash, cur) {
    const locked = !!(eco && !this.owns(m.id) && this.priceOf(m) > cash);
    const tail = `${m.id === cur ? this._lbl.cur : ''}${eco ? this.badgeHTML(m, cash) : ''}`;
    return { prem: this.prem(m), locked, fav: this.favs.has(m.id), tail };
  }

  cardHTML(m, s, thumbs) {
    const L = this._lbl;
    return `<div class="vcard ${m.id === this.sel ? 'picked' : ''} ${s.prem ? 'prem' : ''} ${s.locked ? 'locked' : ''}" data-nav data-id="${esc(m.id)}">`
      + `<div class="thumb ${thumbs ? 'skel' : ''}" data-id="${esc(m.id)}" style="--c:${colorCss(this.colorOf(m))}"><canvas class="tcv"></canvas><div class="ph">${icon(CATEGORY_ICON[m.cat] || 'car')}</div>${s.locked ? L.lock : ''}</div>`
      + `<div class="vn">${esc(m.name)}</div>`
      + `<div class="vb">${esc([m.brand, this.t(`cat.${m.cat}`)].filter(Boolean).join(' · '))}</div>`
      + (m.stats.speed != null || m.stats.handling != null ? `<div class="mini">`
        + `<span title="${L.speed}">${icon('bolt')}<i><b style="transform:scaleX(${m.stats.speed ?? 0})"></b></i></span>`
        + `<span title="${L.hand}">${icon('auto')}<i><b style="transform:scaleX(${m.stats.handling ?? 0})"></b></i></span></div>` : '')
      + `<button class="fav ${s.fav ? 'on' : ''}" data-act="fav" tabindex="-1" title="${s.fav ? L.favOn : L.favOff}">${icon(s.fav ? 'starFill' : 'star')}</button>`
      + s.tail
      + '</div>';
  }

  // patches only the parts of a card whose state changed
  updateCard(card, s) {
    const o = card._s;
    if (o.prem !== s.prem) card.classList.toggle('prem', s.prem);
    if (o.locked !== s.locked) {
      card.classList.toggle('locked', s.locked);
      if (s.locked) card._thumb.insertAdjacentHTML('beforeend', this._lbl.lock);
      else card._thumb.querySelector('.lockov')?.remove();
    }
    if (o.fav !== s.fav) this.setFavBtn(card.querySelector('.fav'), s.fav);
    if (o.tail !== s.tail) {
      for (const x of card.querySelectorAll(':scope > .cur, :scope > .own, :scope > .price')) x.remove();
      if (s.tail) card.insertAdjacentHTML('beforeend', s.tail);
    }
    card._s = s;
  }

  setFavBtn(b, on) {
    if (!b) return;
    b.classList.toggle('on', on);
    b.title = this.t(on ? 'veh.favRemove' : 'veh.favAdd');
    b.innerHTML = icon(on ? 'starFill' : 'star');
  }

  filtered() {
    const q = fold(this.query.trim());
    const catText = (m) => fold(this.t(`cat.${m.cat}`));
    let list = this.models();
    if (this.cat === 'recent') list = this.recent.map((id) => this._byId.get(id)).filter(Boolean);
    const eco = this.eco, cash = this.money();
    return list.filter((m) => {
      if (eco && this.own === 'owned' && !this.owns(m.id)) return false;
      if (eco && this.own === 'affordable' && (this.owns(m.id) || this.priceOf(m) > cash)) return false;
      if (this.cat === 'favs' && !this.favs.has(m.id)) return false;
      if (CATEGORIES.includes(this.cat) && m.cat !== this.cat) return false;
      return !q || m.search.includes(q) || catText(m).includes(q);
    });
  }

  renderGrid() {
    if (!this.gridEl) return;
    this.syncCards();
    const list = this.filtered();
    const cur = this.game.player?.controllable?.catalogId;
    setTextOnce(this.countEl, this.t('veh.count', { count: list.length }));
    // dynamic state of every card (cheap string compares; the DOM is touched only where something changed)
    const eco = this.eco, cash = this.money();
    for (const card of this.cards.values()) {
      const s = this.cardState(card._m, eco, cash, cur);
      const o = card._s;
      if (o.prem !== s.prem || o.locked !== s.locked || o.fav !== s.fav || o.tail !== s.tail) this.updateCard(card, s);
    }
    // visibility (+ order for the "recent" list)
    const recent = this.cat === 'recent';
    const pos = new Map(list.map((m, i) => [m.id, i]));
    for (const [id, card] of this.cards) {
      const on = pos.has(id);
      if (card._on !== on) { card._on = on; card.classList.toggle('hidden', !on); }
      const ord = recent && on ? String(pos.get(id)) : '';
      if (card._order !== ord) { card._order = ord; card.style.order = ord; }
    }
    if (!list.length) {
      const key = this.query ? 'veh.none' : this.cat === 'favs' ? 'veh.noFavs' : this.cat === 'recent' ? 'veh.noRecent' : this.own === 'owned' && this.eco ? 'veh.noOwned' : 'veh.none';
      setTextOnce(this.emptyEl, this.t(key));
    }
    this.emptyEl.classList.toggle('hidden', list.length > 0);
    if (!this.observer) this.paintAll();
    if (!this.sel || !pos.has(this.sel)) this.sel = (list.find((m) => m.id === cur) || list[0])?.id ?? this.sel;
    this.renderDetail();
  }

  // ---- thumbnails ----
  onVisible(ents) {
    for (const e of ents) {
      const card = e.target;
      card._near = e.isIntersecting;
      if (!e.isIntersecting || card._painted) continue;
      const w = e.boundingClientRect.width;
      if (w > 0) { card._tw = w; card._th = w * 9 / 16; }
      if (!this.paintCard(card)) this.thumbs?.request(card._m.id, 1);
    }
  }

  // no IntersectionObserver: draw everything at once with one measured size
  paintAll() {
    const first = [...this.cards.values()].find((c) => c._on);
    const r = first?._thumb.getBoundingClientRect();
    for (const c of this.cards.values()) {
      if (c._painted) continue;
      if (r?.width) { c._tw = r.width; c._th = r.height; }
      if (!this.paintCard(c)) this.thumbs?.request(c._m.id, 0);
    }
  }

  paintCard(card) {
    const th = card._thumb;
    const src = this.thumbs?.get(card._m.id);
    if (!src || !drawThumb(th.firstElementChild, src, card._tw, card._th)) return false;
    th.classList.remove('skel');
    th.classList.add('ready');
    card._painted = true;
    this.observer?.unobserve(card);
    return true;
  }

  // draw an available preview into the detail element; returns true when painted. The element's size is measured
  // once per viewport size (a selection change must not force a layout mid-click)
  paintEl(el, id) {
    const src = this.thumbs?.get(id);
    if (!src) return false;
    const vw = window.innerWidth, vh = window.innerHeight;
    let s = this._dsize;
    if (!s || s.vw !== vw || s.vh !== vh || !s.w) { const r = el.getBoundingClientRect(); s = this._dsize = { vw, vh, w: r.width, h: r.height }; }
    if (!drawThumb(el.querySelector('canvas'), src, s.w, s.h)) return false;
    el.classList.remove('skel');
    el.classList.add('ready');
    return true;
  }

  paint(id) {
    if (!this.gridEl) return;
    if (id === '*') { this._cardsKey = null; if (this.menu.open && this.menu.tab === this) this.renderGrid(); return; }
    const card = this.cards.get(id);
    if (card && !card._painted && (card._near || !this.observer)) this.paintCard(card);
    if (id === this.sel && !this.dthumb.classList.contains('live')) this.paintEl(this.dthumb, id);
  }

  colorOf(m) { return this.colors[m.id] ?? m.palette[0]; }

  // military vehicles and anything from $1M up get the premium frame
  prem(m) { return m.cat === 'military' || (this.eco ? this.priceOf(m) : m.price || 0) >= 1e6; }

  badgeHTML(m, cash) {
    if (this.owns(m.id)) return `<span class="own ${this.isStarter(m.id) ? 'starter' : ''}">${esc(this.t(this.isStarter(m.id) ? 'veh.starter' : 'veh.owned'))}</span>`;
    const p = this.priceOf(m);
    return `<span class="price ${p > cash ? 'dear' : ''}">${esc(this.i18n.money(p))}</span>`;
  }

  // Detail preview: the cached static thumbnail at once, the live turntable (thumbnail service) once the selection
  // has been stable for a moment — keyboard browsing through cards never builds a 3D model per step.
  showPreview(m) {
    const el = this.dthumb;
    el.style.setProperty('--c', colorCss(this.colorOf(m)));
    if (this._previewId !== m.id) {
      this._previewId = m.id;
      el.querySelector('.ph').innerHTML = icon(CATEGORY_ICON[m.cat] || 'car');
      if (!el.classList.contains('live')) {
        el.classList.remove('ready');
        if (!this.paintEl(el, m.id)) {
          el.classList.toggle('skel', !!this.thumbs?.available());
          this.thumbs?.request(m.id, 1);
        }
      }
    }
    if (this.turn) { this.queueLive(m.id, SWAP_DELAY); return; }
    if (this.menu.open && this.menu.tab === this && this.thumbs?.svc?.createTurntable) this.queueLive(m.id, LIVE_DELAY);
  }

  queueLive(id, delay) {
    this._liveId = id;
    this._liveT = delay;
  }

  goLive(id) {
    if (!this.menu.open || this.menu.tab !== this || !this.dthumb) return;
    if (this.turn) { this.turn.setId?.(id); return; }
    const el = this.dthumb;
    if (el.offsetParent === null) return; // preview hidden by the layout (portrait phones): no 3D model to build
    this.turn = this.thumbs?.turntable(el, id) || null;
    if (!this.turn) return;
    // reveal the live canvas after its first frame (until then the static preview stays visible)
    this._liveWait = { canvas: [...el.children].find((c) => c.tagName === 'CANVAS' && !c.classList.contains('tcv')), t: 0 };
  }

  disposeTurntable() {
    this._liveId = null;
    this._liveWait = null;
    if (!this.turn) return;
    try { this.turn.dispose?.(); } catch (e) { console.warn('[ui] turntable dispose', e); }
    this.turn = null;
    if (this.dthumb) {
      this.dthumb.classList.remove('live');
      this._previewId = null; // the static preview is drawn again on the next show
    }
  }

  renderDetail() {
    const m = this.model(this.sel);
    const card = m ? this.cards.get(m.id) : null;
    if (this._picked !== card) {
      this._picked?.classList.remove('picked');
      card?.classList.add('picked');
      this._picked = card;
    }
    if (!m) { this.infoEl.innerHTML = ''; this._detailHtml = ''; return; }
    this.showPreview(m);
    const i = this.i18n;
    const imp = this.game.settings.units === 'mph';
    const fav = this.favs.has(m.id);
    const stat = (k, v, text) => `<div class="st"><span>${esc(this.t(`veh.stat.${k}`))}</span><div class="sb"><i style="transform:scaleX(${v ?? 0})"></i></div><b>${esc(text ?? '')}</b></div>`;
    const spd = m.topSpeedKmh ? this.t(imp ? 'unit.mph' : 'unit.kmh', { n: Math.round(m.topSpeedKmh * (imp ? 0.621371 : 1)) }) : '—';
    const meta = [];
    if (m.accel0100) meta.push(`${this.t(imp ? 'veh.zeroTo60' : 'veh.zeroTo100')}: ${this.t('veh.s', { n: m.accel0100 })}`);
    if (m.seats) meta.push(this.t('veh.seats', { count: m.seats }));
    if (m.price) meta.push(`${this.t('veh.price')}: ${i.money(m.price)}`);
    const desc = i.lang === 'ar' ? (VEHICLE_DESCRIPTIONS_AR[m.id] || '') : i.has(`vehdesc.${m.id}`) ? this.t(`vehdesc.${m.id}`) : m.desc;
    const html = `
      <div class="dname">${esc(m.name)}</div>
      <div class="dsub">${esc([m.brand, this.t(`cat.${m.cat}`)].filter(Boolean).join(' · '))}</div>
      ${desc ? `<div class="ddesc">${esc(desc)}</div>` : ''}
      <div class="dstats">
        ${stat('speed', m.stats.speed, spd)}
        ${stat('accel', m.stats.accel, m.accel0100 ? this.t('veh.s', { n: m.accel0100 }) : '')}
        ${stat('handling', m.stats.handling, '')}
        ${stat('weight', m.stats.weight, this.t('veh.kg', { n: Math.round(m.massKg) }))}
      </div>
      ${meta.length ? `<div class="dmeta">${meta.map(esc).join('<i>·</i>')}</div>` : ''}
      <h4>${esc(this.t('veh.paint'))}</h4>
      <div class="swatches"></div>
      <div class="dact">${this.actionsHTML(m, fav)}</div>`;
    // identical panel (re-show, filter change, unrelated economy tick): keep the DOM (and the focus inside it)
    if (html === this._detailHtml && this._detailFor === m.id) { this.renderPaint(); return; }
    const keep = this.menu.focus && this.infoEl.contains(this.menu.focus) ? this.focusKey(this.menu.focus) : null;
    this._detailHtml = html;
    this._detailFor = m.id;
    this._paintHtml = null;
    this.infoEl.innerHTML = html;
    this.renderPaint();
    if (keep && this.menu.tab === this) {
      const el = this.infoEl.querySelector(keep);
      if (el) { this.menu.focus = null; this.menu.setFocus(el, { scroll: false, silent: true }); }
    }
  }

  actionsHTML(m, fav) {
    const favBtn = `<button class="mbtn sq ${fav ? 'on' : ''}" data-nav data-act="favsel" tabindex="-1" title="${esc(this.t(fav ? 'veh.favRemove' : 'veh.favAdd'))}">${icon(fav ? 'starFill' : 'star')}</button>`;
    const spawn = `<button class="mbtn primary big" data-nav data-act="spawn" tabindex="-1">${icon(CATEGORY_ICON[m.cat] || 'car')}<span>${esc(this.t('veh.spawn'))}</span></button>`;
    if (!this.eco) return spawn + favBtn;
    const money = (n) => this.i18n.money(n);
    if (this.owns(m.id)) {
      const sell = this.isStarter(m.id)
        ? `<span class="dnote">${esc(this.t('veh.noStarterSale'))}</span>`
        : `<button class="mbtn sell" data-nav data-act="sell" tabindex="-1">${icon('money')}<span>${esc(this.t('veh.sell', { price: money(this.sellPrice(m)) }))}</span></button>`;
      return `${spawn}${favBtn}<div class="dact2">${sell}</div>`;
    }
    const price = this.priceOf(m), cash = this.money();
    if (price > cash) {
      const k = Math.max(0, Math.min(1, cash / price));
      return `<div class="vprog ${this.prem(m) ? 'prem' : ''}"><div class="sb"><i style="transform:scaleX(${k})"></i></div><span>${icon('lock')}${esc(this.t('veh.progress', { have: money(cash), price: money(price) }))}</span></div>`
        + `<button class="mbtn big buy disabled" data-act="nobuy" tabindex="-1">${icon('money')}<span>${esc(this.t('veh.needMore', { amount: money(price - cash) }))}</span></button>${favBtn}`;
    }
    return `<button class="mbtn big buy" data-nav data-act="buy" tabindex="-1">${icon('money')}<span>${esc(this.t('veh.buy', { price: money(price) }))}</span></button>${favBtn}`;
  }

  async buy(id) {
    const m = this.model(id), e = this.eco;
    if (!m || !e || this.owns(id) || this._busy) return;
    const price = this.priceOf(m);
    if (price > this.money()) return;
    const ok = await this.menu.confirm({ title: this.t('veh.buyTitle', { name: m.name }), text: this.t('veh.buyText', { price: this.i18n.money(price) }), ok: this.t('veh.buy', { price: this.i18n.money(price) }) });
    if (!ok) return;
    this._busy = true;
    let res;
    try { res = await e.buy(id); } catch (err) { res = { ok: false, reason: String(err?.message || err) }; }
    this._busy = false;
    if (!res?.ok) { this.menu.status({ icon: 'info', color: '#d83a35', text: `${this.t('notify.buyFailed')}${res?.reason ? ` (${res.reason})` : ''}` }); return; }
    this.game.events.emit('ui:purchase', { id, price });
    this.ui.hud.moneyPop(-price);
    this.renderGrid();
    this.stamp(this.t('veh.purchased'));
    const sp = this.infoEl.querySelector('[data-act="spawn"]');
    if (sp) this.menu.setFocus(sp, { silent: true });
    this.menu.status({ icon: 'star', color: 'var(--money)', text: this.t('notify.bought', { name: m.name }) });
  }

  async sell(id) {
    const m = this.model(id), e = this.eco;
    if (!m || !e?.sell || !this.owns(id) || this.isStarter(id) || this._busy) return;
    const gets = this.sellPrice(m);
    const ok = await this.menu.confirm({ title: this.t('veh.sellTitle', { name: m.name }), text: this.t('veh.sellText', { price: this.i18n.money(gets) }), ok: this.t('veh.sell', { price: this.i18n.money(gets) }) });
    if (!ok) return;
    this._busy = true;
    let res;
    try { res = await e.sell(id); } catch (err) { res = { ok: false, reason: String(err?.message || err) }; }
    this._busy = false;
    if (res && res.ok === false) { this.menu.status({ icon: 'info', color: '#d83a35', text: `${this.t('notify.buyFailed')}${res.reason ? ` (${res.reason})` : ''}` }); return; }
    this.ui.hud.moneyPop(gets);
    this.renderGrid();
    this.menu.status({ icon: 'money', color: 'var(--money)', text: this.t('notify.sold', { name: m.name, price: this.i18n.money(gets) }) });
  }

  // "PURCHASED" stamp over the preview
  stamp(text) {
    const el = document.createElement('div');
    el.className = 'stamp';
    el.textContent = text;
    this.dthumb.appendChild(el);
    this.dthumb.classList.add('bought');
    setTimeout(() => { el.remove(); this.dthumb?.classList.remove('bought'); }, 1900);
  }

  renderPaint() {
    const m = this.model(this.sel);
    const box = this.infoEl?.querySelector('.swatches');
    if (!m || !box) return;
    const cur = this.colorOf(m);
    const html = m.palette.map((c) => `<i data-nav data-act="color" data-color="${colorCss(c)}" class="${c === cur ? 'on' : ''}" style="background:${colorCss(c)}"></i>`).join('')
      + `<label class="custom ${m.palette.includes(cur) ? '' : 'on'}" data-nav data-key="custom" title="${esc(this.t('veh.custom'))}" style="--c:${colorCss(cur)}"><input type="color" tabindex="-1" value="${colorCss(cur)}">${icon('plus')}</label>`;
    this.dthumb?.style.setProperty('--c', colorCss(cur));
    this.cards.get(m.id)?._thumb.style.setProperty('--c', colorCss(cur));
    if (html === this._paintHtml && box.isConnected) return;
    const focusedColor = this.menu.focus && box.contains(this.menu.focus) ? this.menu.focus.dataset?.color : null;
    this._paintHtml = html;
    box.innerHTML = html;
    if (focusedColor) {
      const el = box.querySelector(`[data-color="${focusedColor}"]`);
      if (el) { this.menu.focus = null; this.menu.setFocus(el, { scroll: false, silent: true }); }
    }
  }

  onClick(e) {
    const catEl = e.target.closest('.vcat');
    if (catEl && catEl.hasAttribute('data-nav')) { this.setCat(catEl.dataset.cat); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    const card = e.target.closest('.vcard');
    if (act === 'fav' && card) { e.stopPropagation(); this.toggleFav(card.dataset.id); return; }
    if (act === 'favsel') { this.toggleFav(this.sel); return; }
    if (act === 'spawn') { this.spawn(this.sel); return; }
    if (act === 'buy') { this.buy(this.sel); return; }
    if (act === 'sell') { this.sell(this.sel); return; }
    if (act === 'own') { this.setOwn(e.target.closest('[data-v]').dataset.v); return; }
    if (act === 'color') { this.colors[this.sel] = colorNum(e.target.closest('[data-color]').dataset.color); this.renderPaint(); return; }
    // click/tap selects; a second click on the selected card (or a double click) buys or spawns it
    if (card) { if (card.dataset.id !== this.sel) this.select(card.dataset.id); else this.primary(card.dataset.id); }
  }

  setOwn(f) {
    if (f === this.own) return;
    this.own = f;
    this.el.querySelectorAll('.vown .chip').forEach((x) => x.classList.toggle('on', x.dataset.v === f));
    this.renderGrid();
    this.gridEl.scrollTop = 0;
  }

  setCat(c) {
    if (c === this.cat) return;
    this.cat = c;
    this.el.querySelectorAll('.vcat').forEach((x) => x.classList.toggle('on', x.dataset.cat === c));
    this.renderGrid();
    this.gridEl.scrollTop = 0;
  }

  toggleFav(id) {
    const m = this.model(id);
    if (!m) return;
    const on = !this.favs.has(id);
    if (on) this.favs.add(id); else this.favs.delete(id);
    save(FAVS_KEY, [...this.favs]);
    const n = this.el.querySelector('.vcat[data-cat="favs"] small');
    if (n) n.textContent = this.count('favs');
    const card = this.cards.get(id);
    if (card) { this.setFavBtn(card.querySelector('.fav'), on); card._s = { ...card._s, fav: on }; }
    if (id === this.sel) {
      const b = this.infoEl.querySelector('[data-act="favsel"]');
      if (b) { b.classList.toggle('on', on); b.innerHTML = icon(on ? 'starFill' : 'star'); }
      this._detailHtml = null; // the cached panel markup no longer matches
    }
    this.ui.feed({ kind: 'garage', icon: 'star', text: this.t(on ? 'notify.favAdded' : 'notify.favRemoved', { name: m.name }), seconds: 2.5 });
  }

  async spawn(id) {
    const m = this.model(id);
    if (!m || !this.can('vehicleSpawn')) return;
    const g = this.game;
    if (!this.owns(id)) {
      // not owned: point at the BUY button instead
      if (id !== this.sel) { this.sel = id; this.renderDetail(); }
      const b = this.infoEl.querySelector('[data-act="buy"]');
      if (b) this.menu.setFocus(b);
      this.menu.status({ icon: 'money', color: 'var(--orange)', text: this.t('veh.notOwned') });
      return;
    }
    // online: the server rate-limits spawning (optional hook from the multiplayer module)
    const gate = g.net?.canSpawnVehicle?.(id);
    if (gate && gate.ok === false) {
      this.menu.status({ icon: 'clock', color: 'var(--orange)', text: this.t('veh.wait', { s: Math.max(1, Math.ceil(gate.waitS || 1)) }) });
      return;
    }
    const color = this.colorOf(m);
    // online: the server approves the spawn (owned model, 8 s cooldown, alive); offline it resolves at once
    if (g.net?.requestVehicle) {
      if (this._spawning) return;
      this._spawning = true;
      let ok = false;
      try { ok = await g.net.requestVehicle(id, { color }); } catch { ok = false; } finally { this._spawning = false; }
      if (!ok) {
        const r = g.net.lastSpawnResult || {};
        const wait = Math.max(1, Math.ceil(r.waitS || g.net.canSpawnVehicle?.(id)?.waitS || 1));
        this.menu.status(r.code === 6 // SPAWN.NOT_OWNED
          ? { icon: 'money', color: 'var(--orange)', text: this.t('veh.notOwned') }
          : { icon: 'clock', color: 'var(--orange)', text: this.t('veh.wait', { s: wait }) });
        return;
      }
    }
    this.ui.close();
    try {
      if (g.spawnForPlayer) g.spawnForPlayer(id, { color });
      else { const v = g.vehicles.spawn(id, g.player.focus, 0, { color }); g.player.enter(v); }
    } catch (e) {
      console.error('[ui] spawn failed', e);
      return;
    }
    this.recent = [id, ...this.recent.filter((x) => x !== id)].slice(0, 12);
    save(RECENT_KEY, this.recent);
    this.ui.stats.bump('spawned');
    this.ui.feed({ kind: 'garage', icon: CATEGORY_ICON[m.cat] || 'car', text: this.t('notify.spawned', { name: m.name }) });
  }

  // Selection is sticky: it changes on click/tap, Enter/A or arrow/gamepad navigation — never on mouse hover.
  // The detail panel and BUY / SPAWN / SELL always act on this.sel.
  select(id) {
    if (!id || id === this.sel) return;
    this.sel = id;
    this.renderDetail();
    // likely the next spawn: its design is generated in idle time now, not in the spawn frame
    this.game.vehicles?.prewarmDesigns?.([id], true);
  }

  // main action for a vehicle: spawn when owned, otherwise ask to buy it
  primary(id) {
    const m = this.model(id);
    if (!m) return;
    if (id !== this.sel) { this.select(id); return; }
    if (this.owns(id)) { this.spawn(id); return; }
    const need = this.priceOf(m) - this.money();
    if (need > 0) { this.menu.status({ icon: 'money', color: 'var(--orange)', text: this.t('veh.needMore', { amount: this.i18n.money(need) }) }); return; }
    this.buy(id);
  }

  // keyboard/gamepad hooks
  onFocus(el, { mouse } = {}) {
    if (mouse) return; // hover is a highlight only
    if (el.classList.contains('vcard')) this.select(el.dataset.id);
    if (el.classList.contains('vcat')) this.setCat(el.dataset.cat);
  }

  activate(el) {
    if (el.classList.contains('vcard')) { this.primary(el.dataset.id); return true; }
    return false;
  }

  key(inp) {
    const f = this.menu.focus;
    if (inp.pressed('KeyF') || inp.gpPressedBtn(GP.Y)) {
      if (f?.classList.contains('vcard')) this.toggleFav(f.dataset.id);
      else if (this.sel) this.toggleFav(this.sel);
    }
    if (inp.pressed('Slash') || inp.gpPressedBtn(GP.X)) this.el.querySelector('input[type=search]')?.focus();
  }

  hints() { return [['Enter', 'menu.hint.spawn'], ['F', 'menu.hint.favourite'], [['Q', 'E'], 'menu.hint.tabs']]; }
  hint(label) { if (label === 'menu.hint.spawn') this.primary(this.sel); if (label === 'menu.hint.favourite' && this.sel) this.toggleFav(this.sel); }

  // first card in visual order (the "recent" list is ordered with CSS order)
  firstCard() {
    if (!this.gridEl) return null;
    if (this.cat !== 'recent') return this.gridEl.querySelector('.vcard:not(.hidden)');
    let best = null, bo = Infinity;
    for (const c of this.cards.values()) if (c._on && +c._order < bo) { bo = +c._order; best = c; }
    return best;
  }

  defaultFocus() {
    const c = this.cards.get(this.sel || '');
    return (c && c._on ? c : null) || this.firstCard() || this.el.querySelector('.vcat');
  }

  show() {
    const before = this._sig;
    this.models();
    // catalog changed, or the economy attached after the shell was built (owned / affordable chips): rebuild
    if (this._sig !== before || this._shellEco !== !!this.eco) { this.dirty = true; this.ensure(); } else this.renderGrid();
  }

  // tab switch: the turntable stops by itself while hidden (it renders only when visible) and its model is kept;
  // closing the menu disposes it
  hide() { this._liveId = null; }
  onMenuClose() { this.disposeTurntable(); }

  update(dt) {
    this.thumbs?.pump();
    if (this._liveId && (this._liveT -= dt) <= 0) { const id = this._liveId; this._liveId = null; this.goLive(id); }
    const w = this._liveWait;
    if (w) {
      w.t += dt;
      const c = w.canvas;
      if (!this.turn || !c) { this._liveWait = null; return; }
      if ((c.width !== 300 || c.height !== 150) || w.t > 1.5) {
        this._liveWait = null;
        this.dthumb.classList.add('live', 'ready');
        this.dthumb.classList.remove('skel');
      }
    }
  }
}

function setTextOnce(el, v) { if (el && el._t !== v) { el._t = v; el.textContent = v; } }
