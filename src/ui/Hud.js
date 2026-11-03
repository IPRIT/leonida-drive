import { REGIONS, areaSubLabel } from '../world/regions.js';
import { icon } from './icons.js';
import { drawThumb } from './thumbs.js';

const MAP_MPP = 4; // map.webp metres per pixel
const TAPE_PX = 3; // heading tape: pixels per degree
const TAPE_W = 260;
const RADAR_W = 300, RADAR_H = 190;

// text/style setters that touch the DOM only when the value changed
export function setText(el, v) { if (el._t !== v) { el._t = v; el.textContent = v; } }
export function setShown(el, on) { if (el._s !== on) { el._s = on; el.style.display = on ? '' : 'none'; } }
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// GTA-style HUD: radar + health/armor/nitro bars, money, clock, area & vehicle names, speedometer,
// aircraft/boat instruments, notification feed, help box, big centred messages, wasted screen.
export class Hud {
  constructor(root, game, mapImage) {
    this.game = game;
    this.i18n = game.i18n;
    this.world = game.worldData;
    this.mapImage = mapImage;
    this.x0 = this.world.bounds[0];
    this.z0 = this.world.bounds[1];
    root.insertAdjacentHTML('beforeend', `
      <div id="hud">
        <div id="hud-world" class="slot" data-slot="world-overlay"></div>
        <div id="hud-tl"><div id="recovery-help" role="status" aria-live="polite"></div><div id="help"></div><div id="feed"></div></div>
        <div id="hud-tr">
          <div id="clock"></div>
          <div id="money"><span id="combo"></span><span class="v">$0</span></div>
          <div id="money-pop"></div>
          <div class="slot" data-slot="top-right-under-money"></div>
          <div id="fps"></div>
        </div>
        <div id="hud-tc"><div id="mode-tag" class="hidden"></div><div id="radio"><b class="ital"></b><small></small></div><div class="slot" data-slot="top-center"></div></div>
        <button id="menu-btn" type="button" tabindex="-1" aria-label="Menu"><i></i><i></i><i></i></button>
        <div id="radar-wrap">
          <canvas id="radar"></canvas>
          <div id="radar-hint"></div>
          <div class="bars"><div class="bar health"><i></i></div><div class="bar armor"><i></i></div><div class="bar boost"><i></i></div></div>
        </div>
        <div id="hud-br">
          <div id="vehicle-name"><canvas class="vthumb"></canvas><div><span class="n"></span><small></small></div></div>
          <div id="area"><div class="name ital"></div><div class="sub"></div></div>
          <div id="vhealth" style="display:none"><span class="vi"></span><div class="vb"><i class="e"></i><i class="b"></i></div></div>
          <div id="speedo" class="hidden">
            <div class="drift"></div>
            <div class="main"><span class="gear">N</span><span class="num">0</span><span class="unit"></span></div>
            <div id="rpm">${'<i></i>'.repeat(16)}</div>
          </div>
          <div id="instr" class="hidden">
            <div class="warn"></div>
            <div class="tape"><div class="strip"></div><i class="caret"></i></div>
            <div class="hdgv"></div>
            <div class="row">
              <div class="thr"><div class="track"><i></i></div><label></label></div>
              <div class="cell spd"><label></label><b>0</b><small></small></div>
              <div class="cell alt"><label></label><b>0</b><small></small></div>
              <div class="cell vs"><label></label><b>0</b><small></small></div>
            </div>
            <div class="chips"><span class="chip gear"></span><span class="chip flaps"></span><span class="chip anchor"></span></div>
          </div>
        </div>
        <div id="xhair" style="display:none"><i class="c"></i><div class="reload"><div class="ring"></div><span></span></div></div>
        <div id="bigmsg"><div class="big ital"></div><div class="small"></div></div>
        <div id="wasted" class="keep"><div class="band"><span class="ital"></span></div></div>
      </div>`);
    const q = (s) => root.querySelector(s);
    this.el = {
      hud: q('#hud'), radarWrap: q('#radar-wrap'), radar: q('#radar'), hint: q('#radar-hint'),
      health: q('.bar.health'), armor: q('.bar.armor'), boost: q('.bar.boost'),
      clock: q('#clock'), money: q('#money'), moneyV: q('#money .v'), pop: q('#money-pop'), fps: q('#fps'),
      mode: q('#mode-tag'), area: q('#area'), areaName: q('#area .name'), areaSub: q('#area .sub'),
      vname: q('#vehicle-name'), vnameN: q('#vehicle-name .n'), vnameS: q('#vehicle-name small'),
      speedo: q('#speedo'), num: q('#speedo .num'), gear: q('#speedo .gear'), unit: q('#speedo .unit'), drift: q('#speedo .drift'),
      rpm: [...root.querySelectorAll('#rpm i')],
      instr: q('#instr'), warn: q('#instr .warn'), strip: q('#instr .strip'), hdgv: q('#instr .hdgv'),
      thr: q('#instr .thr i'), thrL: q('#instr .thr label'),
      spd: q('#instr .spd b'), spdU: q('#instr .spd small'), spdL: q('#instr .spd label'),
      alt: q('#instr .alt b'), altU: q('#instr .alt small'), altL: q('#instr .alt label'),
      vs: q('#instr .vs b'), vsU: q('#instr .vs small'), vsL: q('#instr .vs label'),
      chipGear: q('#instr .chip.gear'), chipFlaps: q('#instr .chip.flaps'), chipAnchor: q('#instr .chip.anchor'),
      recoveryHelp: q('#recovery-help'), help: q('#help'), feed: q('#feed'), big: q('#bigmsg'), bigT: q('#bigmsg .big'), bigS: q('#bigmsg .small'),
      wasted: q('#wasted'), wastedT: q('#wasted span'),
      vh: q('#vhealth'), vhE: q('#vhealth .e'), vhB: q('#vhealth .b'),
      xhair: q('#xhair'), rel: q('#xhair .reload'), relT: q('#xhair .reload span'),
    };
    // hide the speedo/instruments until there is something to show
    this.el.speedo.classList.remove('hidden');
    this.el.speedo.style.display = 'none';
    this.el.instr.classList.remove('hidden');
    this.el.instr.style.display = 'none';
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.el.radar.width = RADAR_W * dpr;
    this.el.radar.height = RADAR_H * dpr;
    this.ctx = this.el.radar.getContext('2d');
    this.ctx.scale(dpr, dpr);
    this.radarZoom = 1;
    this.currentArea = '';
    this.areaSubRaw = '';
    this.areaTimer = 0;
    this.helpTimer = 0;
    this.bigTimer = 0;
    this.vnameTimer = 0;
    this.feed = [];
    this.playerBlips = [];
    this.route = null;
    this.waypoint = null;
    this.view = null;
    this.bars = { health: -1, armor: -1, boost: -1 };
    this.moneyShown = null;
    this.popT = -1e9;
    this.popSum = 0;
    this.districts = this.world.districts.filter((d) => d.type === 'd').concat(this.world.districts.filter((d) => d.type === 'a'));
    this.el.vh.querySelector('.vi').innerHTML = icon('car');
    this.reloadEnd = 0;
    this.reloadTotal = 0;
    this.render();
    this.watchMobile();
  }

  t(k, p) { return this.i18n.t(k, p); }

  // static texts (called again after a language change)
  render() {
    const t = (k) => this.t(k);
    this.el.hint.textContent = t('hud.mapHint');
    this.el.drift.textContent = t('hud.drift');
    this.el.wastedT.textContent = t('wasted');
    this.el.thrL.textContent = t('hud.thr');
    this.el.spdL.textContent = t('hud.spd');
    this.el.altL.textContent = t('hud.alt');
    this.el.vsL.textContent = t('hud.vs');
    this.el.chipAnchor.textContent = t('hud.anchor');
    if (this.recoveryHelpOn) this.el.recoveryHelp.innerHTML = t('help.flip');
    for (const k of ['unit', 'spdU', 'altU', 'vsU', 'chipGear', 'chipFlaps', 'warn', 'alt', 'vs']) this.el[k]._t = undefined;
    this._mDrawn = null;
    this._relReady = undefined;
    if (this.areaSubRaw) this.el.areaSub.textContent = this.subLabel(this.areaSubRaw);
    this.fontUi = this.i18n.font('ui');
    this.northLabel = t('dir.N');
    this.buildTape();
  }

  buildTape() {
    const d8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].map((k) => this.t(`dir.${k}`));
    let html = '';
    for (let d = -180; d <= 540; d += 5) {
      const x = (d + 180) * TAPE_PX;
      const n = ((d % 360) + 360) % 360;
      const major = n % 15 === 0;
      html += `<i class="${major ? 'maj' : ''}" style="left:${x}px"></i>`;
      if (n % 45 === 0) html += `<span class="card" style="left:${x}px">${d8[n / 45]}</span>`;
      else if (n % 15 === 0) html += `<span style="left:${x}px">${String(n).padStart(3, '0')}</span>`;
    }
    this.el.strip.innerHTML = html;
    this._tapeX = null;
  }

  onRadarClick(fn) { this.el.radarWrap.addEventListener('click', fn); }
  onMenuButton(fn) { this.el.hud.querySelector('#menu-btn').addEventListener('click', fn); }

  // Touch layout (body.is-mobile, set by the mobile module): health/armor bars move next to the money (top-right),
  // the radar goes top-left (CSS); the transient vehicle / area names leave the bottom-right column (the touch
  // buttons live there) for a bottom-centre strip above the utility row (#hud-bc).
  // One DOM move per class change, nothing per frame.
  watchMobile() {
    const apply = () => {
      const on = document.body.classList.contains('is-mobile');
      if (on === this._mobile) return;
      this._mobile = on;
      const hud = this.el.hud;
      const bars = this.el.radarWrap.querySelector('.bars') || hud.querySelector('#hud-tr .bars');
      if (on) hud.querySelector('#hud-tr').insertBefore(bars, hud.querySelector('#money-pop').nextSibling);
      else this.el.radarWrap.appendChild(bars);
      const br = hud.querySelector('#hud-br');
      let bc = hud.querySelector('#hud-bc');
      if (on) {
        if (!bc) { bc = document.createElement('div'); bc.id = 'hud-bc'; hud.insertBefore(bc, br); }
        bc.append(this.el.vname, this.el.area);
      } else if (bc) {
        br.insertBefore(this.el.area, br.firstChild);
        br.insertBefore(this.el.vname, this.el.area);
      }
    };
    apply();
    new MutationObserver(apply).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  // Extension slots for other modules (multiplayer): 'top-center' | 'top-right-under-money' | 'world-overlay'.
  // Returns an unmount function. The HUD hides slots together with itself (pause menu, U key, wasted).
  mount(slot, el) {
    const host = this.el.hud.querySelector(`[data-slot="${slot}"]`);
    if (!host) throw new Error(`[ui] unknown HUD slot ${slot}`);
    host.appendChild(el);
    return () => el.remove();
  }

  // extra radar blips: [{ x, z, color, heading (compass rad, optional), label }]
  setPlayerBlips(list) { this.playerBlips = Array.isArray(list) ? list : []; }
  setVisible(v) { this.el.hud.classList.toggle('off', !v); }
  get visible() { return !this.el.hud.classList.contains('off'); }
  setFps(on) { this.el.fps.style.display = on ? '' : 'none'; this.fpsOn = on; }

  showHelp(html, seconds = 8) {
    this.el.help.innerHTML = html;
    this.el.help.classList.add('show');
    this.helpTimer = seconds;
  }

  // Persistent contextual help: no repeated toast, chime or DOM writes while overturned.
  setRecoveryHelp(on) {
    on = !!on;
    if (on === this.recoveryHelpOn) return;
    this.recoveryHelpOn = on;
    this.el.recoveryHelp.innerHTML = on ? this.t('help.flip') : '';
    this.el.recoveryHelp.classList.toggle('show', on);
  }

  // big centred message (welcome, arrival)
  toast(big, small = '', seconds = 4) {
    this.el.bigT.textContent = big || '';
    this.el.bigS.textContent = small || '';
    this.el.bigS.style.display = small ? '' : 'none';
    const b = this.el.big;
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
    this.bigTimer = seconds;
  }

  // notification feed card: notify('text') or notify({ title, text, icon, color }, seconds)
  notify(opts, seconds = 5) {
    const o = typeof opts === 'string' ? { text: opts } : (opts || {});
    if (o.seconds) seconds = o.seconds;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="ic" style="--c:${esc(o.color || 'var(--pink)')}">${icon(o.icon || 'info')}</div>`
      + `<div class="tx">${o.title ? `<b>${esc(o.title)}</b>` : ''}<span>${o.html || esc(o.text)}</span></div>`;
    this.el.feed.appendChild(card);
    void card.offsetWidth;
    card.classList.add('show');
    const item = { el: card, t: seconds };
    this.feed.push(item);
    const live = this.feed.filter((f) => f.t > 0);
    if (live.length > 4) live[0].t = 0;
    return item;
  }

  // radio station popup (top centre), called by the audio module
  showRadio(name, genre = '') {
    const r = this.el.hud.querySelector('#radio');
    r.querySelector('b').textContent = name || '';
    r.querySelector('small').textContent = genre || '';
    r.classList.remove('show');
    void r.offsetWidth;
    r.classList.add('show');
    this.radioTimer = 2.8;
  }

  setVehicleThumb(src) {
    const c = this.el.vname.querySelector('.vthumb');
    const ok = !!src && drawThumb(c, src);
    c.style.display = ok ? 'block' : 'none';
  }

  showVehicleName(name, sub = '') {
    setText(this.el.vnameN, name || '');
    setText(this.el.vnameS, sub || '');
    this.el.vname.classList.add('show');
    this.vnameTimer = 4;
  }

  // tank cannon reload (event 'tank:reload'): t = seconds until ready; optional total / progress (0..1)
  // (wall-clock based: the game loop caps dt, which would slow the ring down at low frame rates)
  tankReload(p = {}) {
    const now = performance.now();
    if (Number.isFinite(p.progress)) {
      this.reloadTotal = 1;
      this.reloadEnd = now + Math.max(0, 1 - p.progress) * 1000;
      this.reloadTotal = 1;
      return;
    }
    const t = Math.max(0, +p.t || 0);
    const left = Math.max(0, ((this.reloadEnd || 0) - now) / 1000);
    if (Number.isFinite(p.total) && p.total > 0) this.reloadTotal = p.total;
    else if (!(left > 0) || t > this.reloadTotal) this.reloadTotal = t;
    this.reloadEnd = now + t * 1000;
  }

  updateReload() {
    const left = Math.max(0, ((this.reloadEnd || 0) - performance.now()) / 1000);
    const p = this.reloadTotal > 0 ? 1 - left / this.reloadTotal : 1;
    if (Math.abs(p - (this._relP ?? -1)) > 0.008 || (p >= 1) !== this._relReady) {
      this._relP = p;
      this.el.rel.style.setProperty('--p', p.toFixed(3));
    }
    const ready = p >= 1;
    if (ready !== this._relReady) {
      this._relReady = ready;
      this.el.rel.classList.toggle('ready', ready);
      this.el.relT.textContent = this.t(ready ? 'hud.ready' : 'hud.reload');
    }
  }

  // current vehicle condition next to the speedometer (damage.engine / damage.body, 0..1)
  updateVehHealth(vh) {
    const el = this.el;
    if (!!vh !== this._vhOn) { this._vhOn = !!vh; el.vh.style.display = vh ? '' : 'none'; }
    if (!vh) return;
    const e = Math.max(0, Math.min(1, vh.engine)), b = Math.max(0, Math.min(1, vh.body));
    if (Math.abs(e - (this._vhE ?? -1)) > 0.004) {
      this._vhE = e;
      el.vhE.style.transform = `scaleX(${e})`;
      el.vh.classList.toggle('low', e < 0.3);
    }
    if (Math.abs(b - (this._vhB ?? -1)) > 0.004) { this._vhB = b; el.vhB.style.transform = `scaleX(${b})`; }
    const fire = !!vh.burning;
    if (fire !== this._vhF) { this._vhF = fire; el.vh.classList.toggle('fire', fire); }
  }

  setMode(text) {
    this.el.mode.textContent = text || '';
    this.el.mode.classList.toggle('hidden', !text);
  }

  wasted(on) {
    this.el.wasted.classList.toggle('show', !!on);
    this.el.hud.classList.toggle('is-wasted', !!on);
  }

  moneyPop(amount) {
    if (!amount) return;
    const now = performance.now();
    this.popSum = now - this.popT < 1600 ? this.popSum + amount : amount;
    this.popT = now;
    const el = this.el.pop;
    el.textContent = this.i18n.money(this.popSum, { sign: true });
    el.classList.toggle('neg', this.popSum < 0);
    el.classList.remove('go');
    void el.offsetWidth;
    el.classList.add('go');
    this.el.money.classList.add('flash');
    this.moneyFlashT = 1.2;
  }

  // skill-chain multiplier next to the money (economy:combo event), hidden at ×1
  setCombo(c) {
    const el = this.el.hud.querySelector('#combo');
    const v = Math.round((c || 1) * 10) / 10;
    if (v === this._combo) return;
    const up = v > (this._combo || 1);
    this._combo = v;
    el.textContent = v > 1 ? `×${this.i18n.number(v)}` : '';
    el.classList.toggle('on', v > 1);
    el.classList.toggle('hot', v >= 3);
    if (up) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
  }

  subLabel(sub) {
    return areaSubLabel(sub, this.i18n);
  }

  areaAt(x, z) {
    const a = this.game.world3d?.areaAt?.(x, z);
    if (a) return a;
    let best = null, bd = Infinity;
    for (const pass of ['d', 'a']) {
      for (const d of this.districts) {
        if (d.type !== pass) continue;
        const k = Math.hypot(x - d.x, z - d.z) / d.r;
        if (k < 1 && k < bd) { bd = k; best = { name: d.name, sub: pass === 'd' ? d.area : 'Leonida' }; }
      }
      if (best) return best;
    }
    for (const r of REGIONS) {
      const k = Math.hypot(x - r.x, z - r.z) / r.r;
      if (k < 1 && k < bd) { bd = k; best = { name: r.name, sub: r.sub }; }
    }
    return best || { name: 'Leonida', sub: 'State of Leonida' };
  }

  setBar(name, v) {
    v = Math.max(0, Math.min(1, v || 0));
    if (Math.abs(this.bars[name] - v) < 0.002) return;
    this.bars[name] = v;
    const el = this.el[name];
    el.firstChild.style.transform = `scaleX(${v})`;
    if (name === 'health') el.classList.toggle('low', v < 0.25);
    if (name === 'armor') el.classList.toggle('empty', v <= 0.001);
  }

  // s: { x, z, heading, compass, clock, fps, health, armor, boost, money, view, units, land, air, boat, radarAlt, blips }
  update(dt, s) {
    const el = this.el;
    this.setRecoveryHelp(s.recoveryHelp);
    if (this.helpTimer > 0 && (this.helpTimer -= dt) <= 0) el.help.classList.remove('show');
    if (this.bigTimer > 0 && (this.bigTimer -= dt) <= 0) el.big.classList.remove('show');
    if (this.vnameTimer > 0 && (this.vnameTimer -= dt) <= 0) el.vname.classList.remove('show');
    if (this.moneyFlashT > 0 && (this.moneyFlashT -= dt) <= 0) el.money.classList.remove('flash');
    if (this.radioTimer > 0 && (this.radioTimer -= dt) <= 0) el.hud.querySelector('#radio').classList.remove('show');
    this.updateFeed(dt);
    // area lookup is a linear scan over districts: 4 times per second is plenty
    if ((this.areaT = (this.areaT || 0) - dt) <= 0 || !this._area) { this.areaT = 0.25; this._area = this.areaAt(s.x, s.z); }
    const a = this._area;
    if (a.name !== this.currentArea) {
      this.currentArea = a.name;
      this.areaSubRaw = a.sub;
      el.areaName.textContent = a.name;
      el.areaSub.textContent = this.subLabel(a.sub);
      el.area.classList.add('show');
      this.areaTimer = 5;
    } else if (this.areaTimer > 0 && (this.areaTimer -= dt) <= 0) el.area.classList.remove('show');
    setText(el.clock, s.clock);
    if (this.fpsOn && s.fps !== undefined) setText(el.fps, s.fps);
    // money (rolls towards the real value)
    const m = s.money || 0;
    if (this.moneyShown === null) this.moneyShown = m;
    else if (this.moneyShown !== m) {
      const d = m - this.moneyShown;
      this.moneyShown = Math.abs(d) < 1 ? m : this.moneyShown + d * Math.min(1, dt * 7);
    }
    const mr = Math.round(this.moneyShown);
    if (mr !== this._mDrawn) { this._mDrawn = mr; el.moneyV.textContent = this.i18n.money(mr); }
    this.setBar('health', s.health);
    this.setBar('armor', s.armor);
    this.setBar('boost', s.boost);
    if (s.view !== this.view) {
      this.view = s.view;
      el.speedo.style.display = s.view === 'land' ? '' : 'none';
      el.instr.style.display = s.view === 'air' || s.view === 'boat' ? '' : 'none';
      el.instr.classList.toggle('boat', s.view === 'boat');
    }
    this.updateVehHealth(s.veh);
    if (!!s.tank !== this._tank) { this._tank = !!s.tank; this.el.xhair.style.display = s.tank ? '' : 'none'; this._relReady = undefined; }
    if (s.tank) this.updateReload();
    if (s.view === 'land') this.updateSpeedo(s);
    else if (s.view === 'air' || s.view === 'boat') this.updateInstr(s);
    this.drawRadar(dt, s);
  }

  updateFeed(dt) {
    if (!this.feed.length) return;
    for (let i = this.feed.length - 1; i >= 0; i--) {
      const f = this.feed[i];
      const was = f.t;
      f.t -= dt;
      if (was > 0 && f.t <= 0) f.el.classList.remove('show');
      if (f.t < -0.45) { f.el.remove(); this.feed.splice(i, 1); }
    }
  }

  updateSpeedo(s) {
    const L = s.land, el = this.el;
    const mph = s.units === 'mph';
    setText(el.unit, this.t(mph ? 'hud.mph' : 'hud.kmh'));
    setText(el.num, String(Math.round(L.speedKmh * (mph ? 0.621371 : 1))));
    setText(el.gear, L.gear < 0 ? 'R' : L.gear === 0 ? 'N' : String(L.gear));
    const lit = Math.round(Math.min(1, L.rpmFrac) * 16);
    if (lit !== this._lit) {
      this._lit = lit;
      el.rpm.forEach((e, i) => { e.className = i < lit ? (i >= 13 ? 'on hot' : 'on') : ''; });
    }
    if (!!L.drift !== this._drift) { this._drift = !!L.drift; el.drift.classList.toggle('on', this._drift); }
  }

  updateInstr(s) {
    const el = this.el, imp = s.units === 'mph';
    const A = s.view === 'air' ? s.air : s.boat;
    // heading tape
    const h = ((s.compass % 360) + 360) % 360;
    const tx = Math.round((TAPE_W / 2 - (h + 180) * TAPE_PX) * 2) / 2;
    if (tx !== this._tapeX) { this._tapeX = tx; el.strip.style.transform = `translateX(${tx}px)`; }
    setText(el.hdgv, String(Math.round(h) % 360).padStart(3, '0') + '°');
    const thr = Math.max(-1, Math.min(1, A.thr || 0));
    if (Math.abs(thr - (this._thr ?? 9)) > 0.005) {
      this._thr = thr;
      el.thr.style.transform = `scaleY(${Math.abs(thr)})`;
      el.thr.classList.toggle('rev', thr < 0);
    }
    setText(el.spdU, this.t(imp ? 'hud.mph' : 'hud.kmh'));
    setText(el.spd, String(Math.round(A.spd * (imp ? 0.621371 : 1))));
    if (s.view === 'air') {
      setText(el.altU, this.t(imp ? 'hud.ft' : 'hud.m'));
      setText(el.alt, this.i18n.number(Math.round(A.alt * (imp ? 3.28084 : 1))));
      setText(el.vsU, this.t(imp ? 'hud.fpm' : 'hud.ms'));
      const vs = imp ? Math.round(A.vs * 196.85 / 10) * 10 : Math.round(A.vs);
      setText(el.vs, `${vs > 0 ? '▲' : vs < 0 ? '▼' : ''}${this.i18n.number(Math.abs(vs))}`);
      if (A.gear === undefined || A.gear === null) setText(el.chipGear, '');
      else setText(el.chipGear, `${this.t('hud.gear')} ${this.t(A.gear ? 'hud.gearDown' : 'hud.gearUp')}`);
      if (el.chipGear._on !== !!A.gear) { el.chipGear._on = !!A.gear; el.chipGear.classList.toggle('on', !!A.gear); }
      setShown(el.chipGear, A.gear !== undefined && A.gear !== null);
      setShown(el.chipFlaps, A.flaps !== undefined && A.flaps !== null);
      // flaps: 0..1 (workstream B) shown as a percentage, larger numbers as detents
      if (A.flaps != null) setText(el.chipFlaps, `${this.t('hud.flaps')} ${typeof A.flaps === 'number' && A.flaps <= 1 ? `${Math.round(A.flaps * 100)}%` : A.flaps}`);
      setShown(el.chipAnchor, false);
      const warn = A.stall ? this.t('hud.stall') : A.pullUp ? this.t('hud.pullUp') : '';
      setText(el.warn, warn);
    } else {
      setShown(el.chipGear, false);
      setShown(el.chipFlaps, false);
      setShown(el.chipAnchor, !!A.anchor);
      setText(el.warn, '');
    }
  }

  drawRadar(dt, s) {
    const ctx = this.ctx, W = RADAR_W, H = RADAR_H;
    const carto = this.game.cartography;
    if (carto?.drawRadar) {
      // vector map renderer (workstream H) owns the whole radar; ctx is already scaled by devicePixelRatio
      s.route = this.route;
      s.waypoint = this.waypoint;
      s.playerBlips = this.playerBlips;
      ctx.clearRect(0, 0, W, H);
      carto.drawRadar(ctx, W, H, s, dt);
      return;
    }
    const targetZoom = 1 + Math.min(1.4, (s.speedKmh || 0) / 140);
    this.radarZoom += (targetZoom - this.radarZoom) * Math.min(1, dt * 1.5);
    const mpp = 1.25 * this.radarZoom * (s.radarAlt ? 1 + s.radarAlt / 120 : 1); // metres per radar pixel
    const cx = W / 2, cy = H * 0.62;
    ctx.save();
    roundRect(ctx, 0, 0, W, H, 16);
    ctx.clip();
    ctx.fillStyle = '#2b3d52';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(cx, cy);
    ctx.rotate(s.heading);
    const rad = Math.hypot(W, H) * mpp;
    const px = (s.x - this.x0) / MAP_MPP, pz = (s.z - this.z0) / MAP_MPP;
    const r = rad / MAP_MPP;
    const sx = Math.max(0, px - r), sy = Math.max(0, pz - r);
    const ex = Math.min(this.mapImage.width, px + r), ey = Math.min(this.mapImage.height, pz + r);
    const k = MAP_MPP / mpp;
    ctx.imageSmoothingEnabled = true;
    if (ex > sx && ey > sy) ctx.drawImage(this.mapImage, sx, sy, ex - sx, ey - sy, (sx - px) * k, (sy - pz) * k, (ex - sx) * k, (ey - sy) * k);
    // GPS route
    const route = this.route;
    if (route && route.length >= 4) {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const path = () => {
        ctx.beginPath();
        for (let i = 0; i < route.length; i += 2) {
          const x = (route[i] - s.x) / mpp, y = (route[i + 1] - s.z) / mpp;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      };
      path(); ctx.strokeStyle = 'rgba(40,0,60,0.8)'; ctx.lineWidth = 7; ctx.stroke();
      path(); ctx.strokeStyle = '#c95cff'; ctx.lineWidth = 4.2; ctx.stroke();
    }
    const c = Math.cos(s.heading), sn = Math.sin(s.heading);
    // other blips (parked/abandoned vehicles)
    if (s.blips) {
      for (const b of s.blips) {
        const bx = (b.x - s.x) / mpp, by = (b.z - s.z) / mpp;
        const scrX = bx * c - by * sn, scrY = bx * sn + by * c;
        if (scrX < -cx || scrX > W - cx || scrY < -cy || scrY > H - cy) continue;
        ctx.save();
        ctx.translate(bx, by);
        ctx.rotate(-s.heading);
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(-5, -5, 10, 10);
        ctx.fillStyle = b.color || '#5cc0ff';
        ctx.fillRect(-3.5, -3.5, 7, 7);
        ctx.restore();
      }
    }
    // other players (multiplayer): heading arrow + optional label
    if (this.playerBlips?.length) {
      ctx.font = `500 11px ${this.fontUi}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      for (const b of this.playerBlips) {
        const bx = (b.x - s.x) / mpp, by = (b.z - s.z) / mpp;
        const scrX = bx * c - by * sn, scrY = bx * sn + by * c;
        const lim = clampToRect(scrX, scrY, cx - 10, cy - 10, W - cx - 10, H - cy - 10);
        const ix = lim[0] * c + lim[1] * sn, iy = -lim[0] * sn + lim[1] * c;
        ctx.save();
        ctx.translate(ix, iy);
        if (b.heading !== undefined) {
          ctx.rotate(b.heading);
          ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(5.5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5.5, 6); ctx.closePath();
          ctx.fillStyle = b.color || '#ffd23f'; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 2; ctx.stroke(); ctx.fill();
          ctx.rotate(-b.heading);
        } else blip(ctx, b.color || '#ffd23f', 5);
        if (b.label) {
          ctx.rotate(-s.heading);
          ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.strokeText(b.label, 0, -9);
          ctx.fillStyle = '#fff'; ctx.fillText(b.label, 0, -9);
        }
        ctx.restore();
      }
    }
    // waypoint blip (clamped to the rim)
    if (this.waypoint) {
      const wx = (this.waypoint.x - s.x) / mpp, wy = (this.waypoint.z - s.z) / mpp;
      const scrX = wx * c - wy * sn, scrY = wx * sn + wy * c;
      const lim = clampToRect(scrX, scrY, cx - 12, cy - 12, W - cx - 12, H - cy - 12);
      const ix = lim[0] * c + lim[1] * sn, iy = -lim[0] * sn + lim[1] * c;
      ctx.save();
      ctx.translate(ix, iy);
      ctx.rotate(-s.heading);
      blip(ctx, '#c95cff');
      ctx.restore();
    }
    ctx.restore();
    // north marker on the rim
    ctx.save();
    const dirx = Math.sin(s.heading), diry = -Math.cos(s.heading);
    const e = clampToRect(dirx * 1e4, diry * 1e4, cx - 11, cy - 11, W - cx - 11, H - cy - 11);
    ctx.translate(cx + e[0], cy + e[1]);
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.beginPath(); ctx.arc(0, 0, 9.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `500 12px ${this.fontUi}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.northLabel, 0, 1);
    ctx.restore();
    // player arrow
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.moveTo(0, -9); ctx.lineTo(7, 8); ctx.lineTo(0, 4); ctx.lineTo(-7, 8); ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fill();
    ctx.restore();
    ctx.save();
    roundRect(ctx, 1, 1, W - 2, H - 2, 15);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clampToRect(x, y, left, top, right, bottom) {
  const sx = x < 0 ? left / -x : right / Math.max(x, 1e-6);
  const sy = y < 0 ? top / -y : bottom / Math.max(y, 1e-6);
  const s = Math.min(1, sx, sy);
  return [x * s, y * s];
}

export function blip(ctx, color, r = 7) {
  ctx.beginPath();
  ctx.arc(0, 0, r + 2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
}
