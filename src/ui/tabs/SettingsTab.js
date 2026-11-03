import { Tab } from './Tab.js';
import { esc } from '../Hud.js';
import { section, toggle, choice, slider, bindRows, setChoice } from '../widgets.js';
import { icon } from '../icons.js';
import { hasHandler } from '../util.js';
import { MIN_RENDER_SCALE, MAX_RENDER_SCALE } from '../../core/renderSettings.js';
import { RENDER_STRINGS } from '../render-strings.js';

const QUALITIES = ['auto', 'low', 'medium', 'high', 'ultra'];
const BUSES = [['master', 'volume'], ['music', 'volMusic'], ['sfx', 'volSfx'], ['ambient', 'volAmbient'], ['engine', 'volEngine'], ['ui', 'volUi']];
const FX = ['bloom', 'shadows', 'ao', 'ssr', 'reflections'];
const VOL_DEFAULT = { volume: 0.8, volMusic: 0.05, volSfx: 1, volAmbient: 0.45, volEngine: 0.9, volUi: 0.8 }; // music quiet by default

// SETTINGS: language, graphics, display/HUD, audio, controls & gameplay.
export class SettingsTab extends Tab {
  constructor(menu) {
    super(menu, 'settings');
    this.icon = 'cog';
    this.i18n.register('render', RENDER_STRINGS);
    this.rebuildOnSetting = true; // prebuilt in idle: a setting changed elsewhere (F3, other modules) → rebuild
    bindRows(this.el, {
      act: (a, el) => { if (a === 'lang') this.setLang(el.dataset.lang); else if (a === 'mode') this.switchMode(el.dataset.v); },
      toggle: (k, on) => this.setToggle(k, on),
      choice: (k, d, row) => this.cycle(k, d, row),
      slider: (k, v, row, final) => this.slide(k, v, row, final),
    });
  }

  opts(k) {
    const t = (x) => this.t(x);
    if (k === 'quality') return QUALITIES.map((v) => ({ v, label: t(`q.${v}`) }));
    if (k === 'antialiasing') return (this.game.render?.antialiasingModes() || ['auto', 'none', 'fxaa', 'smaa']).map((v) => ({ v,
      label: v === 'auto' ? t('set.auto') : v === 'none' ? t('common.off') : v.startsWith('msaa') ? `MSAA ${v.slice(4)}× + SMAA` : v.toUpperCase() }));
    if (k === 'units') return [{ v: 'kmh', label: t('set.metric') }, { v: 'mph', label: t('set.imperial') }];
    if (k === 'fx.shadows') return [0, 1, 2, 3].map((v) => ({ v, label: v === 0 ? t('common.off') : t(['', 'q.low', 'q.medium', 'q.high'][v]) }));
    return [];
  }

  build() {
    const s = this.game.settings, i18n = this.i18n;
    const auto = i18n.languages.find((l) => l.code === i18n.autoLang);
    const langs = [{ code: 'auto', name: this.t('set.auto'), en: this.t('set.autoHint', { name: auto?.name ?? 'English' }) }, ...i18n.languages];
    const pref = i18n.pref;
    const pct = (v) => `${Math.round(v * 100)}%`;
    const q = this.game.quality || {};
    const fxRows = FX.filter((k) => k in q || (k === 'bloom' && this.game.render?.bloom)).map((k) => {
      const key = `fx.${k}`;
      const cur = s[key] ?? (k === 'bloom' && !('bloom' in q) ? this.game.render?.bloom?.enabled : q[k]);
      if (k === 'shadows' && typeof cur === 'number') return choice(key, this.t(`set.${key}`), this.opts(key), cur);
      return toggle(key, this.t(`set.${key}`), !!cur);
    }).join('');
    const mode = this.game.online ? 'online' : 'single';
    const modes = this.game.switchMode ? `${section(this.t('gm.title'), 'gamepad')}
        <div class="gmodes">${['online', 'single'].map((m) => `<div class="gmode ${m} ${m === mode ? 'on' : ''}" data-nav data-act="mode" data-v="${m}">
          <div class="gmh">${icon(m === 'online' ? 'globe' : 'user')}<b>${esc(this.t(`gm.${m}`))}</b>${m === mode ? `<span class="cur">${esc(this.t('gm.current'))}</span>` : ''}</div>
          <p>${esc(this.t(`gm.${m}Desc`))}</p></div>`).join('')}</div>` : '';
    this.el.innerHTML = `
      <div class="settings">
        ${modes}
        ${section(this.t('set.language'), 'globe')}
        <div class="langs">${langs.map((l) => `<div class="lang ${l.code === pref ? 'on' : ''}" data-nav data-act="lang" data-lang="${l.code}" ${l.dir ? `dir="${l.dir}"` : ''} lang="${l.code === 'auto' ? i18n.lang : l.code}"><b>${esc(l.name)}</b><small>${esc(l.en)}</small></div>`).join('')}</div>
        <div class="cols">
          <div class="col">
            ${section(this.t('set.graphics'), 'sun')}
            ${choice('quality', this.t('set.quality'), this.opts('quality'), s.quality ?? 'auto')}
            ${toggle('autoRes', this.t('set.autoRes'), s.autoRes !== false)}
            ${slider('resScale', this.t('set.resScale'), { min: MIN_RENDER_SCALE, max: MAX_RENDER_SCALE, step: 0.05, value: s.resScale ?? 1, text: pct(s.resScale ?? 1) })}
            <p class="render-hint">${esc(this.t('render.scaleHint'))}</p>
            <p class="render-size" aria-live="polite"></p>
            ${choice('antialiasing', this.t('render.aa'), this.opts('antialiasing'), this.game.render?.antialiasing || s.antialiasing || 'auto')}
            <p class="render-hint">${esc(this.t('render.aaHint'))}</p>
            ${slider('drawDist', this.t('set.drawDist'), { min: 0.5, max: 1.6, step: 0.1, value: s.drawDist ?? 1, text: pct(s.drawDist ?? 1) })}
            ${fxRows}
            ${section(this.t('set.display'), 'map')}
            ${slider('hudScale', this.t('set.hudScale'), { min: 0.8, max: 1.3, step: 0.05, value: s.hudScale ?? 1, text: pct(s.hudScale ?? 1) })}
            ${toggle('showFps', this.t('set.showFps'), !!s.showFps)}
            ${choice('units', this.t('set.units'), this.opts('units'), s.units ?? 'kmh')}
          </div>
          <div class="col">
            ${section(this.t('set.audio'), 'bolt')}
            ${BUSES.map(([bus, key]) => slider(key, this.t(`vol.${bus}`), { min: 0, max: 1, step: 0.05, value: s[key] ?? VOL_DEFAULT[key], text: pct(s[key] ?? VOL_DEFAULT[key]) })).join('')}
            ${toggle('audioHrtf', this.t('set.hrtf'), s.audioHrtf !== false)}
            ${section(this.t('set.gameplay'), 'gamepad')}
            ${slider('camSens', this.t('set.camSens'), { min: 0.3, max: 2, step: 0.1, value: s.camSens ?? 1, text: pct(s.camSens ?? 1) })}
            ${toggle('invertY', this.t('set.invertY'), !!s.invertY)}
            ${toggle('assists', this.t('set.assists'), s.assists !== false)}
            ${this.game.input?.touch ? `${section(this.t('set.touch'), 'gamepad')}
            ${slider('touchScale', this.t('set.touchScale'), { min: 0.6, max: 1.6, step: 0.05, value: s.touchScale ?? 1, text: pct(s.touchScale ?? 1) })}
            ${slider('touchOpacity', this.t('set.touchOpacity'), { min: 0.2, max: 1, step: 0.05, value: s.touchOpacity ?? 0.7, text: pct(s.touchOpacity ?? 0.7) })}
            ${toggle('touchLeftHanded', this.t('set.touchLeftHanded'), !!s.touchLeftHanded)}
            ${toggle('tiltSteer', this.t('set.tiltSteer'), !!s.tiltSteer)}` : ''}
          </div>
        </div>
      </div>`;
    this.syncResRow();
  }

  syncResRow() {
    const row = this.el.querySelector('[data-key="resScale"]');
    row?.classList.toggle('disabled', this.game.settings.autoRes !== false);
    const input = row?.querySelector('input');
    if (input) { input.disabled = this.game.settings.autoRes !== false; input.setAttribute('aria-label', this.t('set.resScale')); }
    this.updateResolution();
  }

  updateResolution() {
    const r = this.game.render, el = this.el.querySelector('.render-size');
    if (!r || !el) return;
    const text = `${r.width} × ${r.height}` + (r.displaySize?.limited ? ` · ${this.t('render.limited', { percent: Math.round(r.displaySize.appliedScale * 100) })}` : '');
    if (el.textContent !== text) el.textContent = text;
  }

  update(dt) {
    this._resClock = (this._resClock || 0) - dt;
    if (this._resClock <= 0) { this._resClock = 0.5; this.updateResolution(); }
  }

  async switchMode(m) {
    const g = this.game;
    if (!g.switchMode || (m === 'online') === !!g.online) return;
    const ok = await this.menu.confirm({
      title: this.t(`gm.${m}`),
      text: this.t('gm.confirm', { name: this.t(`gm.${m}`) }),
      ok: this.t('gm.switch'),
    });
    if (ok) g.switchMode(m);
  }

  setLang(code) {
    this.ui._langNotice = true;
    this.game.applySetting('lang', code);
    this.el.querySelectorAll('.lang').forEach((x) => x.classList.toggle('on', x.dataset.lang === code));
    if (this.i18n.lang === (code === 'auto' ? this.i18n.autoLang : code)) {
      // same resolved language: no change event, still confirm
      if (this.ui._langNotice) { this.ui._langNotice = false; this.ui.feed({ kind: 'settings', icon: 'globe', text: this.t('notify.lang', { name: this.i18n.language.name }) }); }
    }
  }

  setToggle(k, on) {
    const g = this.game;
    g.applySetting(k, on);
    if (k === 'autoRes') this.syncResRow();
    if (k === 'fx.bloom' && !hasHandler(g, k) && g.render?.bloom) g.render.bloom.enabled = on;
    if (k.startsWith('fx.')) g.render?.setEffect?.(k.slice(3), on);
  }

  cycle(k, d, row) {
    const opts = this.opts(k);
    const i = (+row.dataset.i + d + opts.length) % opts.length;
    setChoice(row, i, opts[i].label);
    this.game.applySetting(k, opts[i].v);
    if (k === 'antialiasing') this.updateResolution();
    if (k.startsWith('fx.')) this.game.render?.setEffect?.(k.slice(3), opts[i].v);
  }

  slide(k, v, row, final) {
    const g = this.game;
    row.querySelector('output').textContent = `${Math.round(v * 100)}%`;
    const bus = BUSES.find((b) => b[1] === k);
    if (bus) { g.audio?.setVolume?.(bus[0], v); if (final) g.applySetting(k, v); return; }
    if (k === 'hudScale') { document.documentElement.style.setProperty('--hud-scale', String(v)); if (final) g.applySetting(k, v); return; }
    if (!final) return;
    g.applySetting(k, v);
    if (k === 'resScale') this.updateResolution();
    if (k === 'resScale' && !hasHandler(g, k) && g.render && g.settings.autoRes === false) { g.render.scale = v; g.render.resize?.(); }
  }

  hints() { return [[['←', '→'], 'menu.hint.adjust'], [['Q', 'E'], 'menu.hint.tabs']]; }
}
