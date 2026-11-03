import { Tab } from './Tab.js';
import { esc, setText } from '../Hud.js';
import { section, button, bindRows } from '../widgets.js';

const ROWS = [
  ['driving', 'car', ['distance', 'flown', 'sailed', 'topSpeed', 'crashes', 'destroyed', 'explosions']],
  ['world', 'chart', ['money', 'spawned', 'wasted', 'playtime']],
];
const FIELD = { distance: 'driven', flown: 'flown', sailed: 'sailed', topSpeed: 'topSpeed', crashes: 'crashes', destroyed: 'destroyed', explosions: 'explosions', money: 'money', spawned: 'spawned', wasted: 'wasted', playtime: 'playtime' };

// STATS: distance, top speed, money earned, crashes, explosions... (persisted by Stats.js)
export class StatsTab extends Tab {
  constructor(menu) {
    super(menu, 'stats');
    this.icon = 'chart';
    bindRows(this.el, { act: (a) => { if (a === 'reset') { this.ui.stats.reset(); this.refresh(); this.ui.feed({ kind: 'info', icon: 'chart', text: this.t('notify.statsReset'), seconds: 2 }); } } });
  }

  build() {
    this.el.innerHTML = `<div class="cols stats">${ROWS.map(([sec, ic, keys]) => `
      <div class="col">${section(this.t(`stats.${sec}`), ic)}
        ${keys.map((k) => `<div class="srow" data-k="${k}"><span>${esc(this.t(`stats.${k}`))}</span><b></b></div>`).join('')}
        ${sec === 'world' ? `<div class="btnrow">${button('reset', this.t('stats.reset'), { ic: 'trash' })}</div>` : ''}
      </div>`).join('')}</div>`;
    this.refresh();
  }

  format(k, v) {
    const imp = this.game.settings.units === 'mph';
    const i = this.i18n;
    if (k === 'distance' || k === 'flown' || k === 'sailed') {
      const n = (v / 1000) * (imp ? 0.621371 : 1);
      return this.t(imp ? 'unit.mi' : 'unit.km', { n: Math.round(n * 10) / 10 });
    }
    if (k === 'topSpeed') return this.t(imp ? 'unit.mph' : 'unit.kmh', { n: Math.round(v * (imp ? 0.621371 : 1)) });
    if (k === 'money') return i.money(v);
    if (k === 'playtime') {
      const m = Math.floor(v / 60), h = Math.floor(m / 60);
      return h ? this.t('time.hm', { h, m: m % 60 }) : this.t('time.m', { m });
    }
    return i.number(Math.round(v));
  }

  refresh() {
    const d = this.ui.stats.data;
    this.el.querySelectorAll('.srow').forEach((r) => setText(r.querySelector('b'), this.format(r.dataset.k, d[FIELD[r.dataset.k]] || 0)));
  }

  show() { this.refresh(); }
  update(dt) { if ((this._t = (this._t || 0) - dt) <= 0) { this._t = 0.5; this.refresh(); } }
  hints() { return [[['Q', 'E'], 'menu.hint.tabs']]; }
}
