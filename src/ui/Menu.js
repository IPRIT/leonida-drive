import { GP } from '../core/input.js';
import { esc, setText } from './Hud.js';
import { keycap } from './widgets.js';
import { icon } from './icons.js';
import { Tab } from './tabs/Tab.js';
import { MapTab } from './tabs/MapTab.js';
import { VehiclesTab } from './tabs/VehiclesTab.js';
import { ServiceTab } from './tabs/ServiceTab.js';
import { WardrobeTab } from './tabs/WardrobeTab.js';
import { WorldTab } from './tabs/WorldTab.js';
import { PlayerTab } from './tabs/PlayerTab.js';
import { SettingsTab } from './tabs/SettingsTab.js';
import { ControlsTab } from './tabs/ControlsTab.js';
import { StatsTab } from './tabs/StatsTab.js';
import { AboutTab } from './tabs/AboutTab.js';

// Applies pending class / inline-style changes of the content-visibility locks (style only, no layout) before anything
// measures inside: a layout read under an ancestor whose lock was just lifted but not yet restyled still counts as
// rendering a hidden subtree (Chrome forces it and logs "Rendering was performed in a subtree hidden by
// content-visibility"). `el` itself must not sit under a still-locked ancestor.
const restyle = (el) => { void getComputedStyle(el).contentVisibility; };

const PAD_NAMES = { Enter: 'A', Backspace: 'B', Esc: 'B', Q: 'LB', E: 'RB', F: 'Y', Space: 'Y', Tab: 'R3', Delete: 'X', '+': 'RT', '−': 'LT', Arrows: 'DPAD', '←': '◀', '→': '▶' };

// Tab provided by another module through menu.addTab({ id, icon, labelKey, create }).
class ExternalTab extends Tab {
  constructor(menu, spec) {
    super(menu, spec.id);
    this.spec = spec;
    this.icon = spec.icon;
    this.inst = null;
    this.dirty = false;
  }

  label() { return this.t(this.spec.labelKey || `menu.tab.${this.id}`, { default: this.spec.label || this.id }); }
  available() { return this.spec.available ? !!this.spec.available(this.game) : true; }
  ensure() {}

  show() {
    if (!this.inst) {
      try { this.inst = this.spec.create(this.el, this.menu.ui, this.game) || {}; } catch (e) { console.error(`[ui] tab ${this.id} create failed`, e); this.inst = {}; }
    }
    this.inst.show?.();
  }

  hide() { this.inst?.hide?.(); }
  update(dt) { this.inst?.update?.(dt); }
  hints() { return this.inst?.hints?.() || [[['Q', 'E'], 'menu.hint.tabs']]; }
  destroy() { this.inst?.destroy?.(); this.inst = null; this.el.remove(); }
}

// GTA-style pause menu / control panel. Navigation: arrows or D-pad/left stick, Enter/A select,
// Backspace/B back, Esc closes, Q/E or LB/RB switch tabs. Mouse works everywhere.
export class Menu {
  constructor(root, ui, game, mapImage) {
    this.ui = ui;
    this.game = game;
    this.i18n = game.i18n;
    this.mapImage = mapImage;
    this.open = false;
    this.device = 'kb';
    this.modal = null;
    // Mounted on <body> (not inside the game container, which is position:fixed and forms its own stacking
    // context) so the pause menu sits above every overlay other modules append to <body>.
    const host = document.body;
    document.querySelectorAll('body > #menu').forEach((e) => e.remove()); // stale menu of a previous createUI
    const tmp = document.createElement('div');
    tmp.innerHTML = `
      <div id="menu" class="closed">
        <header>
          <div class="hleft"><div class="logo mlogo"><div class="l1">LEONIDA</div><div class="l2">drive</div></div><span class="modebadge"></span></div>
          <div class="hinfo">
            <div class="hrow"><span id="m-clock"></span><span id="m-money"></span></div>
            <div id="m-area"></div>
            <div class="msub"></div>
          </div>
        </header>
        <nav><span class="tabkey prev"></span><div class="tabs"></div><span class="tabkey next"></span></nav>
        <div class="panel"></div>
        <div class="bottom"><div class="mstatus"></div><div class="footer"></div></div>
      </div>`;
    this.el = tmp.firstElementChild;
    host.appendChild(this.el);
    this.panelEl = this.el.querySelector('.panel');
    this.tabsEl = this.el.querySelector('nav .tabs');
    this.footerEl = this.el.querySelector('.footer');
    this.tabs = [MapTab, VehiclesTab, ServiceTab, WardrobeTab, WorldTab, PlayerTab, SettingsTab, ControlsTab, StatsTab, AboutTab].map((C) => new C(this));
    this.byId = new Map(this.tabs.map((t) => [t.id, t]));
    this.tab = this.tabs[0];
    this.focus = null;
    this._hoverT = 0;
    this.tabsEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) this.select(b.dataset.tab);
    });
    this.el.querySelector('.tabkey.prev').addEventListener('click', () => this.cycle(-1));
    this.el.querySelector('.tabkey.next').addEventListener('click', () => this.cycle(1));
    this.footerEl.addEventListener('click', (e) => {
      const h = e.target.closest('[data-hint]');
      if (h) this.hintAction(h.dataset.hint);
    });
    // mouse focus + click sounds
    this.el.addEventListener('mouseover', (e) => {
      const n = e.target.closest('[data-nav]');
      if (n && n !== this.focus && this.scope().contains(n)) this.setFocus(n, { scroll: false });
    });
    this.el.addEventListener('click', (e) => {
      if (e.target.closest('[data-nav],button,[data-tab],[data-hint],.tabkey')) this.emit('ui:click');
    });
    this.el.addEventListener('mousemove', () => this.setDevice('kb'));
    window.addEventListener('keydown', (e) => {
      if (!this.open) return;
      if (e.code === 'Tab' || ((e.code === 'Space' || e.code.startsWith('Arrow')) && !isTyping(e))) e.preventDefault();
      // buttons keep native focus after a mouse click: stop the browser from clicking them a second time
      if ((e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') && e.target?.tagName === 'BUTTON') e.preventDefault();
    });
    this.el.addEventListener('pointerup', (e) => {
      if (e.target.matches?.('input[type=range]')) setTimeout(() => e.target.blur(), 0);
    });
    this.render();
    this.i18n.onChange(() => this.render());
    // tabs that render settings (built ahead of time in idle) are rebuilt when a setting changes elsewhere
    this.game.events.on?.('setting', () => {
      let any = false;
      for (const t of this.tabs) if (t.rebuildOnSetting && !(this.open && t === this.tab) && !t.dirty) { t.dirty = true; any = true; }
      if (any && !this.open) this.scheduleIdle();
    });
  }

  t(k, p) { return this.i18n.t(k, p); }
  emit(name, p = {}) { this.game.events.emit(name, p); }
  can(cap) { return this.game.can ? this.game.can(cap) : true; }
  get online() { return !!this.game.online; }

  visibleTabs() { return this.tabs.filter((t) => t.available?.() !== false); }

  render() {
    this.el.querySelector('.msub').textContent = this.t('menu.subtitle');
    const mb = this.el.querySelector('.modebadge');
    mb.className = `modebadge ${this.online ? 'online' : 'single'}`;
    mb.innerHTML = `<i></i>${esc(this.t(this.online ? 'gm.badge.online' : 'gm.badge.single'))}`;
    this.renderTabBar();
    for (const t of this.tabs) t.dirty = !(t instanceof ExternalTab);
    if (this.open) this.tab.ensure();
    this.renderChrome();
    this.scheduleIdle();
  }

  // tab buttons only (addTab / removeTab): the built tabs stay as they are
  renderTabBar() {
    this.tabsEl.innerHTML = this.visibleTabs().map((t) => `<button data-tab="${t.id}" class="${t === this.tab ? 'active' : ''}" tabindex="-1">${t.icon ? icon(t.icon) : ''}<span>${esc(t.label())}</span></button>`).join('');
    this._activeBtn = this.tabsEl.querySelector('.active');
  }

  // Builds the tabs' DOM in idle time while the menu is closed (one tab per idle slice), then lays each built tab
  // out once (also one per slice). The closed menu and inactive tabs use content-visibility: hidden, which keeps
  // that layout, so the first open and the first visit of every tab only pay for showing, not building / layout.
  scheduleIdle() {
    // only after the game's 'start' event: modules (economy, wardrobe, net…) are attached by then
    if (!this.started || this._idleId || typeof window === 'undefined') return;
    const ric = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8, didTimeout: false }), 200));
    const usable = (t) => !(t instanceof ExternalTab) && t.available?.() !== false;
    const step = (dl) => {
      this._idleId = 0;
      if (this.open) return; // resumes after close
      const next = this.tabs.find((t) => (t.dirty || t.prebuildPending?.()) && usable(t));
      const warm = next ? null : this.tabs.find((t) => usable(t) && !t._laidOut);
      if (!next && !warm) return;
      if (dl.timeRemaining() < 6 && !dl.didTimeout) { this._idleId = ric(step, { timeout: 3000 }); return; }
      try {
        if (next) {
          next._laidOut = false;
          if (next.prebuild) next.prebuild(dl);
          else next.ensure();
        } else {
          // forced layout of the hidden tab (fonts of every script on the Settings page load here, not on click).
          // The content-visibility lock is lifted for that one synchronous layout (both elements stay
          // visibility: hidden, nothing renders before it is back): content-visibility: hidden keeps the layout
          // all the same, and Chrome does not log "Rendering was performed in a subtree hidden by
          // content-visibility" for every warmed tab.
          warm._laidOut = true;
          const s1 = this.el.style, s2 = warm.el.style;
          s1.contentVisibility = s2.contentVisibility = 'visible';
          try { restyle(this.el); warm.el.firstElementChild?.getBoundingClientRect(); } finally { s1.contentVisibility = s2.contentVisibility = ''; }
        }
      } catch (e) { console.error(`[ui] prebuild ${(next || warm).id}`, e); if (next) next.dirty = false; }
      this._idleId = ric(step, { timeout: 3000 });
    };
    this._idleId = ric(step, { timeout: 3000 });
  }

  firstFocusable() {
    for (const e of this.scope().querySelectorAll('[data-nav]')) if (e.offsetParent !== null && !e.classList.contains('disabled')) return e;
    return null;
  }

  // Extension point (multiplayer etc.): addTab({ id, icon, labelKey, create(container, ui, game) → { show, hide, update, destroy } }).
  // Optional: before/after (tab id), available(game) → bool. Focusable elements inside need `data-nav`.
  addTab(spec) {
    if (!spec?.id || typeof spec.create !== 'function') throw new Error('[ui] addTab needs { id, create }');
    if (this.byId.has(spec.id)) this.removeTab(spec.id);
    const tab = new ExternalTab(this, spec);
    const ref = this.tabs.findIndex((t) => t.id === (spec.after || spec.before || 'settings'));
    const i = ref < 0 ? this.tabs.length : ref + (spec.after ? 1 : 0);
    this.tabs.splice(i, 0, tab);
    this.byId.set(tab.id, tab);
    this.renderTabBar();
    this.renderChrome();
    return tab;
  }

  removeTab(id) {
    const tab = this.byId.get(id);
    if (!tab || !(tab instanceof ExternalTab)) return;
    if (this.tab === tab) this.select(this.tabs[0].id);
    tab.destroy();
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    this.byId.delete(id);
    this.renderTabBar();
    this.renderChrome();
  }

  // tab-switch keys and footer hints (device dependent). Only touches the DOM when the markup changes
  // (it runs on every tab switch / dialog; rewriting identical HTML still costs a parse + style + layout).
  renderChrome() {
    const pad = this.device === 'pad';
    if (this._padKeys !== pad) {
      this._padKeys = pad;
      this.el.querySelector('.tabkey.prev').innerHTML = `<span class="key">${pad ? 'LB' : 'Q'}</span>`;
      this.el.querySelector('.tabkey.next').innerHTML = `<span class="key">${pad ? 'RB' : 'E'}</span>`;
    }
    const hints = this.modal ? [] : [...(this.tab.hints?.() || [])];
    hints.push(['Enter', 'menu.hint.select'], ['Backspace', 'menu.hint.back']);
    const seen = new Set();
    const html = hints.filter(([, l]) => !seen.has(l) && seen.add(l)).map(([k, label]) => {
      const keys = (Array.isArray(k) ? k : [k]).map((x) => (pad ? PAD_NAMES[x] || x : x === 'Backspace' ? 'Esc' : x));
      return `<span class="hint" data-hint="${label}">${keys.map((x) => keycap(keyName(x, this), pad)).join('')}<span>${esc(this.t(label))}</span></span>`;
    }).join('');
    if (html !== this._footHtml) { this._footHtml = html; this.footerEl.innerHTML = html; }
  }

  // short confirmation line (feed cards are hidden while the menu is open)
  status(msg) {
    const o = typeof msg === 'string' ? { text: msg } : (msg || {});
    const el = this.el.querySelector('.mstatus');
    el.innerHTML = `${o.icon ? icon(o.icon) : ''}<span>${esc(o.text || '')}</span>`;
    el.style.setProperty('--c', o.color || 'var(--pink)');
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    this._statusT = 3;
  }

  // GTA-style confirmation dialog inside the menu → Promise<boolean>
  confirm({ title, text, ok, cancel }) {
    this.closeModal(false);
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'mmodal';
      el.innerHTML = `<div class="box"><h3>${esc(title || '')}</h3><p>${esc(text || '')}</p>
        <div class="btnrow"><button class="mbtn primary" data-nav data-act="ok" tabindex="-1">${esc(ok || 'OK')}</button>
        <button class="mbtn" data-nav data-act="cancel" tabindex="-1">${esc(cancel || this.t('common.cancel'))}</button></div></div>`;
      el.addEventListener('click', (e) => {
        const a = e.target.closest('[data-act]')?.dataset.act;
        if (a) this.closeModal(a === 'ok');
        else if (e.target === el) this.closeModal(false);
      });
      this.el.appendChild(el);
      this.modal = { el, resolve };
      this.focus?.classList.remove('focus');
      this.focus = null;
      this.setFocus(el.querySelector('[data-act="cancel"]'), { silent: true });
      this.renderChrome();
    });
  }

  closeModal(result) {
    const m = this.modal;
    if (!m) return;
    this.modal = null;
    m.el.remove();
    this.focus = null;
    const first = this.tab.defaultFocus?.() || this.firstFocusable();
    if (first) this.setFocus(first, { silent: true });
    this.renderChrome();
    m.resolve(result);
  }

  hintAction(label) {
    if (label === 'menu.hint.back') this.back();
    else if (label === 'menu.hint.select') this.activate();
    else this.tab.hint?.(label);
  }

  setDevice(d) {
    if (d === this.device) return;
    this.device = d;
    this.el.classList.toggle('pad', d === 'pad');
    this.renderChrome();
  }

  show(tabId) {
    this.open = true;
    this.el.classList.remove('closed');
    restyle(this.el);
    const t = this.byId.get(tabId || this.tab.id);
    this.select(t && t.available?.() !== false ? t.id : this.tabs[0].id, true);
    this.updateHeader();
  }

  hide() {
    if (!this.open) return;
    this.closeModal(false);
    this.el.querySelector('.mstatus').classList.remove('show');
    this.open = false;
    this.tab.hide?.();
    for (const t of this.tabs) { try { t.onMenuClose?.(); } catch (e) { console.error(`[ui] tab ${t.id} close`, e); } }
    this.el.classList.add('closed');
    if (document.activeElement && this.el.contains(document.activeElement)) document.activeElement.blur();
    this.scheduleIdle();
  }

  // All DOM writes first (tab classes, build/show, chrome), then the reads (focus scroll), so a switch costs a
  // single style + layout pass instead of one per step.
  select(id, force = false) {
    const next = this.byId.get(id) || this.tabs[0];
    if (next === this.tab && !force && this.open) return;
    this.closeModal(false);
    const prev = this.tab;
    if (next !== prev) prev.hide?.();
    this.tab = next;
    if (this._activeBtn?.dataset.tab !== next.id || !this._activeBtn.isConnected) {
      this._activeBtn?.classList.remove('active');
      this._activeBtn = this.tabsEl.querySelector(`[data-tab="${next.id}"]`);
      this._activeBtn?.classList.add('active');
    }
    if (prev !== next) prev.el.classList.remove('active');
    next.el.classList.add('active');
    if (this.open) restyle(next.el);
    next.ensure();
    next.show?.();
    this.focus?.classList.remove('focus');
    this.focus = null;
    this.renderChrome();
    const first = next.defaultFocus?.() || this.firstFocusable();
    // touch screens (no focus navigation in use): the tab opens at its top instead of scrolled to the default focus
    const touch = this.device !== 'pad' && document.body.classList.contains('is-mobile');
    if (first) this.setFocus(first, { scroll: true, reveal: !touch, silent: true });
    const bar = this.tabsEl;
    if (this._activeBtn && bar.scrollWidth > bar.clientWidth) this._activeBtn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (!force) this.emit('ui:click');
  }

  cycle(d) {
    const tabs = this.visibleTabs();
    const i = Math.max(0, tabs.indexOf(this.tab));
    this.select(tabs[(i + d + tabs.length) % tabs.length].id);
  }

  scope() { return this.modal ? this.modal.el : this.tab.el; }

  focusables() {
    return [...this.scope().querySelectorAll('[data-nav]')].filter((e) => e.offsetParent !== null && !e.classList.contains('disabled'));
  }

  setFocus(el, { scroll = true, silent = false, reveal = scroll } = {}) {
    if (this.focus === el) return;
    this.focus?.classList.remove('focus');
    this.focus = el;
    if (!el) return;
    el.classList.add('focus');
    if (reveal) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (!this.modal) this.tab.onFocus?.(el, { mouse: !scroll });
    const now = performance.now();
    if (!silent && now - this._hoverT > 45) { this._hoverT = now; this.emit('ui:hover'); }
  }

  // spatial navigation inside the active tab (or the dialog)
  move(dir) {
    const items = this.focusables();
    if (!items.length) return;
    const cur = this.focus && items.includes(this.focus) ? this.focus : null;
    if (!cur) { this.setFocus(items[0]); return; }
    const a = cur.getBoundingClientRect();
    let best = null, bs = Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      let main, cross;
      if (dir === 'down' || dir === 'up') {
        main = dir === 'down' ? b.top - a.bottom : a.top - b.bottom;
        if (main < -Math.min(a.height, b.height) * 0.5) continue;
        cross = Math.max(0, b.left - a.right, a.left - b.right);
      } else {
        main = dir === 'right' ? b.left - a.right : a.left - b.right;
        if (main < -Math.min(a.width, b.width) * 0.5) continue;
        cross = Math.max(0, b.top - a.bottom, a.top - b.bottom);
      }
      const center = dir === 'down' || dir === 'up'
        ? Math.abs((b.left + b.right) / 2 - (a.left + a.right) / 2)
        : Math.abs((b.top + b.bottom) / 2 - (a.top + a.bottom) / 2);
      const score = Math.max(0, main) + cross * 3 + center * 0.05;
      if (score < bs) { bs = score; best = el; }
    }
    if (best) this.setFocus(best);
  }

  // left/right on sliders and choices
  adjust(el, d) {
    const type = el?.dataset.type;
    if (type === 'slider') {
      const inp = el.querySelector('input');
      const step = +inp.step || 1;
      const v = Math.min(+inp.max, Math.max(+inp.min, +inp.value + d * step));
      if (v === +inp.value) return true;
      inp.value = v;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      this.emit('ui:hover');
      return true;
    }
    if (type === 'choice') {
      el.dispatchEvent(new CustomEvent('nav-adjust', { detail: d, bubbles: true }));
      this.emit('ui:click');
      return true;
    }
    return false;
  }

  activate() {
    const el = this.focus;
    if (!el) return;
    if (!this.modal && this.tab.activate?.(el)) { this.emit('ui:click'); return; }
    const text = el.matches('input[type=search],input[type=text]') ? el : el.querySelector('input[type=search],input[type=text]');
    if (text) { text.focus(); return; }
    const color = el.querySelector('input[type=color]');
    if (color) { color.click(); return; }
    el.click();
  }

  back() {
    if (this.modal) { this.closeModal(false); this.emit('ui:click'); return; }
    if (this.tab.back?.()) { this.emit('ui:click'); return; }
    this.ui.close();
  }

  // twice a second while open: writes only what changed (an unchanged textContent write still dirties layout)
  updateHeader() {
    const g = this.game;
    const h = (this._hdr ||= { clock: this.el.querySelector('#m-clock'), money: this.el.querySelector('#m-money'), area: this.el.querySelector('#m-area') });
    setText(h.clock, g.sky?.clock ?? '');
    setText(h.money, this.i18n.money(g.economy?.money ?? g.player?.money ?? 0));
    setText(h.area, (this.ui.hud.currentArea || '').toUpperCase());
  }

  readDir(dt) {
    const inp = this.game.input;
    const ax = inp.axis(0, 0.2), ay = inp.axis(1, 0.2);
    let d = null;
    if (inp.held('ArrowUp') || inp.gpHeld(GP.UP) || ay < -0.55) d = 'up';
    else if (inp.held('ArrowDown') || inp.gpHeld(GP.DOWN) || ay > 0.55) d = 'down';
    else if (inp.held('ArrowLeft') || inp.gpHeld(GP.LEFT) || ax < -0.55) d = 'left';
    else if (inp.held('ArrowRight') || inp.gpHeld(GP.RIGHT) || ax > 0.55) d = 'right';
    if (!d) { this._dir = null; return null; }
    if (d !== this._dir) { this._dir = d; this._rep = 0.38; return d; }
    if ((this._rep -= dt) <= 0) { this._rep = 0.08; return d; }
    return null;
  }

  update(dt) {
    if (!this.open) return;
    const inp = this.game.input;
    if (inp.gpPressed.size || Math.abs(inp.axis(0, 0.4)) + Math.abs(inp.axis(1, 0.4)) > 0) this.setDevice('pad');
    else if (inp.framePressed.size) this.setDevice('kb');
    if (!this.modal) {
      if (inp.pressed('KeyQ') || inp.gpPressedBtn(GP.LB)) this.cycle(-1);
      else if (inp.pressed('KeyE') || inp.gpPressedBtn(GP.RB)) this.cycle(1);
    }
    const dir = this.readDir(dt);
    if (dir && (this.modal || !this.tab.nav?.(dir, this.focus))) {
      if (!((dir === 'left' || dir === 'right') && this.adjust(this.focus, dir === 'left' ? -1 : 1))) this.move(dir);
    }
    if (inp.pressed('Enter') || inp.pressed('NumpadEnter') || inp.gpPressedBtn(GP.A)) this.activate();
    if (inp.pressed('Backspace') || inp.gpPressedBtn(GP.B)) this.back();
    // a failing tab must not break the frame (the paused loop renders right after ui.update)
    try {
      if (!this.modal) this.tab.key?.(inp, dt);
      this.tab.update?.(dt);
    } catch (e) {
      if (!this._errLogged?.has(this.tab.id)) { (this._errLogged ||= new Set()).add(this.tab.id); console.error(`[ui] tab ${this.tab.id}`, e); }
    }
    if (this._statusT > 0 && (this._statusT -= dt) <= 0) this.el.querySelector('.mstatus').classList.remove('show');
    this._headT = (this._headT || 0) - dt;
    if (this._headT <= 0) { this._headT = 0.5; this.updateHeader(); }
  }
}

function isTyping(e) { return e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'); }

function keyName(k, menu) {
  const map = { Space: 'key.space', Arrows: 'key.arrows', DPAD: 'pad.dpad' };
  return map[k] ? menu.t(map[k]) : k;
}
