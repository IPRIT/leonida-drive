// Small self-contained HUD pieces for the economy: the active contract card (top centre) and a combo timer bar under
// the money (top right). Mounted into G's HUD slots when available (they hide with the HUD), else fixed-positioned.
// Styling uses the CSS variables of src/ui/styles.css (read-only). DOM text is touched only when it changes.
import { tr, fmt } from './Economy.js';

const CSS = `
.eco-card { font: 500 15px var(--f-ui, Arial, sans-serif); color: #fff; background: var(--ui-bg, rgba(8,8,12,.72));
  border-left: 4px solid var(--gold, #f5c84c); padding: 6px 12px 7px; margin-top: 6px; min-width: 240px; text-align: left;
  text-shadow: 0 1px 2px #000; border-radius: 2px; pointer-events: none; }
.eco-card .t { font-family: var(--f-disp, sans-serif); font-weight: var(--fw-disp, 400); font-size: 13px; letter-spacing: .5px;
  color: var(--gold, #f5c84c); text-transform: uppercase; }
.eco-card .d { font-size: 18px; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 340px; }
.eco-card .m { display: flex; gap: 14px; font-family: var(--f-num, sans-serif); font-size: 15px; margin-top: 2px; }
.eco-card .m .pay { color: var(--money, #72d45b); }
.eco-card .m .tm.low { color: #ff5a4c; }
.eco-card.export { border-left-color: var(--pink, #ff3fa4); }
.eco-card.export .t { color: var(--pink, #ff3fa4); }
.eco-combo { width: 120px; height: 4px; margin: 4px 0 0 auto; background: rgba(0,0,0,.45); border-radius: 2px; overflow: hidden;
  opacity: 0; transition: opacity .25s; pointer-events: none; }
.eco-combo.on { opacity: 1; }
.eco-combo i { display: block; height: 100%; background: var(--gold, #f5c84c); transform-origin: 0 50%; }
.eco-combo.hot i { background: var(--orange, #ff8a3d); }
.eco-combo b { display: block; font: 400 14px var(--f-num, sans-serif); color: var(--gold, #f5c84c); text-align: right; }
.eco-fixed { position: fixed; z-index: 30; pointer-events: none; }
`;

export class JobHud {
  constructor(game) {
    this.game = game;
    this.ok = typeof document !== 'undefined';
    if (!this.ok) return;
    if (!document.getElementById('eco-css')) {
      const st = document.createElement('style');
      st.id = 'eco-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.card = document.createElement('div');
    this.card.className = 'eco-card';
    this.card.style.display = 'none';
    this.card.innerHTML = '<div class="t"></div><div class="d"></div><div class="m"><span class="dist"></span><span class="tm"></span><span class="pay"></span></div>';
    this.el = {
      t: this.card.querySelector('.t'), d: this.card.querySelector('.d'),
      dist: this.card.querySelector('.dist'), tm: this.card.querySelector('.tm'), pay: this.card.querySelector('.pay'),
    };
    this.combo = document.createElement('div');
    this.combo.className = 'eco-combo';
    this.combo.innerHTML = '<b></b><i></i>';
    this.comboBar = this.combo.querySelector('i');
    this.comboText = this.combo.querySelector('b');
    this._txt = {};
    this._mounted = false;
    this._comboOn = false;
    this._comboScale = -1;
  }

  // mount lazily: the UI is created after the economy in bootstrap
  mount() {
    if (!this.ok || this._mounted) return;
    const ui = this.game.ui;
    const mount = ui?.mount ? ui.mount.bind(ui) : ui?.hud?.mount ? ui.hud.mount.bind(ui.hud) : null;
    // G's HUD already draws the ×N badge next to the money (economy:combo); we only add the draining timer bar
    this.ownBadge = !ui?.hud?.setCombo;
    this.comboText.style.display = this.ownBadge ? '' : 'none';
    let ok = false;
    if (mount) {
      try { this._u1 = mount('top-center', this.card); this._u2 = mount('top-right-under-money', this.combo); ok = true; } catch { ok = false; }
    }
    if (!ok) {
      this.card.classList.add('eco-fixed');
      Object.assign(this.card.style, { top: '64px', left: '50%', transform: 'translateX(-50%)' });
      this.combo.classList.add('eco-fixed');
      Object.assign(this.combo.style, { top: '76px', right: '34px' });
      document.body.appendChild(this.card);
      document.body.appendChild(this.combo);
    }
    this._mounted = true;
  }

  _set(key, el, text) {
    if (this._txt[key] === text) return;
    this._txt[key] = text;
    el.textContent = text;
  }

  /** Show the contract card. o: { kind: 'delivery'|'export', title, dest, dist (m), time (s|null), pay (text) } */
  showCard(o) {
    if (!this.ok) return;
    this.mount();
    this.card.style.display = '';
    this.card.classList.toggle('export', o.kind === 'export');
    this._set('t', this.el.t, o.title || '');
    this._set('d', this.el.d, o.dest || '');
    this.updateCard(o.dist, o.time, o.pay);
  }

  updateCard(dist, time, pay) {
    if (!this.ok) return;
    const g = this.game;
    this._set('dist', this.el.dist, dist == null ? '' : dist >= 1000 ? `${(dist / 1000).toFixed(1)} ${tr(g, 'eco.km', 'km')}` : `${Math.round(dist / 10) * 10} ${tr(g, 'eco.m', 'm')}`);
    if (time == null) this._set('tm', this.el.tm, '');
    else {
      const s = Math.max(0, Math.ceil(time));
      this._set('tm', this.el.tm, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
      const low = s <= 20;
      if (this._low !== low) { this._low = low; this.el.tm.classList.toggle('low', low); }
    }
    if (pay !== undefined) this._set('pay', this.el.pay, pay);
  }

  hideCard() {
    if (!this.ok) return;
    this.card.style.display = 'none';
  }

  /** Combo timer bar (call every frame; cheap: writes only when the value changes). */
  updateCombo(combo, left, window) {
    if (!this.ok) return;
    const on = combo > 1 && left > 0;
    if (on !== this._comboOn) {
      this._comboOn = on;
      this.mount();
      this.combo.classList.toggle('on', on);
      this.combo.classList.toggle('hot', combo >= 3);
    }
    if (!on) return;
    const k = Math.round((left / window) * 100) / 100;
    if (k !== this._comboScale) { this._comboScale = k; this.comboBar.style.transform = `scaleX(${k})`; }
    if (this.ownBadge) this._set('combo', this.comboText, `×${Math.round(combo * 10) / 10}`);
    if (this._hot !== combo >= 3) { this._hot = combo >= 3; this.combo.classList.toggle('hot', this._hot); }
  }

  money(n) { return fmt(this.game, n); }

  dispose() {
    this._u1?.(); this._u2?.();
    this.card?.remove(); this.combo?.remove();
  }
}
