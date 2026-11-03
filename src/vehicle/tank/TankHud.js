// Minimal DOM overlay for the tank gun: a small ring where the barrel actually points (the camera crosshair and
// the reload ring are G's HUD, driven by 'tank:reload'). Without G's HUD (noUI labs) it also draws a centre
// crosshair and a reload label. Disable with game.settings.tankReticle = false.
import * as THREE from 'three';

const huds = new WeakMap();
const _v = new THREE.Vector3();

function tr(game, key, fallback) {
  const s = game.i18n?.t?.(key, { default: fallback });
  return s && s !== key ? s : fallback;
}

export class TankHud {
  static get(game) {
    let h = huds.get(game);
    if (!h) { h = new TankHud(game); huds.set(game, h); }
    return h;
  }

  constructor(game) {
    this.game = game;
    this.owner = null;
    this.visible = false;
    if (typeof document === 'undefined') return;
    const root = (this.root = document.createElement('div'));
    root.className = 'tank-hud';
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:6;display:none;';
    const gun = (this.gun = document.createElement('div'));
    gun.style.cssText = 'position:absolute;left:0;top:0;width:16px;height:16px;margin:-9px 0 0 -9px;border:2px solid rgba(255,190,90,.9);'
      + 'border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.45);will-change:transform;';
    root.appendChild(gun);
    if (!game.ui) {
      const c = (this.cross = document.createElement('div'));
      c.style.cssText = 'position:absolute;left:50%;top:50%;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;'
        + 'border:2px solid rgba(255,255,255,.85);box-shadow:0 0 0 1px rgba(0,0,0,.5);';
      const l = (this.label = document.createElement('div'));
      l.style.cssText = 'position:absolute;left:50%;top:calc(50% + 24px);transform:translateX(-50%);font:600 12px system-ui,sans-serif;'
        + 'letter-spacing:2px;color:#ffb44a;text-shadow:0 1px 2px #000;';
      root.append(c, l);
    }
    document.body.appendChild(root);
  }

  /** Per frame while the player drives `tank`. */
  update(tank) {
    if (!this.root) return;
    const game = this.game;
    // hidden behind the start screen and the menu (online the menu doesn't pause the game)
    const loading = document.getElementById('loading');
    const on = game.settings?.tankReticle !== false && !game.paused && !game.ui?.isOpen && !tank.destroyed
      && !(loading && !loading.classList.contains('done'));
    this.owner = tank;
    // the fallback crosshair is only for noUI labs; the UI may attach after this HUD was created
    if (this.cross && game.ui) { this.cross.remove(); this.label.remove(); this.cross = this.label = null; }
    this._show(on);
    if (!on) return;
    const cam = game.camera;
    const p = tank.gunAimPoint(_v);
    p.project(cam);
    const behind = p.z > 1;
    const w = window.innerWidth, h = window.innerHeight;
    const x = (p.x * 0.5 + 0.5) * w, y = (-p.y * 0.5 + 0.5) * h;
    this.gun.style.display = behind ? 'none' : '';
    this.gun.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
    if (this.label) {
      const ready = tank.reloadLeft <= 0;
      if (ready !== this._ready) {
        this._ready = ready;
        this.label.textContent = ready ? tr(game, 'hud.ready', 'READY') : tr(game, 'hud.reload', 'RELOADING');
        this.label.style.color = ready ? '#7dffa0' : '#ffb44a';
      }
    }
  }

  release(tank) {
    if (this.owner !== tank) return;
    this.owner = null;
    this._show(false);
  }

  _show(on) {
    if (on === this.visible) return;
    this.visible = on;
    this.root.style.display = on ? '' : 'none';
  }

  dispose() {
    this.root?.remove();
    huds.delete(this.game);
  }
}
