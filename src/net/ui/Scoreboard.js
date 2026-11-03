// Hold-to-show scoreboard (Tab, gamepad R3 = right stick click, or a tap on the online pill on touch). The game keeps running; only
// the panel blurs what is behind it. Three views, switched with Q / E (LB / RB) while held or by tapping:
//   NEARBY  the 16 closest players from our own interest data: vehicle, distance, a live direction arrow, net worth
//   TOP     the top 10 by net worth (medals), your row pinned below when you are outside it, rank changes while open
//   ONLINE  everyone else, paged from the server 30 at a time (most recent joins first, or grouped by area)
// Selecting a row sets a GPS route to that player. DOM: updated ≤ 4 times a second while visible, never while hidden;
// rows are reused (text/attributes only change when values do). Names are always set with textContent.
import { PLAYER_COLORS, VCLASS } from '../shared/constants.js';

const VIEWS = ['near', 'top', 'online'];
const ROWS = 16;
const REFRESH = 0.25; // s
const CSS = `
.ldn-sb{position:fixed;left:50%;top:50%;z-index:38;width:min(760px,94vw);max-height:min(72vh,640px);display:flex;flex-direction:column;
  transform:translate(-50%,-46%) scale(.97);opacity:0;pointer-events:none;transition:opacity .16s ease-out,transform .2s cubic-bezier(.2,.9,.3,1.2);
  color:#fff;font:400 15px var(--f-ui,'Oswald',sans-serif);border-radius:10px;overflow:hidden;
  background:linear-gradient(180deg,rgba(14,14,22,.78),rgba(8,8,12,.86));-webkit-backdrop-filter:blur(10px) saturate(1.2);backdrop-filter:blur(10px) saturate(1.2);
  box-shadow:0 18px 60px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.06)}
.ldn-sb.show{opacity:1;transform:translate(-50%,-50%);pointer-events:auto}
.ldn-sb header{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;padding:14px 18px 10px;
  background:linear-gradient(90deg,rgba(255,63,164,.22),rgba(41,240,224,.12) 70%,transparent)}
.ldn-sb .srv{display:flex;align-items:baseline;gap:8px;white-space:nowrap}
.ldn-sb .srv .cnt{font:var(--fw-disp,400) 30px var(--f-disp,'Russo One',sans-serif);letter-spacing:.02em;font-variant-numeric:tabular-nums}
.ldn-sb .srv .lbl{opacity:.7;text-transform:uppercase;letter-spacing:.08em;font-size:12px}
.ldn-sb .srv .host{opacity:.45;font-size:12px}
.ldn-sb .pulse{width:10px;height:10px;border-radius:50%;background:#55e07a;align-self:center;animation:ldn-pulse 2s infinite}
.ldn-sb .me{display:flex;align-items:center;gap:10px;white-space:nowrap;min-width:0}
.ldn-sb .me .nick{font:500 17px var(--f-ui,'Oswald',sans-serif);overflow:hidden;text-overflow:ellipsis;max-width:220px}
.ldn-sb .me .rk{font:var(--fw-disp,400) 15px var(--f-num,'Russo One',sans-serif);color:var(--gold,#f5c84c);font-variant-numeric:tabular-nums}
.ldn-sb .me .pg{opacity:.6;font-size:13px}
.ldn-sb .dot{width:10px;height:10px;border-radius:50%;flex:none;box-shadow:0 0 6px currentColor}
.ldn-sb nav{display:flex;align-items:center;gap:4px;padding:0 14px;border-bottom:1px solid rgba(255,255,255,.08)}
.ldn-sb nav button{all:unset;cursor:pointer;padding:9px 14px 8px;font:500 14px var(--f-ui,'Oswald',sans-serif);letter-spacing:.08em;text-transform:uppercase;
  opacity:.55;border-bottom:2px solid transparent;transition:opacity .15s,border-color .15s}
.ldn-sb nav button.on{opacity:1;border-color:var(--pink,#ff3fa4)}
.ldn-sb nav .keys{margin-left:auto;opacity:.4;font-size:12px;letter-spacing:.1em}
.ldn-sb nav .sort{all:unset;cursor:pointer;margin-left:8px;font-size:12px;opacity:.6;padding:3px 8px;border-radius:10px;background:rgba(255,255,255,.08)}
.ldn-sb .list{overflow-y:auto;padding:6px 8px 4px;scrollbar-width:thin}
.ldn-sb .row{display:grid;grid-template-columns:30px 14px minmax(0,1.4fr) minmax(0,1fr) 92px 104px;align-items:center;gap:8px;
  padding:6px 10px;border-radius:6px;cursor:pointer;animation:ldn-row-in .28s both ease-out}
.ldn-sb .row:hover,.ldn-sb .row.focus{background:rgba(255,255,255,.08)}
.ldn-sb .row.me{background:linear-gradient(90deg,rgba(255,63,164,.32),rgba(255,63,164,.08))}
.ldn-sb .row .i{opacity:.55;text-align:right;font-variant-numeric:tabular-nums}
.ldn-sb .row .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.ldn-sb .row .v{display:flex;align-items:center;gap:6px;opacity:.75;font-size:13px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.ldn-sb .row .v svg{flex:none;width:18px;height:14px}
.ldn-sb .row .d{display:flex;align-items:center;justify-content:flex-end;gap:6px;font-variant-numeric:tabular-nums;font-size:14px}
.ldn-sb .row .d .ar{width:14px;height:14px;transition:transform .25s linear}
.ldn-sb .row .w{text-align:right;color:var(--money,#72d45b);font:400 14px var(--f-num,'Russo One',sans-serif);font-variant-numeric:tabular-nums}
.ldn-sb .row .ch{font-size:11px;margin-left:4px}.ldn-sb .row .ch.up{color:#55e07a}.ldn-sb .row .ch.dn{color:#ff5a5a}
.ldn-sb .medal{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;font:400 12px var(--f-num,'Russo One',sans-serif);color:#1a1a1a;justify-self:end}
.ldn-sb .m1{background:linear-gradient(135deg,#fff3a8,#f5c84c 55%,#b8860b)}.ldn-sb .m2{background:linear-gradient(135deg,#ffffff,#c9ced6 55%,#8a9099)}
.ldn-sb .m3{background:linear-gradient(135deg,#ffd9b0,#cd7f32 55%,#8a4f1d)}
.ldn-sb .sep{height:1px;margin:6px 10px;background:rgba(255,255,255,.12)}
.ldn-sb .empty{padding:26px;text-align:center;opacity:.55}
.ldn-sb footer{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 16px 12px;font-size:12px;opacity:.75}
.ldn-sb footer button{all:unset;cursor:pointer;padding:5px 12px;border-radius:5px;background:var(--pink,#ff3fa4);font:500 13px var(--f-ui,'Oswald',sans-serif)}
.ldn-sb .x{all:unset;display:none;cursor:pointer;position:absolute;right:10px;top:8px;font-size:20px;opacity:.6;padding:2px 8px}
@keyframes ldn-row-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
body.is-mobile .ldn-sb{width:96vw;max-height:78vh;font-size:13px}
body.is-mobile .ldn-sb header{padding:10px 12px 8px;flex-wrap:wrap}
body.is-mobile .ldn-sb .srv .cnt{font-size:22px}
body.is-mobile .ldn-sb .row{grid-template-columns:22px 12px minmax(0,1.5fr) 0 70px 84px;gap:6px;padding:7px 6px}
body.is-mobile .ldn-sb .row .v{display:none}
body.is-mobile .ldn-sb nav .keys{display:none}
body.is-mobile .ldn-sb .x{display:block}
body.is-mobile .ldn-own .ldn-chip,body.is-mobile .ldn-bar .ldn-chip{pointer-events:auto;cursor:pointer}
@media (prefers-reduced-motion:reduce){.ldn-sb,.ldn-sb .row{transition:none;animation:none}}
`;

// tiny vehicle-class glyphs (stroke icons, currentColor)
const ICON = {
  [VCLASS.FOOT]: '<svg viewBox="0 0 18 14"><circle cx="9" cy="2.6" r="1.8" fill="currentColor"/><path d="M9 5v4.5M9 9.5l-2.6 3.6M9 9.5l2.6 3.6M5.6 7l3.4-1.4L12.4 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>',
  [VCLASS.CAR]: '<svg viewBox="0 0 18 14"><path d="M2 9.5V7.5l2-3.6h9.6l2.4 3.6v2" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/><circle cx="5" cy="10.5" r="1.7" fill="currentColor"/><circle cx="13" cy="10.5" r="1.7" fill="currentColor"/></svg>',
  [VCLASS.BIKE]: '<svg viewBox="0 0 18 14"><circle cx="4" cy="9.5" r="3" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="14" cy="9.5" r="3" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M4 9.5l4-5h4l2 5M8 4.5h-2" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>',
  [VCLASS.HELI]: '<svg viewBox="0 0 18 14"><path d="M1 2.5h16M9 2.5v2.5" stroke="currentColor" stroke-width="1.5"/><ellipse cx="7.5" cy="8" rx="4.5" ry="3" fill="currentColor"/><path d="M12 8h5" stroke="currentColor" stroke-width="1.5"/></svg>',
  [VCLASS.PLANE]: '<svg viewBox="0 0 18 14"><path d="M1 7h16M9 2l2 5-2 5M3 5l1 2-1 2" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/></svg>',
  [VCLASS.BOAT]: '<svg viewBox="0 0 18 14"><path d="M1.5 8h15l-2.5 4h-10zM5 8V3.5h5L12 8" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/></svg>',
};
const ARROW = '<svg class="ar" viewBox="0 0 14 14"><path d="M7 1l4.5 11L7 9.5 2.5 12z" fill="currentColor"/></svg>';

export class Scoreboard {
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.net = ui.net;
    this.client = ui.client;
    this.t = ui.t;
    this.open = false;
    this.view = 'near';
    this.sort = 'recent';
    this.refreshT = 0;
    this.focus = -1;
    this.rowsEl = [];
    this.data = [];
    this.onlinePages = []; // loaded players (ONLINE view)
    this.onlineNext = 0;
    this.onlineAt = 0;
    this.topAtOpen = new Map();
    this.anim = null;
    this._css();
    this._build();
    this._keys();
  }

  _css() {
    if (document.getElementById('ldn-sb-css')) return;
    const s = document.createElement('style');
    s.id = 'ldn-sb-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  _build() {
    const el = document.createElement('div');
    el.className = 'ldn-sb';
    el.setAttribute('role', 'dialog');
    el.innerHTML = `<button class="x" aria-label="close">×</button>
      <header><div class="srv"><span class="pulse"></span><span class="cnt">0</span><span class="lbl"></span><span class="host"></span></div>
        <div class="me"><span class="dot"></span><span class="nick"></span><span class="rk"></span><span class="pg"></span></div></header>
      <nav>${VIEWS.map((v) => `<button data-view="${v}"></button>`).join('')}<button class="sort"></button><span class="keys"></span></nav>
      <div class="list"></div>
      <footer><span class="hint"></span><button class="more"></button></footer>`;
    document.body.appendChild(el);
    const q = (s) => el.querySelector(s);
    this.el = {
      root: el, cnt: q('.cnt'), lbl: q('.srv .lbl'), host: q('.host'), dot: q('.me .dot'), nick: q('.me .nick'), rk: q('.me .rk'), pg: q('.me .pg'),
      nav: [...el.querySelectorAll('nav button[data-view]')], sort: q('.sort'), keys: q('.keys'), list: q('.list'), hint: q('.hint'), more: q('.more'),
    };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-view]');
      if (b) { this.setView(b.dataset.view); return; }
      if (e.target.closest('.x')) { this.hide(); return; }
      if (e.target.closest('.sort')) { this.sort = this.sort === 'recent' ? 'area' : 'recent'; this._render(true); return; }
      if (e.target.closest('.more')) { this._loadMore(); return; }
      const r = e.target.closest('.row');
      if (r) this._select(+r.dataset.i);
    });
    this._labels();
  }

  _labels() {
    const t = this.t;
    this.el.nav.forEach((b) => { b.textContent = t(b.dataset.view === 'near' ? 'sbNearby' : b.dataset.view === 'top' ? 'sbTop' : 'sbOnline'); });
    this.el.keys.textContent = t('sbSwitch');
    this.el.lbl.textContent = t('players');
    this.el.hint.textContent = t('sbHint');
    this.el.more.textContent = t('sbLoadMore');
  }

  // ---------------- input ----------------
  _keys() {
    const typing = (e) => { const g = e.target; return g && (g.tagName === 'INPUT' || g.tagName === 'TEXTAREA' || g.isContentEditable); };
    this._down = (e) => {
      if (typing(e)) return;
      if (e.code === 'Tab') {
        if (this.game.ui?.isOpen) return; // the pause menu uses Tab itself
        e.preventDefault();
        if (!e.repeat) this.show('key');
        return;
      }
      if (!this.open) return;
      if (e.code === 'KeyQ') this.cycle(-1);
      else if (e.code === 'KeyE') this.cycle(1);
      else if (e.code === 'ArrowDown') { this.move(1); e.preventDefault(); }
      else if (e.code === 'ArrowUp') { this.move(-1); e.preventDefault(); }
      else if (e.code === 'Enter') this._select(this.focus);
    };
    this._up = (e) => { if (e.code === 'Tab' && this.via === 'key') this.hide(); };
    this._blur = () => { if (this.via === 'key' || this.via === 'pad') this.hide(); };
    this._wheel = (e) => { if (this.open && this.via !== 'tap') { this.move(e.deltaY > 0 ? 1 : -1); } };
    window.addEventListener('keydown', this._down);
    window.addEventListener('keyup', this._up);
    window.addEventListener('blur', this._blur);
    window.addEventListener('wheel', this._wheel, { passive: true });
  }

  /**
   * Gamepad: hold R3 (right stick click, 11; Back opens the map) to show, LB/RB (4/5) switch, D-pad (12/13) + A (0)
   * select. Polled per frame (no allocations).
   */
  _pad() {
    const inp = this.game.input;
    if (!inp?.gpHeld) return;
    const held = inp.gpHeld(11);
    if (held && !this.open && !this.game.ui?.isOpen) this.show('pad');
    else if (!held && this.open && this.via === 'pad') this.hide();
    if (!this.open || this.via !== 'pad') { this.padPrev = 0; return; }
    const bits = (inp.gpHeld(4) ? 1 : 0) | (inp.gpHeld(5) ? 2 : 0) | (inp.gpHeld(12) ? 4 : 0) | (inp.gpHeld(13) ? 8 : 0) | (inp.gpHeld(0) ? 16 : 0);
    const edge = bits & ~(this.padPrev || 0);
    this.padPrev = bits;
    if (edge & 1) this.cycle(-1);
    if (edge & 2) this.cycle(1);
    if (edge & 4) this.move(-1);
    if (edge & 8) this.move(1);
    if (edge & 16) this._select(this.focus);
  }

  // ---------------- visibility ----------------
  show(via = 'tap') {
    if (this.client.status !== 'online' && this.client.status !== 'reconnecting') return;
    this.via = via;
    if (this.open) return;
    this.open = true;
    this.focus = -1;
    this.topAtOpen.clear();
    for (const [i, t] of (this.client.global?.top || []).entries()) this.topAtOpen.set(this._key(t), i + 1);
    this.rankAtOpen = this.net.economy.rank?.rank ?? 0;
    this.anim = { t: 0, from: this.shownCount || 0, rankFrom: this.shownRank || 0 };
    this.el.root.classList.add('show');
    if (this.view === 'online' && performance.now() - this.onlineAt > 15000) this._reloadOnline();
    this._render(true);
    this.ui.hintSeen?.();
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.via = null;
    this.el.root.classList.remove('show');
  }

  toggle() { if (this.open) this.hide(); else this.show('tap'); }

  setView(v) {
    if (!VIEWS.includes(v) || v === this.view) return;
    this.view = v;
    this.focus = -1;
    if (v === 'online' && (!this.onlinePages.length || performance.now() - this.onlineAt > 15000)) this._reloadOnline();
    this._render(true);
    this.game.events?.emit('ui:click', {});
  }

  cycle(d) { this.setView(VIEWS[(VIEWS.indexOf(this.view) + d + VIEWS.length) % VIEWS.length]); }

  move(d) {
    const n = this.data.length;
    if (!n) return;
    this.focus = this.focus < 0 ? (d > 0 ? 0 : n - 1) : (this.focus + d + n) % n;
    for (let i = 0; i < this.rowsEl.length; i++) this.rowsEl[i].classList.toggle('focus', i === this.focus);
    this.rowsEl[this.focus]?.scrollIntoView?.({ block: 'nearest' });
  }

  // GPS route to the selected player
  _select(i) {
    const r = this.data[i];
    if (!r || r.me || !Number.isFinite(r.x)) return;
    const w = { x: r.x, z: r.z };
    const g = this.game;
    if (g.ui?.setWaypoint) g.ui.setWaypoint(w); else g.player?.setWaypoint?.(w);
    this.ui._feed(this.t('sbWaypoint', { name: r.name }), 'gps', 3);
    g.events?.emit('ui:click', {});
  }

  // ---------------- data ----------------
  _key(t) { return t.netId > 0 ? `n${t.netId}` : `c${t.nickCode}|${t.name || ''}`; }

  async _reloadOnline() {
    this.onlinePages = [];
    this.onlineNext = 0;
    await this._loadMore(true);
  }

  async _loadMore(first = false) {
    if (this.loading || (!first && !this.onlineNext)) return;
    this.loading = true;
    try {
      const p = await this.net.listOnline(first ? 0 : this.onlineNext);
      const me = this.client.welcome?.netId;
      const seen = new Set(this.onlinePages.map((x) => x.netId));
      for (const x of p.players) if (x.netId !== me && !seen.has(x.netId)) this.onlinePages.push(x);
      this.onlineNext = p.next;
      this.onlineAt = performance.now();
    } finally { this.loading = false; }
    if (this.open && this.view === 'online') this._render(true);
  }

  _near() {
    const f = this.game.player?.focus, out = [];
    if (!f) return out;
    const c = this.client;
    for (const e of this.client.store.list) {
      if (!e.hasCurve || e.state === 'out' || e.alpha < 0.2) continue;
      out.push({ e, d: Math.hypot(e.x - f.x, e.z - f.z) });
    }
    out.sort((a, b) => a.d - b.d);
    return out.slice(0, ROWS).map(({ e, d }) => ({
      key: `n${e.id}`, netId: e.id, name: c.displayName(e) || '…', color: e.hasInfo ? e.color : e.id, vclass: e.vclass, model: e.model,
      x: e.x, z: e.z, dist: d, worth: e.hasInfo ? e.worth : null,
    }));
  }

  _top() {
    const g = this.client.global, me = this.client.welcome?.netId;
    const rows = (g?.top || []).map((t, i) => ({
      key: this._key(t), netId: t.netId, name: this.client.displayName(t), color: t.color, rank: i + 1, worth: t.money, me: t.netId === me && me > 0, online: t.netId > 0,
      was: this.topAtOpen.get(this._key(t)) ?? 0,
    }));
    for (const r of rows) {
      if (!r.online || r.me) continue;
      const e = this.client.store.byId.get(r.netId);
      if (e?.hasCurve) { r.x = e.x; r.z = e.z; }
    }
    const rank = this.net.economy.rank;
    if (!rows.some((r) => r.me) && rank && this.client.welcome) {
      const w = this.client.welcome;
      rows.push({ sep: true });
      rows.push({ key: 'me', name: w.name || this.client.displayName(w), color: w.color, rank: rank.rank, worth: this.net.economy.worth || this.net.economy.money, me: true, was: this.rankAtOpen });
    }
    return rows;
  }

  _online() {
    const rows = this.onlinePages.map((p) => ({
      key: `n${p.netId}`, netId: p.netId, name: this.client.displayName(p), color: p.color, vclass: p.vclass, model: p.model, x: p.x, z: p.z,
      worth: p.worth, onlineS: p.onlineS, area: this.game.world3d?.areaAt?.(p.x, p.z)?.name ?? '',
    }));
    if (this.sort === 'area') rows.sort((a, b) => a.area.localeCompare(b.area) || b.worth - a.worth);
    return rows;
  }

  // ---------------- render ----------------
  _render(force = false) {
    const v = this.view, t = this.t;
    this.el.nav.forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    this.el.sort.style.display = v === 'online' ? '' : 'none';
    this.el.sort.textContent = t(this.sort === 'recent' ? 'sbRecent' : 'sbRegion');
    this.el.more.style.display = v === 'online' && this.onlineNext ? '' : 'none';
    const rows = v === 'near' ? this._near() : v === 'top' ? this._top() : this._online();
    this.data = rows.filter((r) => !r.sep);
    const list = this.el.list;
    if (force) { list.textContent = ''; this.rowsEl = []; }
    if (!this.data.length) {
      if (!list.querySelector('.empty')) { list.textContent = ''; this.rowsEl = []; const d = document.createElement('div'); d.className = 'empty'; list.appendChild(d); }
      list.querySelector('.empty').textContent = t(v === 'online' ? 'sbEmptyOnline' : 'sbEmpty');
      return;
    }
    list.querySelector('.empty')?.remove();
    // rows (and one separator) reused by position
    let ri = 0, child = 0;
    const camYaw = this._camYaw(), f = this.game.player?.focus;
    for (const r of rows) {
      if (r.sep) {
        let s = list.children[child];
        if (!s || !s.classList.contains('sep')) { s = document.createElement('div'); s.className = 'sep'; list.insertBefore(s, list.children[child] || null); }
        child++;
        continue;
      }
      let el = list.children[child];
      if (!el || !el.classList.contains('row')) {
        el = this._rowEl(ri);
        list.insertBefore(el, list.children[child] || null);
      }
      this.rowsEl[ri] = el;
      el.dataset.i = String(ri);
      this._fill(el, r, v, camYaw, f);
      el.classList.toggle('focus', ri === this.focus);
      ri++; child++;
    }
    while (list.children.length > child) list.lastChild.remove();
    this.rowsEl.length = ri;
  }

  _rowEl(i) {
    const el = document.createElement('div');
    el.className = 'row';
    el.style.animationDelay = `${Math.min(i, 15) * 22}ms`; // staggered slide-in
    el.innerHTML = '<span class="i"></span><span class="dot"></span><span class="n"></span><span class="v"></span><span class="d"></span><span class="w"></span>';
    el._c = { i: el.children[0], dot: el.children[1], n: el.children[2], v: el.children[3], d: el.children[4], w: el.children[5] };
    return el;
  }

  _fill(el, r, view, camYaw, f) {
    const c = el._c, t = this.t, set = (node, k, val) => { if (node[k] !== val) node[k] = val; };
    el.classList.toggle('me', !!r.me);
    // index / medal
    if (view === 'top' && r.rank <= 3 && !r.me) {
      if (c.i.dataset.m !== String(r.rank)) { c.i.dataset.m = String(r.rank); c.i.innerHTML = `<span class="medal m${r.rank}">${r.rank}</span>`; }
    } else {
      if (c.i.dataset.m) { delete c.i.dataset.m; c.i.textContent = ''; }
      set(c.i, 'textContent', view === 'top' ? `${r.rank}` : `${this.data.indexOf(r) + 1}`);
    }
    const col = PLAYER_COLORS[(r.color ?? 0) % PLAYER_COLORS.length];
    if (c.dot.style.background !== col) { c.dot.style.background = col; c.dot.style.color = col; }
    set(c.n, 'textContent', r.me ? `${r.name} (${t('you')})` : r.name);
    // vehicle / area column
    let vk;
    if (view === 'top') vk = r.online ? `o${r.netId}` : '';
    else vk = `${r.vclass}|${r.model}|${view === 'online' ? r.area : ''}`;
    if (c.v.dataset.k !== vk) {
      c.v.dataset.k = vk;
      if (view === 'top') c.v.textContent = '';
      else {
        const label = view === 'online' ? r.area : r.vclass === VCLASS.FOOT ? t('sbOnFoot') : this._modelName(r.model);
        c.v.innerHTML = ICON[r.vclass] || ICON[VCLASS.CAR];
        const s = document.createElement('span');
        s.textContent = label;
        c.v.appendChild(s);
      }
    }
    // distance + direction arrow (relative to the camera) / time online / rank change
    if (view === 'near' || (view === 'online' && f)) {
      const d = view === 'near' ? r.dist : Math.hypot(r.x - f.x, r.z - f.z);
      const txt = d < 1000 ? t('sbMeters', { m: Math.round(d) }) : t('sbKm', { km: (d / 1000).toFixed(d < 10000 ? 1 : 0) });
      if (!c.d.firstChild || c.d.dataset.k !== 'dist') { c.d.dataset.k = 'dist'; c.d.innerHTML = `<span></span>${ARROW}`; }
      set(c.d.firstChild, 'textContent', txt);
      if (f && camYaw !== null) {
        const bearing = Math.atan2(r.x - f.x, r.z - f.z); // world bearing to the player
        const rel = Math.round(((Math.PI - bearing + camYaw) * 180) / Math.PI);
        const tr = `rotate(${rel}deg)`;
        const ar = c.d.lastChild;
        if (ar.style.transform !== tr) ar.style.transform = tr;
      }
    } else if (view === 'top') {
      if (c.d.dataset.k !== 'ch') { c.d.dataset.k = 'ch'; c.d.textContent = ''; }
      const up = r.was && r.rank < r.was, dn = r.was && r.rank > r.was;
      const txt = up ? `▲${r.was - r.rank}` : dn ? `▼${r.rank - r.was}` : '';
      if (c.d.textContent !== txt) { c.d.textContent = txt; c.d.className = `d ch ${up ? 'up' : dn ? 'dn' : ''}`; }
    }
    set(c.w, 'textContent', r.worth == null ? '—' : this.ui._money(r.worth));
  }

  _modelName(model) {
    const id = this.client.models[model]?.id;
    if (!id) return '';
    const v = this.game.vehicles?.byId?.get?.(id) || this.game.vehicles?.catalog?.get?.(id);
    return v?.name || v?.model || id;
  }

  // camera heading (three.js yaw sense) for the direction arrows
  _camYaw() {
    const cam = this.game.camera;
    if (!cam) return null;
    const e = cam.matrixWorld.elements; // forward = -Z column
    return Math.atan2(-e[8], -e[10]) + Math.PI;
  }

  _header(dt) {
    const c = this.client, w = c.welcome || c.lastWelcome, ui = this.ui;
    const online = c.global?.online ?? 1, rank = this.net.economy.rank;
    // numbers count up when the board opens
    if (this.anim) {
      this.anim.t = Math.min(1, this.anim.t + dt / 0.6);
      const k = 1 - (1 - this.anim.t) ** 3;
      this.shownCount = Math.round(this.anim.from + (online - this.anim.from) * k);
      this.shownRank = rank ? Math.round((this.anim.rankFrom || rank.rank * 2) + (rank.rank - (this.anim.rankFrom || rank.rank * 2)) * k) : 0;
      if (this.anim.t >= 1) this.anim = null;
    } else { this.shownCount = online; this.shownRank = rank?.rank ?? 0; }
    const set = (node, val) => { if (node.textContent !== val) node.textContent = val; };
    set(this.el.cnt, ui._num(this.shownCount));
    set(this.el.host, this._host());
    if (w) {
      const col = PLAYER_COLORS[w.color % PLAYER_COLORS.length];
      if (this.el.dot.style.background !== col) { this.el.dot.style.background = col; this.el.dot.style.color = col; }
      set(this.el.nick, w.name || c.displayName(w));
    }
    set(this.el.rk, rank ? this.t('sbRankOf', { rank: ui._num(this.shownRank || rank.rank), total: ui._num(rank.total) }) : '');
    set(this.el.pg, c.clock.rtt ? this.t('ping', { ms: Math.round(c.clock.rtt) }) : '');
  }

  _host() {
    try {
      const h = new URL(this.client.url).hostname;
      return h === '127.0.0.1' || h === 'localhost' ? this.t('sbServerLocal') : h;
    } catch { return ''; }
  }

  /** Per frame (cheap when hidden: only the gamepad poll). */
  update(dt) {
    this._pad();
    if (!this.open) return;
    if (this.client.status !== 'online' && this.client.status !== 'reconnecting') { this.hide(); return; }
    this.ui.wantBoard(); // top 10 + rank: requested while shown (the server no longer broadcasts the board)
    if (this.anim) this._header(dt); // the 0.6 s count-up runs per frame; afterwards everything is 4 Hz
    this.refreshT -= dt;
    if (this.refreshT <= 0) { this.refreshT = REFRESH; if (!this.anim) this._header(REFRESH); this._render(false); }
  }

  dispose() {
    window.removeEventListener('keydown', this._down);
    window.removeEventListener('keyup', this._up);
    window.removeEventListener('blur', this._blur);
    window.removeEventListener('wheel', this._wheel);
    this.el.root.remove();
  }
}
