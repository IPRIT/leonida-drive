import * as THREE from 'three';
import { Events } from './events.js';
import { GLOBAL_UNIFORMS } from './globals.js';

// Capabilities available in online mode. Everything else (weather, time, money, teleport, timeScale) is sandbox-only.
const ONLINE_CAPS = new Set(['vehicleSpawn', 'freeCam', 'waypoint', 'photo']);

// ?mode=single|online overrides the stored choice; online is the default.
function detectMode() {
  try {
    const q = new URLSearchParams(location.search).get('mode');
    if (q === 'single' || q === 'online') return q;
    const s = localStorage.getItem('leonida.mode');
    if (s === 'single' || s === 'online') return s;
  } catch { /* non-browser or private mode */ }
  return 'online';
}

// Shared game context + module registry + loop phases (see docs/ARCHITECTURE.md).
export class Game {
  constructor() {
    this.THREE = THREE;
    this.events = new Events();
    this.uniforms = GLOBAL_UNIFORMS;
    this.modules = [];
    this.time = 0;
    this.frame = 0;
    this.paused = false;
    this.settings = {};
    this._settingHandlers = new Map();
    this.mode = detectMode();
  }

  get online() { return this.mode === 'online'; }

  // Capability gate: sandbox controls (weather, time, money, teleport, time scale) exist only in singleplayer.
  // Online play allows only choosing a vehicle (rate-limited by the server).
  can(cap) {
    if (this.mode !== 'online') return true;
    return ONLINE_CAPS.has(cap);
  }

  // Persists the choice and reloads into the selected mode ('online' | 'single').
  switchMode(mode) {
    if (mode !== 'online' && mode !== 'single') return;
    try { localStorage.setItem('leonida.mode', mode); } catch { /* private mode */ }
    const url = new URL(location.href);
    url.searchParams.delete('mode');
    location.replace(url.toString());
  }

  register(module, order = 0) {
    if (!module) return module;
    module.__order = order;
    this.modules.push(module);
    this.modules.sort((a, b) => a.__order - b.__order);
    return module;
  }

  unregister(module) {
    const i = this.modules.indexOf(module);
    if (i >= 0) this.modules.splice(i, 1);
  }

  // setting handlers: modules subscribe to setting changes
  onSetting(key, fn) {
    let l = this._settingHandlers.get(key);
    if (!l) this._settingHandlers.set(key, (l = []));
    l.push(fn);
  }

  applySetting(key, value) {
    this.settings[key] = value;
    for (const fn of this._settingHandlers.get(key) || []) fn(value, this);
    this.events.emit('setting', { key, value });
    try { localStorage.setItem('leonida.settings', JSON.stringify(this.settings)); } catch { /* private mode */ }
  }

  fixedUpdate(dt) { for (const m of this.modules) m.fixedUpdate?.(dt, this); }
  postStep(dt) { for (const m of this.modules) m.postStep?.(dt, this); }
  update(dt, alpha) { for (const m of this.modules) m.update?.(dt, this, alpha); }
  lateUpdate(dt) { for (const m of this.modules) m.lateUpdate?.(dt, this); }
}
