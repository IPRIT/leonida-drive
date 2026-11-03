import { Tab } from './Tab.js';
import { esc } from '../Hud.js';
import { icon } from '../icons.js';
import { section, slider, toggle, choice, button, bindRows, setChoice } from '../widgets.js';
import { hasHandler } from '../util.js';

export const WEATHERS = [
  ['auto', 'auto'], ['clear', 'sun'], ['partly', 'partly'], ['overcast', 'cloud'],
  ['lightRain', 'lightRain'], ['heavyRain', 'heavyRain'], ['storm', 'storm'], ['fog', 'fog'],
];
const SPEEDS = [0, 1, 4, 10];
const PRESETS = [['dawn', 6.2], ['noon', 12.5], ['sunset', 18.6], ['midnight', 0]];

const fmtHour = (h) => {
  const hh = Math.floor(((h % 24) + 24) % 24), mm = Math.floor((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

// WORLD: weather presets, time of day, time speed, population density, fun toggles, clear wrecks.
export class WorldTab extends Tab {
  constructor(menu) {
    super(menu, 'world');
    this.icon = 'globe';
    this.rebuildOnSetting = true;
    bindRows(this.el, {
      act: (a, el) => this.act(a, el),
      slider: (k, v, row, final) => this.slide(k, v, row, final),
      toggle: (k, on) => { if (k === 'lowGravity') this.setGravity(on); },
      choice: (k, d, row) => { if (k === 'timeSpeed') this.cycleSpeed(d, row); },
    });
  }

  build() {
    const s = this.game.settings;
    const cur = this.weatherNow();
    const speed = s.timeMode === 'freeze' ? 0 : (s.timeScale ?? 1);
    const pct = (v) => `${Math.round(v * 100)}%`;
    // sandbox-only controls are hidden (not disabled) in online mode — see game.can() in docs/ARCHITECTURE.md
    const weather = this.can('weather'), time = this.can('time'), speedOk = this.can('timeScale'), cheats = this.can('godMode');
    this.el.innerHTML = `
      <div class="cols">
        <div class="col">
          ${weather ? `${section(this.t('world.weather'), 'cloud')}
          <div class="tiles wx">${WEATHERS.map(([id, ic]) => `<div class="tile ${id === cur ? 'on' : ''}" data-nav data-act="weather" data-v="${id}">${icon(ic)}<span>${esc(this.t(`weather.${id}`))}</span></div>`).join('')}</div>` : ''}
          ${speedOk ? `${section(this.t('world.population'), 'user')}
          ${slider('traffic', this.t('world.traffic'), { min: 0, max: 1.5, step: 0.1, value: s.traffic ?? 1, text: pct(s.traffic ?? 1) })}
          ${slider('peds', this.t('world.peds'), { min: 0, max: 1.5, step: 0.1, value: s.peds ?? 1, text: pct(s.peds ?? 1) })}` : ''}
        </div>
        <div class="col">
          ${time || speedOk ? section(this.t('world.time'), 'clock') : ''}
          ${time ? `${slider('hour', this.t('world.hour'), { min: 0, max: 23.75, step: 0.25, value: this.game.sky?.time ?? 12, text: this.game.sky?.clock ?? '' })}
          <div class="chips">${PRESETS.map(([k, h]) => `<button class="chip" data-nav data-act="hour" data-v="${h}" tabindex="-1">${esc(this.t(`world.${k}`))}<small>${fmtHour(h)}</small></button>`).join('')}</div>` : ''}
          ${speedOk ? choice('timeSpeed', this.t('world.timeSpeed'), SPEEDS.map((v) => ({ v, label: v === 0 ? this.t('world.freeze') : `×${v}` })), speed) : ''}
          ${cheats ? `${section(this.t('world.fun'), 'bolt')}
          ${toggle('lowGravity', this.t('world.lowGravity'), !!this.game.lowGravity)}
          <div class="btnrow">${button('wrecks', this.t('world.clearWrecks'), { ic: 'trash' })}</div>` : ''}
        </div>
      </div>`;
    this.hourRow = this.el.querySelector('[data-key="hour"]');
  }

  available() { return this.can('weather') || this.can('time') || this.can('timeScale'); }

  weatherNow() {
    const s = this.game.settings.weather;
    if (!s || s === 'auto') return 'auto';
    return s;
  }

  act(a, el) {
    const g = this.game;
    if (a === 'weather' && this.can('weather')) {
      const v = el.dataset.v;
      g.applySetting('weather', v);
      if (!hasHandler(g, 'weather')) {
        if (v === 'auto') { if (g.weather?.setAuto) g.weather.setAuto(true); else if (g.weather) g.weather.auto = true; }
        else { if (g.weather) g.weather.auto = false; g.weather?.set?.(v, 8); }
      }
      this.el.querySelectorAll('.tile[data-act="weather"]').forEach((x) => x.classList.toggle('on', x === el));
      this.ui.feed({ kind: 'weather', icon: WEATHERS.find((w) => w[0] === v)?.[1], text: this.t('notify.weather', { name: this.t(`weather.${v}`) }), seconds: 2.5 });
    } else if (a === 'hour' && this.can('time')) {
      this.setHour(+el.dataset.v, true);
    } else if (a === 'wrecks' && this.can('godMode')) {
      this.clearWrecks();
    }
  }

  slide(k, v, row, final) {
    const g = this.game;
    const out = row.querySelector('output');
    if (k === 'hour') {
      out.textContent = fmtHour(v);
      this.setHour(v, final);
      return;
    }
    out.textContent = `${Math.round(v * 100)}%`;
    if (!final) return;
    g.applySetting(k, v);
    const obj = k === 'traffic' ? g.traffic : g.peds;
    if (!hasHandler(g, k) && obj) { obj._baseMax ??= obj.max; obj.max = Math.round(obj._baseMax * Math.min(1, v)); }
  }

  setHour(h, notify) {
    const g = this.game;
    g.sky?.setTime?.(h, { smooth: true });
    this._dragT = 1;
    this._skyT = undefined; // re-sync the slider with the sky on the next update (as before)
    this.ui.invalidateBackdrop?.(); // new time of day → refresh the frozen world behind the menu
    if (this.hourRow) {
      this.hourRow.querySelector('input').value = h;
      this.hourRow.querySelector('output').textContent = fmtHour(h);
    }
    if (notify) this.ui.feed({ kind: 'world', icon: 'clock', text: this.t('notify.time', { time: fmtHour(h) }), seconds: 2 });
  }

  cycleSpeed(d, row) {
    const g = this.game;
    const i = (+row.dataset.i + d + SPEEDS.length) % SPEEDS.length;
    const k = SPEEDS[i];
    const label = k === 0 ? this.t('world.freeze') : `×${k}`;
    setChoice(row, i, label);
    g.applySetting('timeMode', k === 0 ? 'freeze' : 'cycle');
    if (k) g.applySetting('timeScale', k);
    if (!hasHandler(g, 'timeScale') && g.sky && k) {
      g.sky._baseTimeScale ??= g.sky.timeScale;
      g.sky.timeScale = g.sky._baseTimeScale * k;
    }
    if (!hasHandler(g, 'timeMode') && g.sky) g.sky.paused = k === 0;
    this.ui.feed({ kind: 'world', icon: 'clock', text: this.t('notify.timeSpeed', { name: label }), seconds: 2 });
  }

  setGravity(on) {
    const g = this.game;
    g.lowGravity = on;
    try { g.world.gravity = { x: 0, y: on ? -9.81 * 0.35 : -9.81, z: 0 }; } catch (e) { console.warn('[ui] gravity', e); }
    g.events.emit('gravity', { scale: on ? 0.35 : 1 });
    this.ui.feed({ kind: 'world', icon: 'gravity', text: this.t(on ? 'notify.lowGravityOn' : 'notify.lowGravityOff'), seconds: 2.5 });
  }

  clearWrecks() {
    const g = this.game;
    let n = 0;
    const own = g.player?.controllable;
    for (const v of [...(g.vehicles?.active || [])]) {
      if (v === own || v.occupied) continue;
      if (v.destroyed || v.wrecked || v.damage?.destroyed || v.damage?.wrecked) { g.vehicles.despawn(v); n++; }
    }
    n += +(g.damage?.clearWrecks?.() || 0);
    n += +(g.traffic?.clearWrecks?.() || 0);
    g.events.emit('world:clearWrecks', {});
    this.ui.feed({ kind: 'world', icon: 'trash', text: n ? this.t('notify.wrecks', { count: n }) : this.t('notify.noWrecks'), seconds: 2.5 });
  }

  update(dt) {
    // keep the time slider in sync with the running clock
    if ((this._syncT = (this._syncT || 0) - dt) > 0) return;
    this._syncT = 0.5;
    if ((this._dragT = (this._dragT || 0) - 0.5) > 0 || !this.hourRow || this.menu.focus === this.hourRow) return;
    const sky = this.game.sky;
    if (!sky) return;
    // the world is frozen behind the pause menu: write only when the clock actually moved
    if (this._skyT !== sky.time) { this._skyT = sky.time; this.hourRow.querySelector('input').value = sky.time; }
    const out = this.hourRow.querySelector('output');
    if (out.textContent !== sky.clock) out.textContent = sky.clock;
  }

  hints() { return [[['←', '→'], 'menu.hint.adjust'], [['Q', 'E'], 'menu.hint.tabs']]; }
}
