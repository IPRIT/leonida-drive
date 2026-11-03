import { Tab } from './Tab.js';
import { esc } from '../Hud.js';
import { icon } from '../icons.js';
import { colorCss, colorNum } from '../vehicles-data.js';
import { drawThumb } from '../thumbs.js';

// item thumbnails (D's getWardrobeThumbs): skeleton shimmer until baked, then a cross-fade
const THUMB_CSS = `.wthumb{overflow:hidden}.wthumb .tcv{position:absolute;inset:0;width:100%;height:100%;opacity:0;transition:opacity .35s ease}
.wthumb.ready .tcv{opacity:1}.wthumb .ph{display:grid;place-items:center;width:100%;height:100%;transition:opacity .35s ease}
.wthumb.ready .ph{opacity:0}.wthumb.skel .ph{opacity:.35}
.wthumb.skel::after{content:'';position:absolute;top:0;bottom:0;left:0;width:220%;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.13) 50%,transparent 70%);animation:shimmer 1.3s linear infinite;pointer-events:none}`;

// Wardrobe data and preview come from the characters workstream (D): src/characters/wardrobe.js exporting the item
// list (WARDROBE | WARDROBE_ITEMS | ITEMS) and createCharacterPreview(game, el) → { setOutfit, rotate, setView?, dispose }.
// Prices / ownership / outfits / nickname come from the economy (L). Everything is optional: the tab degrades.
const OPTIONAL = import.meta.glob(['../../characters/wardrobe.js', '../../characters/preview.js']);
const CATS = [['hair', 'scissors'], ['beard', 'beard'], ['tops', 'shirt'], ['jackets', 'jacket'], ['legs', 'pants'], ['shoes', 'shoe'],
  ['hats', 'cap'], ['glasses', 'glasses'], ['accessories', 'watch'], ['tattoos', 'tattoo'], ['body', 'user']];
const SLOT_ALIAS = { top: 'tops', shirt: 'tops', jacket: 'jackets', coat: 'jackets', pants: 'legs', bottoms: 'legs', leg: 'legs', trousers: 'legs',
  shoe: 'shoes', footwear: 'shoes', hat: 'hats', headwear: 'hats', cap: 'hats', glass: 'glasses', eyewear: 'glasses',
  accessory: 'accessories', acc: 'accessories', tattoo: 'tattoos', skin: 'body', shape: 'body', facialhair: 'beard', facial: 'beard', hairstyle: 'hair' };
const TIERS = ['basic', 'street', 'premium', 'luxury'];
const NICK_PRICE = { random: 2500, custom: 50000 };
const NICK_RE = /^[A-Za-z0-9_-]+$/;
const OUTFITS_KEY = 'leonida.outfits';

const slotOf = (it) => { const k = String(it.slot ?? it.category ?? it.cat ?? '').toLowerCase(); return SLOT_ALIAS[k] || k; };

// WARDROBE ("Внешность"): big live preview, categories, item grid with try-on, basket, saved outfits, nickname.
export class WardrobeTab extends Tab {
  constructor(menu) {
    super(menu, 'wardrobe');
    this.icon = 'hanger';
    this.cat = 'tops';
    this.items = [];
    this.createPreview = null;
    this.preview = null;
    this.angle = 0.4;
    this.view = 'body';
    this.tryOn = {}; // slot → { id, color } (not applied to the player until worn/bought)
    this.pending = new Set();
    this.nick = { suggestions: null, pick: null, value: '', checked: null };
    this.loadOptional();
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('input', (e) => {
      if (e.target.matches('.nickin input')) { this.nick.value = e.target.value; this.nick.checked = null; this.renderNickHints(); }
    });
    this.el.addEventListener('keydown', (e) => {
      if (!e.target.matches('.nickin input')) return;
      if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); e.target.blur(); }
    });
  }

  async loadOptional() {
    for (const l of Object.values(OPTIONAL)) {
      try {
        const m = await l();
        const list = m.WARDROBE || m.WARDROBE_ITEMS || m.ITEMS || m.default?.items;
        if (Array.isArray(list)) this.items = list.map((it) => ({ ...it, slot: slotOf(it), itemSlot: it.slot }));
        if (typeof m.createCharacterPreview === 'function') this.createPreview = m.createCharacterPreview;
        if (typeof m.getWardrobeThumbs === 'function') this.getThumbs = m.getWardrobeThumbs;
      } catch (e) { console.warn('[ui] optional wardrobe module failed', e); }
    }
    this.dirty = true;
    if (this.menu.open && this.menu.tab === this) { this.ensure(); this.show(); }
  }

  // ---- data (tolerant to the final D / L APIs) ----
  get eco() { return this.game.economy || null; }
  // memoised per source list (renders, the basket and try-on look items up many times per click)
  allItems() {
    const svc = this.game.wardrobe?.items;
    if (!Array.isArray(svc)) return this.items;
    if (this._svcSrc !== svc || this._svcLen !== svc.length) { this._svcSrc = svc; this._svcLen = svc.length; this._svcItems = svc.map((it) => ({ ...it, slot: slotOf(it), itemSlot: it.slot })); }
    return this._svcItems;
  }
  item(id) {
    const all = this.allItems();
    if (this._idxOf !== all || this._idxLen !== all.length) {
      this._idxOf = all; this._idxLen = all.length; this._idx = new Map();
      for (const it of all) if (!this._idx.has(it.id)) this._idx.set(it.id, it);
    }
    return this._idx.get(id);
  }
  itemName(it) { return it.nameKey && this.i18n.has(it.nameKey) ? this.t(it.nameKey) : this.i18n.has(`wd.item.${it.id}`) ? this.t(`wd.item.${it.id}`) : it.name || it.id; }
  price(it) { const p = this.eco?.wardrobePrice?.(it.id); return Number.isFinite(p) ? p : it.price ?? 0; }
  owns(it) {
    const e = this.eco;
    if (!it || this.price(it) <= 0) return true;
    if (!e) return true; // no economy: everything is free
    if (e.ownsWardrobe) return !!e.ownsWardrobe(it.id);
    const o = typeof e.ownedWardrobe === 'function' ? e.ownedWardrobe() : e.ownedWardrobe;
    if (o?.has) return o.has(it.id);
    if (Array.isArray(o)) return o.includes(it.id);
    return false;
  }
  // current outfit keyed by this tab's categories (the character / economy key it by item slot: top, facial, …)
  outfit() {
    const src = this.game.player?.outfit || this.eco?.outfit || {};
    const out = {};
    for (const [k, v] of Object.entries(src)) {
      if (!v || k === 'colors') continue;
      const sel = typeof v === 'object' ? { id: v.id, color: v.color ?? null } : { id: v, color: src.colors?.[v] ?? null };
      const it = this.item(sel.id);
      out[it?.slot || SLOT_ALIAS[k] || k] = sel;
    }
    return out;
  }
  // UI-category keys → the canonical outfit keyed by item slot (top, jacket, hat, facial, accessory, tattoo, …)
  canonical(o) {
    const out = {};
    for (const sel of Object.values(o || {})) {
      const it = sel?.id && this.item(sel.id);
      if (it) out[it.itemSlot || it.slot] = { id: sel.id, color: sel.color ?? null };
    }
    return out;
  }
  // colour the player owns an item in (null = the palette default)
  ownedColor(it) { return this.eco?.wardrobeColor?.(it.id) ?? this.colors(it)[0] ?? null; }
  // a tried item costs its price, or the re-dye price when it is owned in another colour
  cost(it, color) {
    if (!this.owns(it)) return this.price(it);
    if (!this.eco || color == null || colorNum(color) === colorNum(this.ownedColor(it) ?? 0)) return 0;
    const d = this.eco.wardrobeDyePrice?.(it.id);
    return Number.isFinite(d) ? d : 0;
  }
  merged() { return { ...this.outfit(), ...this.tryOn }; }
  colors(it) { return (it.colors || it.palette || []).slice(0, 8); }
  basket() {
    const out = [];
    for (const sel of Object.values(this.tryOn)) {
      const it = sel && this.item(sel.id);
      if (it && this.cost(it, sel.color) > 0) out.push(it);
    }
    return out;
  }
  basketTotal() { return Object.values(this.tryOn).reduce((s, sel) => { const it = sel && this.item(sel.id); return s + (it ? this.cost(it, sel.color) : 0); }, 0); }
  savedOutfits() {
    const e = this.eco;
    if (Array.isArray(e?.outfits)) return e.outfits;
    try { return JSON.parse(localStorage.getItem(OUTFITS_KEY) || '[]'); } catch { return []; }
  }

  // ---- layout ----
  build() {
    this.onMenuClose(); // a live preview belongs to the stage element that is replaced below
    const tabs = [...CATS.map(([c, ic]) => [c, ic, `wd.cat.${c}`]), ['outfits', 'hanger', 'wd.outfits'], ['profile', 'idcard', 'wd.profile']];
    this.el.innerHTML = `
      <div class="wd">
        <div class="wdprev">
          <div class="wdstage"><div class="wdph">${icon('user')}<span>${esc(this.t('wd.previewSoon'))}</span></div></div>
          <div class="wdview">${['body', 'face'].map((v) => `<button class="chip ${v === this.view ? 'on' : ''}" data-nav data-act="view" data-v="${v}" tabindex="-1">${esc(this.t(`wd.view.${v}`))}</button>`).join('')}</div>
          <div class="wdhint">${icon('auto')}${esc(this.t('wd.rotateHint'))}</div>
        </div>
        <div class="wdmain">
          <div class="wdcats">${tabs.map(([c, ic, k]) => `<button class="wdcat ${c === this.cat ? 'on' : ''}" data-nav data-act="cat" data-cat="${c}" tabindex="-1">${icon(ic)}<span>${esc(this.t(k))}</span></button>`).join('')}</div>
          <div class="wdbody"></div>
          <div class="wdbar"></div>
        </div>
      </div>`;
    this.stage = this.el.querySelector('.wdstage');
    this.bindDrag();
    this.renderBody();
    this.renderBar();
  }

  show() {
    this.ensure();
    if (this.preview) { this.updatePreview(); this.preview.rotate?.(this.angle); this.applyView(); } else this.mountPreview();
    this.renderBody();
    this.renderBar();
  }

  // The preview renders only while its element is visible (it stops by itself on a tab switch), so it is kept
  // across tab switches — no studio / figure rebuild when coming back — and disposed when the menu closes.
  hide() {}
  onMenuClose() {
    try { this.preview?.dispose?.(); } catch (e) { console.warn('[ui] preview dispose', e); }
    this.preview = null;
    this.stage?.classList.remove('live');
  }

  // body / bar markup is diffed: re-showing the tab rewrites nothing when nothing changed
  setHTML(box, html) {
    if (box._html === html) return false;
    box._html = html;
    box.innerHTML = html;
    return true;
  }

  mountPreview() {
    if (this.preview || !this.stage) return;
    const make = this.createPreview || ((g, el) => g.characters?.createPreview?.(el));
    try { this.preview = make(this.game, this.stage) || null; } catch (e) { console.error('[ui] character preview failed', e); this.preview = null; }
    this.stage.classList.toggle('live', !!this.preview);
    if (this.preview) {
      this.preview.setOutfit?.(this.merged());
      this.preview.rotate?.(this.angle);
      this.applyView();
    }
  }

  applyView() { const p = this.preview; if (p?.setView) p.setView(this.view); else p?.zoom?.(this.view); }

  bindDrag() {
    const st = this.stage;
    st.style.touchAction = 'none';
    let drag = null;
    st.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, a: this.angle }; try { st.setPointerCapture(e.pointerId); } catch { /* ignore */ } st.classList.add('drag'); });
    st.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.angle = drag.a + (e.clientX - drag.x) * 0.012;
      this.preview?.rotate?.(this.angle);
    });
    const up = () => { drag = null; st.classList.remove('drag'); };
    st.addEventListener('pointerup', up);
    st.addEventListener('pointercancel', up);
  }

  renderBody() {
    const box = this.el.querySelector('.wdbody');
    if (!box) return;
    if (this.cat === 'profile') { box._ids = null; this.setHTML(box, this.profileHTML()); this.renderNickHints(); return; }
    if (this.cat === 'outfits') { box._ids = null; this.setHTML(box, this.outfitsHTML()); return; }
    const list = this.allItems().filter((it) => it.slot === this.cat);
    if (!list.length) { box._ids = null; this.setHTML(box, `<div class="vempty">${icon('hanger')}<br>${esc(this.t('wd.soon'))}</div>`); return; }
    const cur = this.outfit()[this.cat], sel = this.tryOn[this.cat];
    const catIcon = (CATS.find((c) => c[0] === this.cat) || [])[1] || 'shirt';
    const cards = list.map((it) => {
      const on = sel ? sel.id === it.id : cur?.id === it.id;
      const color = (on ? (sel || cur)?.color : null) ?? this.colors(it)[0] ?? null; // `on && x` was false for other cards
      const tier = TIERS.includes(it.tier) ? it.tier : 'basic';
      const owned = this.owns(it), p = owned ? (sel?.id === it.id ? this.cost(it, sel.color) : 0) : this.price(it);
      return `<div class="wcard ${on ? 'picked' : ''} t-${tier}" data-nav data-id="${esc(it.id)}">
        <div class="wthumb${it.thumb ? '' : ' skel'}" data-tk="${esc(this.thumbKey(it.id, color))}" data-tc="${color == null ? '' : colorNum(color)}" style="--c:${color != null ? colorCss(color) : '#888'}">${it.thumb ? `<img src="${esc(it.thumb)}" alt="" draggable="false">` : `<canvas class="tcv"></canvas><span class="ph">${icon(catIcon)}</span>`}</div>
        <div class="wn">${esc(this.itemName(it))}</div>
        <div class="wmeta"><span class="tier">${esc(this.t(`wd.tier.${tier}`))}</span>
          <span class="wprice ${owned && !p ? 'own' : ''}">${esc(owned ? (p > 0 ? this.i18n.money(p) : this.price(it) > 0 ? this.t('wd.owned') : this.t('wd.free')) : this.i18n.money(p))}</span></div>
        ${this.colors(it).length > 1 ? `<div class="wsw">${this.colors(it).map((c) => `<i data-act="color" data-c="${colorCss(c)}" class="${on && colorNum(color) === colorNum(c) ? 'on' : ''}" style="background:${colorCss(c)}"></i>`).join('')}</div>` : ''}
        ${sel?.id === it.id ? `<span class="trying">${esc(this.t('wd.trying'))}</span>` : ''}
      </div>`;
    });
    // same item list (try-on, colour, purchase): replace only the cards whose markup changed (usually two)
    const ids = list.map((it) => it.id).join('\u0001');
    const grid = box.firstElementChild;
    if (box._ids === ids && grid?.classList.contains('wdgrid') && grid.children.length === cards.length) {
      for (let i = 0; i < cards.length; i++) {
        const el = grid.children[i];
        if (el._h === cards[i]) continue;
        const t = document.createElement('template');
        t.innerHTML = cards[i].trim();
        const n = t.content.firstElementChild;
        n._h = cards[i];
        el.replaceWith(n);
        if (this.menu.focus === el) { this.menu.focus = null; this.menu.setFocus(n, { scroll: false, silent: true }); }
      }
      box._html = null;
      this.observeThumbs(grid);
      return;
    }
    box._ids = ids;
    if (this.setHTML(box, `<div class="wdgrid">${cards.join('')}</div>`)) {
      const kids = box.firstElementChild.children;
      for (let i = 0; i < kids.length; i++) kids[i]._h = cards[i];
    }
    this.observeThumbs(box.firstElementChild);
  }

  // ---- item thumbnails: baked lazily for cards near the viewport, cached per item + colour ----
  get thumbs() {
    if (this._thumbs === undefined && this.getThumbs && this.game.renderer) {
      try { this._thumbs = this.getThumbs(this.game) || null; } catch (e) { console.warn('[ui] wardrobe thumbnails', e); this._thumbs = null; }
      this._thumbs?.onReady?.((k) => { for (const el of this.el.querySelectorAll(`.wthumb[data-tk="${CSS.escape(k)}"]`)) this.paintThumb(el); });
    }
    return this._thumbs || null;
  }
  thumbKey(id, color) { return this.thumbs?.key ? this.thumbs.key(id, color == null ? null : colorNum(color)) : `${id}|${color ?? ''}`; }
  observeThumbs(grid) {
    if (!grid || !this.thumbs) return;
    if (!document.getElementById('wd-thumb-css')) { const st = document.createElement('style'); st.id = 'wd-thumb-css'; st.textContent = THUMB_CSS; document.head.appendChild(st); }
    if (!this._io && 'IntersectionObserver' in window) {
      this._io = new IntersectionObserver((ents) => {
        for (const e of ents) {
          if (!e.isIntersecting) continue;
          const th = e.target;
          if (e.boundingClientRect.width > 0) { th._tw = e.boundingClientRect.width; th._th = e.boundingClientRect.height; this._tsize = [th._tw, th._th]; }
          if (!this.paintThumb(th)) { const [id, c] = this.thumbArgs(th); this.thumbs.request(id, c, 1); }
        }
      }, { rootMargin: '200px 0px' });
    }
    for (const th of grid.querySelectorAll('.wthumb.skel')) {
      if (th._obs) continue;
      th._obs = true;
      if (this._tsize) { th._tw = this._tsize[0]; th._th = this._tsize[1]; }
      if (th._tw && this.paintThumb(th)) continue; // cached: no shimmer
      if (this._io) this._io.observe(th); else { const [id, c] = this.thumbArgs(th); this.thumbs.request(id, c, 0); }
    }
  }
  thumbArgs(th) {
    const card = th.closest('.wcard'), tc = th.dataset.tc;
    return [card?.dataset.id, tc ? +tc : null];
  }
  paintThumb(th) {
    if (!th?.isConnected || th.classList.contains('ready')) return !!th?.classList.contains('ready');
    const [id, c] = this.thumbArgs(th);
    const src = id && this.thumbs?.get(id, c);
    if (!src || !drawThumb(th.querySelector('.tcv'), src, th._tw || this._tsize?.[0] || 0, th._th || this._tsize?.[1] || 0)) return false;
    th.classList.remove('skel');
    th.classList.add('ready');
    this._io?.unobserve(th);
    return true;
  }

  renderBar() {
    const bar = this.el.querySelector('.wdbar');
    if (!bar) return;
    const items = this.basket();
    const total = this.basketTotal();
    const changed = Object.keys(this.tryOn).length > 0;
    const busy = this.pending.has('buy');
    if (!changed) { this.setHTML(bar, `<span class="wdhint2">${esc(this.t('wd.nothing'))}</span>`); return; }
    const cash = this.eco?.money ?? this.game.player?.money ?? 0;
    const main = items.length
      ? (total > cash
        ? `<button class="mbtn big buy disabled" tabindex="-1">${icon('money')}<span>${esc(this.t('veh.needMore', { amount: this.i18n.money(total - cash) }))}</span></button>`
        : `<button class="mbtn big buy ${busy ? 'pending disabled' : ''}" ${busy ? '' : 'data-nav'} data-act="buyAll" tabindex="-1">${busy ? '<i class="spin"></i>' : icon('money')}<span>${esc(busy ? this.t('svc.pending') : this.t('wd.buyAll', { price: this.i18n.money(total) }))}</span></button>`)
      : `<button class="mbtn big primary" data-nav data-act="wear" tabindex="-1">${icon('check')}<span>${esc(this.t('wd.wear'))}</span></button>`;
    this.setHTML(bar, `<div class="wdsum">${items.length ? `<b>${esc(this.t('wd.basket', { count: items.length }))}</b><span>${esc(this.i18n.money(total))}</span>` : ''}</div>
      <button class="mbtn ghost" data-nav data-act="reset" tabindex="-1">${icon('auto')}<span>${esc(this.t('wd.reset'))}</span></button>${main}`);
  }

  outfitsHTML() {
    const saved = this.savedOutfits();
    return `<div class="wdslots">${[0, 1, 2].map((i) => {
      const o = saved[i];
      const names = o ? Object.values(o).map((sel) => this.item(sel?.id)).filter(Boolean) : [];
      const missing = names.filter((it) => !this.owns(it)).length;
      return `<div class="wslot">
        <div class="wsh"><b>${esc(this.t('wd.slot', { n: i + 1 }))}</b>${missing ? `<small>${esc(this.t('wd.needItems', { count: missing }))}</small>` : ''}</div>
        <div class="wsl">${names.length ? names.map((it) => `<span>${esc(this.itemName(it))}</span>`).join('') : `<em>${esc(this.t('wd.empty'))}</em>`}</div>
        <div class="btnrow"><button class="mbtn ghost" data-nav data-act="saveSlot" data-i="${i}" tabindex="-1">${esc(this.t('wd.save'))}</button>
        ${o ? `<button class="mbtn primary" data-nav data-act="loadSlot" data-i="${i}" tabindex="-1">${esc(this.t('wd.load'))}</button>` : ''}</div>
      </div>`;
    }).join('')}</div>`;
  }

  nickApi() { const e = this.eco; return typeof e?.changeNick === 'function' ? e : null; }
  currentNick() { return this.game.net?.me?.nick || this.eco?.nick || this.game.settings.nick || '—'; }
  nickPrice(mode) { const p = this.eco?.nickPrice?.(mode); return Number.isFinite(p) ? p : NICK_PRICE[mode]; }

  profileHTML() {
    const api = this.nickApi();
    const money = (n) => this.i18n.money(n);
    const n = this.nick;
    const busy = (k) => this.pending.has(k);
    const btn = (act, label, enabled, key) => `<button class="mbtn svcbtn ${busy(key) ? 'pending' : ''} ${enabled && !busy(key) ? '' : 'disabled'}" ${enabled && !busy(key) ? 'data-nav' : ''} data-act="${act}" tabindex="-1">${busy(key) ? '<i class="spin"></i>' : ''}<span>${esc(busy(key) ? this.t('svc.pending') : label)}</span></button>`;
    return `<div class="wdprof">
      <div class="nickcur"><span>${esc(this.t('wd.nickCurrent'))}</span><b>${esc(this.currentNick())}</b></div>
      ${!api ? `<div class="svcnote">${icon('info')}<span>${esc(this.t('wd.offline'))}</span></div>` : ''}
      <div class="cblock">
        <div class="svcsub">${icon('auto')}<b>${esc(this.t('wd.nickRandom'))}</b><small>${esc(money(this.nickPrice('random')))}</small></div>
        <span class="cdesc">${esc(this.t('wd.nickRandomDesc'))}</span>
        ${n.suggestions ? `<div class="seg nicks">${n.suggestions.map((s) => `<button class="${s === n.pick ? 'on' : ''}" data-nav data-act="pickNick" data-v="${esc(s)}" tabindex="-1">${esc(s)}</button>`).join('')}</div>` : ''}
        <div class="btnrow">${n.suggestions
          ? btn('buyRandom', this.t('svc.buy', { price: money(this.nickPrice('random')) }), !!api && !!n.pick, 'random')
          : btn('suggest', this.t('wd.suggest'), !!api, 'suggest')}</div>
      </div>
      <div class="cblock">
        <div class="svcsub">${icon('idcard')}<b>${esc(this.t('wd.nickCustom'))}</b><small>${esc(money(this.nickPrice('custom')))}</small></div>
        <span class="cdesc">${esc(this.t('wd.nickCustomDesc'))}</span>
        <label class="vsearch nickin" data-nav data-key="nickin">${icon('idcard')}<input type="text" maxlength="16" spellcheck="false" autocomplete="off" tabindex="-1" placeholder="${esc(this.t('wd.nickInput'))}" value="${esc(n.value)}"></label>
        <div class="nickrules"></div>
        <div class="btnrow">${btn('checkNick', this.t('wd.check'), false, 'check')}${btn('buyCustom', this.t('svc.buy', { price: money(this.nickPrice('custom')) }), false, 'custom')}</div>
      </div>
    </div>`;
  }

  // live validation hints + enabling the check / buy buttons (no full re-render while typing)
  renderNickHints() {
    const box = this.el.querySelector('.nickrules');
    if (!box) return;
    const v = this.nick.value.trim();
    const lenOk = v.length >= 3 && v.length <= 16, charsOk = v.length > 0 && NICK_RE.test(v);
    const st = this.nick.checked;
    box.innerHTML = `<span class="${lenOk ? 'ok' : v ? 'bad' : ''}">${lenOk ? '✓' : '•'} ${esc(this.t('wd.rule.len'))}</span>
      <span class="${charsOk ? 'ok' : v ? 'bad' : ''}">${charsOk ? '✓' : '•'} ${esc(this.t('wd.rule.chars'))}</span>
      ${st && st.value === v ? `<span class="${st.ok ? 'ok' : 'bad'}">${st.ok ? '✓' : '✗'} ${esc(this.t(st.ok ? 'wd.available' : 'wd.taken'))}${!st.ok && st.reason ? ` (${esc(st.reason)})` : ''}</span>` : ''}`;
    const api = !!this.nickApi();
    const valid = lenOk && charsOk;
    const set = (act, on) => {
      const b = this.el.querySelector(`[data-act="${act}"]`);
      if (!b || b.classList.contains('pending')) return;
      b.classList.toggle('disabled', !on);
      if (on) b.setAttribute('data-nav', ''); else b.removeAttribute('data-nav');
    };
    set('checkNick', api && valid);
    set('buyCustom', api && valid && st?.value === v && st.ok);
  }

  // ---- actions ----
  onClick(e) {
    const a = e.target.closest('[data-act]');
    const card = e.target.closest('.wcard');
    if (a?.dataset.act === 'color' && card) { e.stopPropagation(); this.tryItem(card.dataset.id, colorNum(a.dataset.c), true); return; }
    if (card) { this.tryItem(card.dataset.id); return; }
    if (!a || a.classList.contains('disabled')) return;
    const act = a.dataset.act;
    if (act === 'cat') this.setCat(a.dataset.cat);
    else if (act === 'view') { this.view = a.dataset.v; this.el.querySelectorAll('[data-act="view"]').forEach((b) => b.classList.toggle('on', b === a)); this.applyView(); }
    else if (act === 'reset') { this.tryOn = {}; this.updatePreview(); this.renderBody(); this.renderBar(); }
    else if (act === 'wear') this.wear();
    else if (act === 'buyAll') this.buyAll();
    else if (act === 'saveSlot') this.saveSlot(+a.dataset.i);
    else if (act === 'loadSlot') this.loadSlot(+a.dataset.i);
    else if (act === 'suggest') this.suggest();
    else if (act === 'pickNick') { this.nick.pick = a.dataset.v; this.renderBody(); this.refocus(`[data-act="pickNick"][data-v="${CSS.escape(a.dataset.v)}"]`); }
    else if (act === 'buyRandom') this.buyNick('random', this.nick.pick);
    else if (act === 'checkNick') this.checkNick();
    else if (act === 'buyCustom') this.buyNick('custom', this.nick.value.trim());
  }

  refocus(sel) {
    const el = this.el.querySelector(sel);
    if (el) { this.menu.focus = null; this.menu.setFocus(el, { scroll: false, silent: true }); }
  }

  setCat(c) {
    if (c === this.cat) return;
    this.cat = c;
    this.el.querySelectorAll('.wdcat').forEach((b) => b.classList.toggle('on', b.dataset.cat === c));
    this.renderBody();
  }

  // Try-on is sticky and only changes on click / Enter: a second click on the tried item takes it off again.
  tryItem(id, color, keep = false) {
    const it = this.item(id);
    if (!it) return;
    const slot = it.slot;
    const sel = this.tryOn[slot];
    if (sel?.id === id && color === undefined && !keep) delete this.tryOn[slot];
    else this.tryOn[slot] = { id, color: color ?? sel?.color ?? this.colors(it)[0] ?? null };
    const cur = this.outfit()[slot];
    if (this.tryOn[slot] && cur?.id === id && colorNum(cur.color ?? 0) === colorNum(this.tryOn[slot].color ?? 0)) delete this.tryOn[slot];
    this.updatePreview();
    this.renderBody();
    this.renderBar();
    this.refocus(`.wcard[data-id="${CSS.escape(id)}"]`);
  }

  updatePreview() { this.preview?.setOutfit?.(this.merged()); }

  applyOutfit(outfit) {
    const g = this.game;
    const fit = this.canonical(outfit);
    let res = { ok: true };
    try {
      if (this.eco?.setOutfit) {
        const slots = {};
        for (const [slot, sel] of Object.entries(fit)) slots[slot] = sel.id;
        res = this.eco.setOutfit(slots) || { ok: true };
        if (!res.ok) console.warn('[ui] outfit rejected by the economy', res.reason, slots);
      }
      if (res.ok) g.player?.setOutfit?.(fit);
    } catch (e) { console.warn('[ui] apply outfit', e); res = { ok: false, reason: String(e?.message || e) }; }
    if (res.ok) g.events.emit('wardrobe:outfit', { outfit: fit });
    return res;
  }

  wear() {
    if (this.basket().length) return;
    const res = this.applyOutfit(this.merged());
    if (!res.ok) { this.fail(this.t('wd.outfits'), res.reason); return; }
    this.tryOn = {};
    this.renderBody();
    this.renderBar();
    this.menu.status({ icon: 'check', color: 'var(--money)', text: this.t('wd.worn') });
  }

  async buyAll() {
    const items = this.basket();
    if (!items.length || this.pending.has('buy')) return;
    const total = this.basketTotal();
    const ok = await this.menu.confirm({ title: this.t('wd.buyTitle'), text: this.t('wd.buyText', { price: this.i18n.money(total) }), ok: this.t('wd.buyAll', { price: this.i18n.money(total) }) });
    if (!ok) return;
    const e = this.eco;
    this.pending.add('buy');
    this.renderBar();
    // one purchase (or re-dye) per item, in the colour being tried on; stop at the first refusal
    let res = { ok: true }, spent = 0, failed = null;
    const bought = [];
    for (const it of items) {
      const sel = Object.values(this.tryOn).find((x) => x?.id === it.id);
      const color = sel?.color == null ? null : colorNum(sel.color);
      try { res = e?.buyWardrobe ? await e.buyWardrobe(it.id, color) : { ok: false, reason: 'offline' }; } catch (err) { res = { ok: false, reason: String(err?.message || err) }; }
      if (!res?.ok) { failed = it; break; }
      spent += Number.isFinite(res.cost) ? res.cost : this.cost(it, color);
      bought.push(it.id);
    }
    this.pending.delete('buy');
    if (bought.length) {
      this.game.events.emit('ui:purchase', { wardrobe: bought, price: spent });
      if (spent) this.ui.hud.moneyPop(-spent);
    }
    // wear everything tried on that is now owned (a refused item stays in the basket)
    const wearNow = { ...this.outfit() };
    for (const [cat, sel] of Object.entries(this.tryOn)) { const it = sel && this.item(sel.id); if (it && this.cost(it, sel.color) === 0) { wearNow[cat] = sel; delete this.tryOn[cat]; } }
    const fit = this.applyOutfit(wearNow);
    if (!failed && fit.ok) this.menu.status({ icon: 'star', color: 'var(--money)', text: this.t('wd.bought') });
    else this.fail(failed ? this.itemName(failed) : this.t('wd.outfits'), failed ? res?.reason : fit.reason);
    this.renderBody();
    this.renderBar();
  }

  fail(item, r) {
    const reason = r && this.i18n.has(`svc.reason.${r}`) ? this.t(`svc.reason.${r}`) : r || this.t('svc.reason.rejected');
    this.menu.status({ icon: 'info', color: '#d83a35', text: this.t('svc.failed', { item, reason }) });
  }

  saveSlot(i) {
    const o = this.merged();
    const e = this.eco;
    if (e?.saveOutfit) e.saveOutfit(i, o);
    else {
      const all = this.savedOutfits();
      all[i] = o;
      try { localStorage.setItem(OUTFITS_KEY, JSON.stringify(all)); } catch { /* private mode */ }
    }
    this.renderBody();
    this.menu.status({ icon: 'hanger', color: 'var(--pink)', text: this.t('wd.saved', { n: i + 1 }) });
  }

  loadSlot(i) {
    const o = this.savedOutfits()[i];
    if (!o) return;
    const cur = this.outfit();
    this.tryOn = {};
    for (const [slot, sel] of Object.entries(o)) if (sel && (cur[slot]?.id !== sel.id || cur[slot]?.color !== sel.color)) this.tryOn[slot] = sel;
    this.updatePreview();
    if (!this.basket().length) this.wear(); else { this.renderBar(); this.renderBody(); }
  }

  async suggest() {
    const api = this.nickApi();
    if (!api || this.pending.has('suggest')) return;
    this.pending.add('suggest');
    this.renderBody();
    let res;
    try { res = await api.changeNick({ mode: 'suggest' }); } catch (err) { res = { ok: false, reason: String(err?.message || err) }; }
    this.pending.delete('suggest');
    const list = res?.suggestions || (Array.isArray(res) ? res : null);
    if (list?.length) { this.nick.suggestions = list.slice(0, 3); this.nick.pick = null; } else this.fail(this.t('wd.nickRandom'), res?.reason);
    this.renderBody();
  }

  async checkNick() {
    const api = this.nickApi();
    const v = this.nick.value.trim();
    if (!api || this.pending.has('check')) return;
    this.pending.add('check');
    this.renderBody();
    let res;
    try { res = await api.changeNick({ mode: 'check', value: v }); } catch (err) { res = { ok: false, reason: String(err?.message || err) }; }
    this.pending.delete('check');
    this.nick.checked = { value: v, ok: !!(res?.ok && res.available !== false), reason: res?.reason && this.i18n.has(`wd.reason.${res.reason}`) ? this.t(`wd.reason.${res.reason}`) : res?.reason };
    this.renderBody();
    this.refocus('[data-act="buyCustom"]:not(.disabled)');
  }

  async buyNick(mode, value) {
    const api = this.nickApi();
    if (!api || !value || this.pending.has(mode)) return;
    const price = this.nickPrice(mode);
    const ok = await this.menu.confirm({ title: this.t('wd.nickTitle', { nick: value }), text: this.t('wd.buyText', { price: this.i18n.money(price) }), ok: this.t('svc.buy', { price: this.i18n.money(price) }) });
    if (!ok) return;
    this.pending.add(mode);
    this.renderBody();
    let res;
    try { res = await api.changeNick({ mode, value }); } catch (err) { res = { ok: false, reason: String(err?.message || err) }; }
    this.pending.delete(mode);
    if (res?.ok) {
      this.ui.hud.moneyPop(-price);
      this.nick = { suggestions: null, pick: null, value: '', checked: null };
      this.menu.status({ icon: 'idcard', color: 'var(--money)', text: this.t('wd.nickChanged', { nick: res.nick || value }) });
      this.game.events.emit('ui:purchase', { nick: true, price });
    } else this.fail(this.t(mode === 'custom' ? 'wd.nickCustom' : 'wd.nickRandom'), res?.reason);
    this.renderBody();
  }

  // ---- menu hooks ----
  activate(el) {
    if (el.classList.contains('wcard')) { this.tryItem(el.dataset.id); return true; }
    return false;
  }

  key(inp, dt) {
    // right stick / [ ] keys rotate the preview
    const r = inp.axis(2, 0.25) + (inp.held('BracketRight') ? 1 : 0) - (inp.held('BracketLeft') ? 1 : 0);
    if (r) { this.angle += r * dt * 2.4; this.preview?.rotate?.(this.angle); }
  }

  defaultFocus() { return this.el.querySelector('.wcard.picked') || this.el.querySelector('.wcard') || this.el.querySelector(`.wdcat[data-cat="${this.cat}"]`); }
  hints() { return [['Enter', 'menu.hint.select'], [['Q', 'E'], 'menu.hint.tabs']]; }
}
