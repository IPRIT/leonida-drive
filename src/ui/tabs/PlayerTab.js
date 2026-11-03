import { Tab } from './Tab.js';
import { esc, setText } from '../Hud.js';
import { DESTINATIONS } from '../../world/regions.js';
import { section, toggle, button, bindRows } from '../widgets.js';
import { recoverVehicle } from '../../core/BasicPlayer.js';

const AMOUNTS = [1000, 10000, 100000, 1000000];

// PLAYER: status (health/armor/money), refill, add money, invincibility, vehicle repair/reset, quick teleports.
export class PlayerTab extends Tab {
  constructor(menu) {
    super(menu, 'player');
    this.icon = 'user';
    bindRows(this.el, {
      act: (a, el) => this.act(a, el),
      toggle: (k, on) => { if (k === 'god') this.setGod(on); else if (k === 'unlockAll') this.setUnlockAll(on); },
    });
  }

  build() {
    const p = this.game.player;
    const money = (n) => this.i18n.money(n, { sign: true });
    // sandbox-only controls are hidden in online mode
    const god = this.can('godMode'), cash = this.can('money'), repair = this.can('repair'), tp = this.can('teleport');
    const eco = this.game.economy;
    this.el.innerHTML = `
      <div class="cols">
        <div class="col">
          ${section(this.t('player.status'), 'user')}
          <div class="pstat">
            <div class="pbar health"><span>${esc(this.t('player.health'))}</span><div class="sb"><i></i></div><b></b></div>
            <div class="pbar armor"><span>${esc(this.t('player.armor'))}</span><div class="sb"><i></i></div><b></b></div>
            <div class="pmoney"><span>${esc(this.t('player.money'))}</span><b></b></div>
          </div>
          ${god ? `<div class="btnrow">${button('refill', this.t('player.refill'), { ic: 'heart', cls: 'wide' })}</div>` : ''}
          ${cash ? `${section(this.t('player.addMoney'), 'money')}
          <div class="chips money">${AMOUNTS.map((a) => `<button class="chip" data-nav data-act="money" data-v="${a}" tabindex="-1">${esc(money(a))}</button>`).join('')}</div>` : ''}
          ${god || (cash && eco) ? section(this.t('player.cheats'), 'shield') : ''}
          ${god ? toggle('god', this.t('player.god'), !!p.invincible) : ''}
          ${cash && eco ? toggle('unlockAll', this.t('player.unlockAll'), !!(eco.unlockAll ?? eco.unlockedAll)) : ''}
        </div>
        <div class="col">
          ${section(this.t('player.vehicle'), 'wrench')}
          <div class="btnrow">${repair ? button('repair', this.t('player.repair'), { ic: 'wrench' }) : ''}${button('reset', this.t('player.reset'), { ic: 'auto' })}</div>
          ${tp ? `${section(this.t('player.quickTp'), 'pin')}
          <div class="tplist">${DESTINATIONS.slice(0, 12).map((d, i) => `<div class="tp" data-nav data-act="tp" data-i="${i}"><span>${esc(d.name)}</span><small>${esc(d.area === 'National Park' ? this.t('area.nationalPark') : d.area)}</small></div>`).join('')}</div>
          <div class="btnrow">${button('tpw', this.t('player.tpWaypoint'), { ic: 'pin', cls: 'primary' })}</div>` : ''}
        </div>
      </div>`;
    this.refresh();
  }

  show() { this.refresh(); }

  refresh() {
    const p = this.game.player;
    const set = (cls, v) => {
      const row = this.el.querySelector(`.pbar.${cls}`);
      if (!row) return;
      const k = Math.max(0, Math.min(1, v));
      const bar = row.querySelector('i');
      if (bar._k !== k) { bar._k = k; bar.style.transform = `scaleX(${k})`; } // 4×/s while open: write only changes
      setText(row.querySelector('b'), `${Math.round(k * 100)}%`);
    };
    set('health', norm(p.health, p.maxHealth));
    set('armor', norm(p.armor, p.maxArmor));
    const m = this.el.querySelector('.pmoney b');
    if (m) setText(m, this.i18n.money(this.game.economy?.money ?? p.money ?? 0));
  }

  update(dt) {
    if ((this._t = (this._t || 0) - dt) > 0) return;
    this._t = 0.25;
    this.refresh();
  }

  async act(a, el) {
    const g = this.game, p = g.player;
    const cap = { refill: 'godMode', money: 'money', repair: 'repair', tp: 'teleport', tpw: 'teleport' }[a];
    if (cap && !this.can(cap)) return;
    if (a === 'refill') {
      if (p.heal) p.heal(); else {
        p.health = p.maxHealth ?? (p.health > 1.5 ? 100 : 1);
        p.armor = p.maxArmor ?? (p.maxHealth > 1.5 || p.health > 1.5 ? 100 : 1);
      }
      this.ui.feed({ kind: 'player', icon: 'heart', text: this.t('notify.healed'), seconds: 2.5 });
    } else if (a === 'money') {
      const n = +el.dataset.v;
      const eco = g.economy;
      // sandbox cash: through the economy when present (it owns the wallet), else the player
      if (eco?.grant) { eco.grant(n, 'sandbox'); g.events.emit('money:pickup', { amount: n }); }
      else if (eco?.give) { eco.give(n); g.events.emit('money:pickup', { amount: n }); }
      else if (p.addMoney) p.addMoney(n, p.focus);
      else { p.money = (p.money || 0) + n; g.events.emit('money:pickup', { amount: n }); }
      this.ui.feed({ kind: 'bank', text: this.t('notify.money', { amount: this.i18n.money(n) }), seconds: 2.5 });
    } else if (a === 'repair' || a === 'reset') {
      const v = p.controllable;
      if (!v || p.mode !== 'vehicle') { this.ui.feed({ kind: 'player', icon: 'car', text: this.t('notify.noVehicle'), seconds: 2.5 }); return; }
      this.ui.close();
      if (a === 'repair') {
        v.damage?.repair?.();
        v.repair?.();
        this.ui.feed({ kind: 'garage', icon: 'wrench', text: this.t('notify.repaired'), seconds: 2.5 });
      } else {
        if (!await recoverVehicle(g, v)) return;
        this.ui.feed({ kind: 'garage', icon: 'auto', text: this.t('notify.reset'), seconds: 2.5 });
      }
      return;
    } else if (a === 'tp') {
      const d = DESTINATIONS[+el.dataset.i];
      this.ui.teleport(d.x, d.z, d.name);
    } else if (a === 'tpw') {
      const w = p.waypoint;
      if (w) this.ui.teleport(w.x, w.z);
      else this.ui.feed({ kind: 'gps', text: this.t('notify.noWaypoint') });
    }
    this.refresh();
  }

  setUnlockAll(on) {
    const eco = this.game.economy;
    if (!eco || !this.can('money')) return;
    if (eco.setUnlockAll) eco.setUnlockAll(on); else eco.unlockAll = on;
    this.menu.byId.get('vehicles').dirty = true;
  }

  setGod(on) {
    if (!this.can('godMode')) return;
    this.game.player.invincible = on;
    this.ui.feed({ kind: 'player', icon: 'shield', text: this.t(on ? 'notify.godOn' : 'notify.godOff'), seconds: 2.5 });
  }

  hints() { return [[['Q', 'E'], 'menu.hint.tabs']]; }
}

const norm = (v, max) => {
  if (v === undefined || v === null) return 0;
  return v / (max ?? (v > 1.5 ? 100 : 1));
};
