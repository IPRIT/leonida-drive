import { Tab } from './Tab.js';
import { esc } from '../Hud.js';
import { icon } from '../icons.js';
import { CONTROL_MODES } from '../controls-data.js';
import { keycap } from '../widgets.js';
import { icon as touchIcon } from '../../mobile/icons.js';

// CONTROLS: keyboard & gamepad layouts per mode (on foot, car, bikes, helicopter, plane, boat, free camera).
// Touch screens (body.is-mobile): the touch layout (overlay button glyphs) replaces the keyboard column.
export class ControlsTab extends Tab {
  constructor(menu) {
    super(menu, 'controls');
    this.icon = 'gamepad';
    this.mode = 'car';
    this.el.addEventListener('click', (e) => {
      const m = e.target.closest('[data-mode]');
      if (m) this.setMode(m.dataset.mode);
    });
  }

  build() {
    this.el.innerHTML = `
      <div class="controls">
        <div class="modes">${CONTROL_MODES.map((m) => `<div class="mode ${m.id === this.mode ? 'on' : ''}" data-nav data-mode="${m.id}">${icon(m.icon)}<span>${esc(this.t(`ctl.mode.${m.id}`))}</span></div>`).join('')}</div>
        <div class="cols binds"></div>
      </div>`;
    this.renderBinds();
  }

  keyLabel(k) { return k.startsWith('@') ? this.t(k.slice(1)) : k; }
  keyCap(k, pad) { return k.startsWith('#') ? `<span class="tkey">${touchIcon(k.slice(1))}</span>` : keycap(this.keyLabel(k), pad); }

  renderBinds() {
    const m = CONTROL_MODES.find((x) => x.id === this.mode) || CONTROL_MODES[0];
    const list = (rows, pad) => rows.map(([act, keys]) => `<div class="bind"><span>${esc(this.t(act))}</span><span class="keys">${keys.map((k) => this.keyCap(k, pad)).join('')}</span></div>`).join('');
    const touch = document.body.classList.contains('is-mobile') && m.touch;
    this.el.querySelector('.binds').innerHTML = `
      ${touch ? `<div class="col"><h3 class="sec">${icon('gamepad')}<span>${esc(this.t('set.touch'))}</span></h3>${list(m.touch, false)}</div>`
    : `<div class="col"><h3 class="sec">${icon('keyboard')}<span>${esc(this.t('ctl.keyboard'))}</span></h3>${list(m.kb, false)}</div>`}
      <div class="col"><h3 class="sec">${icon('gamepad')}<span>${esc(this.t('ctl.gamepad'))}</span></h3>${m.pad.length ? list(m.pad, true) : '<div class="bind muted">—</div>'}</div>`;
  }

  setMode(id) {
    if (id === this.mode) return;
    this.mode = id;
    this.el.querySelectorAll('.mode').forEach((x) => x.classList.toggle('on', x.dataset.mode === id));
    this.renderBinds();
  }

  onFocus(el, { mouse } = {}) { if (el.dataset.mode && !mouse) this.setMode(el.dataset.mode); }
  defaultFocus() { return this.el.querySelector(`.mode[data-mode="${this.mode}"]`); }
  hints() { return [[['←', '→'], 'menu.hint.navigate'], [['Q', 'E'], 'menu.hint.tabs']]; }
}
