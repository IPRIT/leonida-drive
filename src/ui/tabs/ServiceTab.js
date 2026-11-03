import { Tab } from './Tab.js';
import { esc, setText } from '../Hud.js';
import { icon } from '../icons.js';
import { section, choice, bindRows, setChoice } from '../widgets.js';
import { colorCss, colorNum, buildModels, DEFAULT_PALETTE } from '../vehicles-data.js';
import { drawThumb } from '../thumbs.js';
import { NEON_COLORS } from '../../economy/rules.js';

// Service items sold by the economy (workstream L): economy.buyService(id, vehicleId, opts) → Promise<{ok, reason}>,
// economy.inventory, economy.servicePrice(id, vehicleId, opts), economy.vehicleMods(vehicleId). Without
// buyService only repair (economy.repair / damage.repair) and respray (economy.paint) are offered.
const SERVICES = [['repair', 'wrench'], ['extinguisher', 'extinguisher'], ['armor', 'shield'], ['insurance', 'insure'], ['nitro', 'bolt']];
const FALLBACK_PRICE = { extinguisher: 750, armor: 25000, insurance: 5000, nitro: 400, neon: 3500, tint: 1500, horn: 1000, respray: 500, pearl: 2500 };
// neon colours are indices into the economy palette (the server validates the index)
const NEON = NEON_COLORS;
const HORNS = ['car', 'sport', 'luxury', 'truck'];

// SERVICE: current vehicle condition + paid services and cosmetics (works in both modes; online purchases show
// a pending state until the server answers).
export class ServiceTab extends Tab {
  constructor(menu) {
    super(menu, 'service');
    this.icon = 'wrench';
    this.pending = new Set();
    this.pick = { neon: 0, horn: 'sport', color: null, finish: 'color' };
    this.target = null; // vehicle id for cosmetics (defaults to the current vehicle)
    this._ecoHooked = null;
    bindRows(this.el, {
      act: (a, el) => this.act(a, el),
      choice: (k, d, row) => this.cycle(k, d, row),
    });
    this.el.addEventListener('input', (e) => {
      if (e.target.matches('input[type=color]')) { this.pick.color = colorNum(e.target.value); this.renderCosmetics(); }
    });
  }

  // ---- data access (tolerant to the final economy API) ----
  get eco() {
    const e = this.game.economy || null;
    if (e && this._ecoHooked !== e) {
      this._ecoHooked = e;
      e.onChange?.(() => { if (this.menu.open && this.menu.tab === this) this.refresh(); });
    }
    return e;
  }
  get shop() { return typeof this.eco?.buyService === 'function'; }
  get v() { const p = this.game.player; return p?.mode === 'vehicle' ? p.controllable : null; }
  inv() { return this.eco?.inventory || {}; }
  mods(id) {
    const e = this.eco, inv = this.inv();
    const c = e?.custom?.(id);
    if (c) return { armor: !!c.armor, neonKit: !!c.neonKit, neon: c.neonKit ? c.neon ?? null : null, tint: !!c.tint, horn: c.horn ?? null, color: c.paint ?? null, finish: c.finish ?? null };
    return e?.vehicleMods?.(id) ?? inv.vehicles?.[id] ?? inv.mods?.[id] ?? {};
  }
  offered(id) {
    if (!this.shop) return id === 'repair' || id === 'respray';
    const list = this.eco.services;
    if (!list) return true;
    return Array.isArray(list) ? list.some((s) => (s.id ?? s) === id) : id in list;
  }
  price(id, vid, opts) {
    const e = this.eco;
    const q = e?.serviceQuote?.(id, vid, opts);
    if (Number.isFinite(q?.price) && (q.price > 0 || q.ok)) return q.price;
    const p = e?.servicePrice?.(id, vid, opts);
    if (Number.isFinite(p)) return p;
    const list = e?.services;
    const it = Array.isArray(list) ? list.find((s) => s.id === id) : list?.[id];
    if (Number.isFinite(it?.price)) return it.price;
    if (id === 'repair') return e?.repairCost?.(this.vehicleById(vid)) ?? 0;
    if (id === 'respray') return opts?.finish === 'pearl' ? FALLBACK_PRICE.pearl : FALLBACK_PRICE.respray;
    return FALLBACK_PRICE[id] ?? 0;
  }
  money() { return this.eco?.money ?? this.game.player?.money ?? 0; }
  owns(id) { const e = this.eco; return e ? !!e.owns?.(id) : true; }
  extinguishers() { const i = this.inv(); return i.extinguisher ?? i.extinguishers ?? 0; }
  vehicleById(id) { const v = this.v; return v && v.catalogId === id ? v : null; }
  model(id) {
    const list = this.game.vehicles?.catalog || [];
    if (this._mSig !== list.length) { this._mSig = list.length; this._models = new Map(buildModels(list).map((m) => [m.id, m])); }
    return this._models.get(id);
  }
  ownedIds() {
    const e = this.eco;
    if (!e) return this.v ? [this.v.catalogId] : [];
    const ids = e.ownedList?.() || [...(e.owned || [])];
    const cur = this.v?.catalogId;
    return cur && e.owns?.(cur) && !ids.includes(cur) ? [cur, ...ids] : ids;
  }

  // ---- render ----
  build() {
    this.el.innerHTML = `
      <div class="cols svc">
        <div class="col">
          <div class="svcveh"></div>
          ${section(this.t('svc.service'), 'wrench')}
          <div class="svclist"></div>
        </div>
        <div class="col">
          ${section(this.t('svc.cosmetics'), 'spray')}
          <div class="svccos"></div>
        </div>
      </div>`;
    this.refresh();
  }

  show() {
    this.target = this.v && this.owns(this.v.catalogId) ? this.v.catalogId : (this.target && this.owns(this.target) ? this.target : this.ownedIds()[0] ?? null);
    this.dirty ? this.ensure() : this.refresh();
  }

  refresh() {
    if (!this.el.querySelector('.svclist')) return;
    const keep = this.menu.focus && this.el.contains(this.menu.focus) ? this.focusKey(this.menu.focus) : null;
    this.renderVehicle();
    this.renderServices();
    this.renderCosmetics();
    if (keep && this.menu.tab === this) {
      const el = this.el.querySelector(keep);
      if (el) { this.menu.focus = null; this.menu.setFocus(el, { scroll: false, silent: true }); }
    }
  }

  // Section markup is diffed: re-showing the tab or a periodic check rewrites nothing when nothing changed.
  setHTML(box, html) {
    if (box._html === html && box.isConnected) return false;
    box._html = html;
    box.innerHTML = html;
    return true;
  }

  renderVehicle() {
    const box = this.el.querySelector('.svcveh');
    const v = this.v;
    if (!v) { this.setHTML(box, `<div class="svcnote">${icon('info')}<span>${esc(this.t('svc.noVehicle'))}</span></div>`); this._thumbFor = null; return; }
    const m = this.model(v.catalogId);
    const mods = this.mods(v.catalogId);
    const d = v.damage;
    const st = [];
    if (d?.destroyed) st.push(['bad', 'svc.st.destroyed', 'skull']);
    else if (d?.burning) st.push(['bad', 'svc.st.burning', 'flame']);
    if (mods.plated || mods.armor) st.push(['blue', 'svc.st.plated', 'shield']);
    const ins = mods.insuredUntil ?? this.inv().insuranceUntil;
    if (ins && ins > Date.now()) st.push(['good', 'svc.st.insured', 'insure']);
    if (!st.length || (!d?.burning && !d?.destroyed && st.every((x) => x[0] !== 'bad'))) st.unshift(['ok', 'svc.st.ok', 'check']);
    const changed = this.setHTML(box, `
      <div class="svccard">
        <canvas class="svcthumb"></canvas>
        <div class="svcinfo">
          <div class="dname">${esc(m?.name || v.name || v.catalogId || '')}</div>
          <div class="svcbars">
            <div class="pbar eng"><span>${esc(this.t('svc.engine'))}</span><div class="sb"><i></i></div><b></b></div>
            <div class="pbar bod"><span>${esc(this.t('svc.body'))}</span><div class="sb"><i></i></div><b></b></div>
          </div>
          <div class="svcst">${st.map(([c, k, ic]) => `<span class="chipst ${c}">${icon(ic)}${esc(this.t(k))}</span>`).join('')}
            ${this.offered('extinguisher') ? `<span class="chipst">${icon('extinguisher')}×${this.i18n.number(this.extinguishers())}</span>` : ''}</div>
        </div>
      </div>
      ${!this.owns(v.catalogId) ? `<div class="svcnote">${icon('lock')}<span>${esc(this.t('svc.notOwned'))}</span></div>` : ''}`);
    if (changed || this._thumbFor !== v.catalogId) {
      const src = this.ui.thumbs?.get(v.catalogId);
      // drawn while the tab is on screen: sizing the canvas reads layout, which in the closed menu / an inactive tab
      // (content-visibility: hidden, e.g. the idle prebuild) forces a layout of the hidden subtree; show() draws it
      const shown = this.menu.open && this.menu.tab === this;
      if (src && shown) { drawThumb(box.querySelector('canvas'), src); this._thumbFor = v.catalogId; } else { this._thumbFor = null; if (!src) this.ui.thumbs?.request(v.catalogId, 1); }
    }
    this.updateBars();
  }

  updateBars() {
    const v = this.v, d = v?.damage;
    const set = (cls, k) => {
      const row = this.el.querySelector(`.svcbars .${cls}`);
      if (!row) return;
      const x = Math.max(0, Math.min(1, k));
      const bar = row.querySelector('i');
      if (bar._k !== x) { bar._k = x; bar.style.transform = `scaleX(${x})`; row.classList.toggle('low', x < 0.3); } // 4×/s: only changes
      setText(row.querySelector('b'), `${Math.round(x * 100)}%`);
    };
    set('eng', d ? d.engine ?? 1 : 1);
    set('bod', d ? d.body ?? 1 : 1);
  }

  // price button with pending / disabled states
  btn(id, label, price, { disabled = false, note = '', opts = null } = {}) {
    const busy = this.pending.has(id);
    const cash = this.money();
    const tooDear = price > cash && !disabled;
    const text = busy ? this.t('svc.pending') : note || (tooDear ? this.t('veh.needMore', { amount: this.i18n.money(price - cash) }) : label);
    const off = disabled || busy || tooDear;
    return `<button class="mbtn svcbtn ${busy ? 'pending' : ''} ${off ? 'disabled' : ''}" ${off ? '' : 'data-nav'} data-act="buy" data-id="${id}" ${opts ? `data-opts='${esc(JSON.stringify(opts))}'` : ''} tabindex="-1">${busy ? '<i class="spin"></i>' : ''}<span>${esc(text)}</span></button>`;
  }

  renderServices() {
    const box = this.el.querySelector('.svclist');
    const v = this.v, vid = v?.catalogId;
    const mods = vid ? this.mods(vid) : {};
    const money = (n) => this.i18n.money(n);
    const owned = vid && this.owns(vid);
    const rows = [];
    for (const [id, ic] of SERVICES) {
      if (!this.offered(id)) continue;
      let desc = this.t(`svc.${id}Desc`, { count: this.extinguishers() });
      let button;
      if (id === 'extinguisher') {
        button = this.btn(id, this.t('svc.buy', { price: money(this.price(id, vid)) }), this.price(id, vid));
      } else if (!v) {
        button = this.btn(id, '', 0, { disabled: true, note: '—' });
      } else if (id === 'repair') {
        const dmg = damageOf(v);
        const p = this.price('repair', vid);
        button = dmg <= 0.005 ? this.btn(id, '', 0, { disabled: true, note: this.t('svc.undamaged') })
          : this.btn(id, p > 0 ? this.t('svc.buy', { price: money(p) }) : this.t('svc.free'), p, { disabled: !owned && !!this.eco });
      } else if (id === 'armor') {
        button = mods.plated || mods.armor ? this.btn(id, '', 0, { disabled: true, note: this.t('svc.installed') })
          : this.btn(id, this.t('svc.buy', { price: money(this.price(id, vid)) }), this.price(id, vid), { disabled: !owned });
      } else if (id === 'insurance') {
        const until = mods.insuredUntil ?? this.inv().insuranceUntil;
        if (until && until > Date.now()) desc = this.t('svc.activeUntil', { time: this.fmtTime(until) });
        button = this.btn(id, this.t('svc.buy', { price: money(this.price(id, vid)) }), this.price(id, vid), { disabled: !owned || (until && until > Date.now()) });
      } else if (id === 'nitro') {
        const full = (v.telemetry?.boost ?? 1) >= 0.995;
        button = full ? this.btn(id, '', 0, { disabled: true, note: this.t('svc.full') })
          : this.btn(id, this.t('svc.buy', { price: money(this.price(id, vid)) }), this.price(id, vid));
      }
      rows.push(`<div class="svcrow" data-svc="${id}"><div class="svcic">${icon(ic)}</div><div class="svctx"><b>${esc(this.t(`svc.${id}`))}</b><span>${esc(desc)}</span></div>${button}</div>`);
    }
    this.setHTML(box, rows.join(''));
  }

  renderCosmetics() {
    const box = this.el.querySelector('.svccos');
    if (!box) return;
    const ids = this.ownedIds();
    if (!ids.length) { this.setHTML(box, `<div class="svcnote">${icon('lock')}<span>${esc(this.t('svc.notOwned'))}</span></div>`); return; }
    if (!this.target || !ids.includes(this.target)) this.target = ids[0];
    const vid = this.target;
    const mods = this.mods(vid);
    const money = (n) => this.i18n.money(n);
    const name = (id) => this.model(id)?.name || id;
    const p = this.pick;
    const out = [choice('target', this.t('svc.target'), ids.map((id) => ({ v: id, label: name(id) })), vid)];
    // one block per cosmetic: heading, picker, segmented options, apply button (same paddings as the rows above)
    const seg = (act, opts, cur, mark) => `<div class="seg" role="radiogroup">${opts.map(([v, label]) => `<button class="${v === cur ? 'on' : ''}" role="radio" aria-checked="${v === cur}" data-nav data-act="${act}" data-v="${v}" tabindex="-1">${esc(label)}${mark === v ? '<i class="cur">✓</i>' : ''}</button>`).join('')}</div>`;
    const head = (ic, key, extra = '') => `<div class="svcsub">${icon(ic)}<b>${esc(this.t(key))}</b>${extra}</div>`;
    const apply = (id, opts, disabled = false) => `<div class="btnrow">${this.btn(id, this.t('svc.apply', { price: money(this.price(id, vid, opts)) }), this.price(id, vid, opts), { opts, disabled })}</div>`;
    if (this.offered('neon')) {
      // the kit is bought once; after that recolouring / switching off is free (economy.setNeon)
      const kit = !!mods.neonKit, cur = mods.neon;
      const curDot = kit ? `<small>${esc(this.t('svc.current'))}: <i class="dotc" style="--c:${cur != null ? colorCss(NEON[cur]) : 'transparent'}"></i></small>` : '';
      if (this._neonFor !== vid) { this._neonFor = vid; p.neon = kit ? cur : 0; }
      if (!kit && p.neon == null) p.neon = 0;
      const neonBtn = kit
        ? `<div class="btnrow"><button class="mbtn svcbtn ${p.neon === cur ? 'disabled' : ''}" ${p.neon === cur ? '' : 'data-nav'} data-act="neonSet" tabindex="-1"><span>${esc(p.neon === cur ? this.t('svc.installed') : this.t('svc.free'))}</span></button></div>`
        : apply('neon', { color: p.neon });
      out.push(`<div class="cblock">${head('neon', 'svc.neon', curDot)}
        <div class="swatches neon">${NEON.map((c, i) => `<i data-nav data-act="neon" data-color="${i}" class="${i === p.neon ? 'on' : ''}" style="background:${colorCss(c)};--g:${colorCss(c)}"></i>`).join('')}
        ${kit ? `<i data-nav data-act="neon" data-color="off" class="offsw ${p.neon == null ? 'on' : ''}" title="${esc(this.t('svc.off'))}">${icon('plus')}</i>` : ''}</div>
        ${neonBtn}</div>`);
    }
    if (this.offered('tint')) {
      out.push(`<div class="cblock">${head('tint', 'svc.tint')}
        ${mods.tint ? `<div class="btnrow">${this.btn('tint', '', 0, { disabled: true, note: this.t('svc.installed') })}</div>` : apply('tint', {})}</div>`);
    }
    if (this.offered('horn')) {
      out.push(`<div class="cblock">${head('horn', 'svc.horn')}
        <div class="segrow">${seg('horn', HORNS.map((h) => [h, this.t(`svc.horn.${h}`)]), p.horn, mods.horn)}
        <button class="mbtn sq ghost" data-nav data-act="hornPreview" tabindex="-1" title="${esc(this.t('svc.preview'))}">${icon('horn')}</button></div>
        ${apply('horn', { variant: p.horn }, mods.horn === p.horn)}</div>`);
    }
    if (this.offered('respray')) {
      const m = this.model(vid);
      const pal = (m?.palette?.length ? m.palette : DEFAULT_PALETTE).slice(0, 9);
      if (p.color == null) p.color = mods.color ?? pal[0];
      const opts = { color: p.color, finish: p.finish };
      out.push(`<div class="cblock">${head('spray', 'svc.respray')}
        <div class="swatches">${pal.map((c) => `<i data-nav data-act="color" data-color="${colorCss(c)}" class="${c === p.color ? 'on' : ''}" style="background:${colorCss(c)}"></i>`).join('')}
        <label class="custom ${pal.includes(p.color) ? '' : 'on'}" data-nav data-key="custom" style="--c:${colorCss(p.color)}"><input type="color" tabindex="-1" value="${colorCss(p.color)}">${icon('plus')}</label></div>
        ${seg('finish', [['color', `${this.t('svc.finish.color')} · ${money(this.price('respray', vid, { ...opts, finish: 'color' }))}`], ['pearl', `${this.t('svc.finish.pearl')} · ${money(this.price('respray', vid, { ...opts, finish: 'pearl' }))}`]], p.finish, mods.finish)}
        ${apply('respray', opts)}</div>`);
    }
    this.setHTML(box, out.join(''));
  }

  fmtTime(ms) {
    try { return new Intl.DateTimeFormat(`${this.i18n.lang}-u-nu-latn`, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms)); } catch { return new Date(ms).toLocaleString(); }
  }

  // ---- actions ----
  act(a, el) {
    const p = this.pick;
    if (a === 'buy') { this.buy(el.dataset.id, el.dataset.opts ? JSON.parse(el.dataset.opts) : null); return; }
    if (a === 'neon') { p.neon = el.dataset.color === 'off' ? null : +el.dataset.color; this.renderCosmetics(); this.refocus(`[data-act="neon"][data-color="${el.dataset.color}"]`); return; }
    if (a === 'neonSet') {
      const ok = this.eco?.setNeon?.(this.target, p.neon);
      if (ok) { this.applyVisual('neon', this.target, { color: p.neon }); this.menu.status({ icon: 'check', color: 'var(--money)', text: this.t('svc.done', { item: this.t('svc.neon') }) }); }
      this.renderCosmetics();
      return;
    }
    if (a === 'horn') { p.horn = el.dataset.v; this.renderCosmetics(); this.refocus(`[data-act="horn"][data-v="${el.dataset.v}"]`); this.previewHorn(); return; }
    if (a === 'hornPreview') { this.previewHorn(); return; }
    if (a === 'color') { p.color = colorNum(el.dataset.color); this.renderCosmetics(); this.refocus(`[data-act="color"][data-color="${el.dataset.color}"]`); return; }
    if (a === 'finish') { p.finish = el.dataset.v; this.renderCosmetics(); this.refocus(`[data-act="finish"][data-v="${el.dataset.v}"]`); }
  }

  refocus(sel) {
    const el = this.el.querySelector(sel);
    if (el) { this.menu.focus = null; this.menu.setFocus(el, { scroll: false, silent: true }); }
  }

  cycle(k, d, row) {
    if (k !== 'target') return;
    const ids = this.ownedIds();
    const i = (ids.indexOf(this.target) + d + ids.length) % ids.length;
    this.target = ids[i];
    setChoice(row, i, this.model(this.target)?.name || this.target);
    this.pick.color = null;
    this.renderCosmetics();
    this.refocus('[data-key="target"]');
  }

  previewHorn() {
    const a = this.game.audio;
    try {
      const h = a?.loop?.(`horn:${this.pick.horn}`, { bus: 'ui', volume: 0.8 });
      if (h) setTimeout(() => h.stop?.(0.08), 650);
    } catch (e) { console.warn('[ui] horn preview', e); }
  }

  async buy(id, opts) {
    if (this.pending.has(id)) return;
    const e = this.eco, v = this.v;
    const cosmetic = id === 'neon' || id === 'tint' || id === 'horn' || id === 'respray';
    const vid = cosmetic ? this.target : v?.catalogId ?? null;
    const item = this.t(`svc.${id}`);
    this.pending.add(id);
    this.refresh();
    let res;
    try {
      if (this.shop) res = await e.buyService(id, vid, opts || {});
      else if (id === 'repair') res = e ? await e.repair(v) : (v?.damage?.repair?.(), { ok: true });
      else if (id === 'respray') res = e ? await e.paint(opts?.finish === 'pearl' ? 'pearl' : 'color') : { ok: true };
      else res = { ok: false, reason: 'offline' };
    } catch (err) {
      res = { ok: false, reason: String(err?.message || err) };
    }
    this.pending.delete(id);
    if (res?.ok) {
      this.applyVisual(id, vid, opts);
      this.game.events.emit('ui:purchase', { id, service: true, vehicleId: vid });
      if (res.cost || res.price) this.ui.hud.moneyPop(-(res.cost || res.price));
      this.menu.status({ icon: 'check', color: 'var(--money)', text: this.t('svc.done', { item }) });
    } else {
      const r = res?.reason;
      const reason = r && this.i18n.has(`svc.reason.${r}`) ? this.t(`svc.reason.${r}`) : r || this.t('svc.reason.rejected');
      this.menu.status({ icon: 'info', color: '#d83a35', text: this.t('svc.failed', { item, reason }) });
    }
    this.refresh();
    const row = this.el.querySelector(`[data-svc="${id}"]`);
    if (row && res?.ok) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
  }

  // Make the change visible right away on the current vehicle (the vehicles / economy modules may also apply it)
  applyVisual(id, vid, opts = {}) {
    const v = this.v;
    this.game.events.emit('vehicle:service', { id, vehicleId: vid, vehicle: v && v.catalogId === vid ? v : null, ...opts });
    if (!v || v.catalogId !== vid) return;
    try {
      if (id === 'respray' && opts.color != null) { v.setColor?.(opts.color, opts.finish); applyFinish(v, opts.finish); }
      else if (id === 'horn' && opts.variant) v.hornType = opts.variant;
      else if (id === 'nitro') { if (v.refillBoost) v.refillBoost(); else v.boost?.refill?.(); }
    } catch (e) { console.warn('[ui] apply service visual', e); }
  }

  update(dt) {
    if ((this._t = (this._t || 0) - dt) > 0) return;
    this._t = 0.25;
    this.updateBars();
    const d = this.v?.damage;
    const sig = `${this.v?.catalogId}|${d?.state}|${Math.round(damageOf(this.v) * 50)}|${(this.v?.telemetry?.boost ?? 1) >= 0.995}`;
    if (sig !== this._sig) { this._sig = sig; this.renderVehicle(); this.renderServices(); }
  }

  hints() { return [[['Q', 'E'], 'menu.hint.tabs']]; }
}

// same formula as the economy: average of engine and body damage
function damageOf(v) {
  const d = v?.damage;
  if (!d) return 0;
  if (d.destroyed) return 1;
  const body = Number.isFinite(d.body) ? d.body : 1;
  const engine = Number.isFinite(d.engine) ? d.engine : 1;
  return Math.max(0, Math.min(1, 1 - (body + engine) / 2));
}

// Paint finish on the current vehicle. Uses the vehicles module API when present (v.setFinish / v.setPaint), otherwise
// tunes the shared MeshStandardMaterial: pearl = more metallic and glossier than the default gloss paint.
const FINISH = { color: { metalness: 0.4, roughness: 0.3 }, pearl: { metalness: 0.78, roughness: 0.13 }, metallic: { metalness: 0.85, roughness: 0.2 } };
export function applyFinish(v, finish = 'color') {
  if (v.setFinish) { v.setFinish(finish); return; }
  if (v.setPaint) { v.setPaint({ color: v.color, finish }); return; }
  const mat = v.materials?.paint;
  if (!mat || !('metalness' in mat)) return;
  const f = FINISH[finish] || FINISH.color;
  mat.metalness = f.metalness;
  mat.roughness = f.roughness;
  if ('envMapIntensity' in mat) mat.envMapIntensity = finish === 'color' ? 1 : 1.35;
  v.finish = finish;
}
