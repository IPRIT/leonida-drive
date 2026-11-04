import './styles.css';
import { getI18n } from '../i18n/index.js';
import { VERSION_LABEL } from '../core/version.js';
import { mapSourceLink, MAP_SOURCE } from './icons.js';
import { COLLECTIBLES, incomeScale } from '../economy/rules.js';
import { PRICE_OVERRIDES } from '../economy/price-overrides.js';
import { detectDevice, urlFlag } from '../mobile/detect.js';
import { NET_STRINGS } from '../net/i18n.js';
import { pollStatus, netGate } from '../net/status.js';
import { createQueueCard } from '../net/ui/QueueCard.js';

// Loading tips: keys tip.1 … tip.<TIPS> in the locales. Keep them true to the current game (docs/ECONOMY.md, controls).
const TIPS = 18;
const SANDBOX_TIPS = new Set([1, 3, 7]); // map teleport, World tab (weather / time): singleplayer only
const ONLINE_TIPS = new Set([14]); // Tab player list: online only
// keyboard / mouse wording (M, Esc, Space, E, Shift, G, Tab, V/P, double-click): not shown on touch screens
const KEYBOARD_TIPS = new Set([1, 2, 3, 4, 8, 10, 13, 14, 15]);

// same rule as the mobile module (touch controls on: ?touch=1, or a touch-first device)
function touchFirst() {
  try { const f = urlFlag('touch'); return f ?? detectDevice().touch; } catch { return false; }
}

// same rule as Game.detectMode (the game object does not exist yet)
function loadingMode() {
  try {
    const q = new URLSearchParams(location.search).get('mode');
    if (q === 'single' || q === 'online') return q;
    const v = localStorage.getItem('leonida.mode');
    if (v === 'single' || v === 'online') return v;
  } catch { /* ignore */ }
  return 'online';
}

// the other mode: remembered (game.switchMode's key) and started right away after the reload
function switchTo(mode) {
  try { localStorage.setItem('leonida.mode', mode); sessionStorage.setItem('leonida.autostart', mode); } catch { /* private mode */ }
  const url = new URL(location.href);
  url.searchParams.delete('mode');
  location.replace(url.toString());
}

// Synthwave sunset loading screen with original palm silhouettes. Texts follow the detected language;
// a small selector lets the player switch it before the game starts.
export function showLoading(root) {
  const i18n = getI18n();
  const t = (k, p) => i18n.t(k, p);
  try { i18n.register?.('net', NET_STRINGS); } catch { /* older i18n */ }
  const tn = (k, p) => t(`net.${k}`, p);
  // multiplayer head count for the start choice: GET /status every 10 s while this screen is up
  let mpStatus;
  const stopPoll = pollStatus((st) => { mpStatus = st; renderChoice?.(); });
  let renderChoice = null;
  const palm = (x, h, lean, s) => {
    const top = { x: x + lean, y: 100 - h };
    const fronds = [-70, -40, -12, 15, 40, 72, 100, 140, 170].map((a) => {
      const r = (a * Math.PI) / 180;
      const L = 9 * s;
      const ex = top.x + Math.cos(r) * L, ey = top.y + Math.sin(r) * L * 0.55 + L * 0.35;
      const cx = top.x + Math.cos(r) * L * 0.55, cy = top.y - L * 0.25;
      return `<path d="M${top.x},${top.y} Q${cx},${cy} ${ex},${ey} Q${cx},${cy + 1.6 * s} ${top.x},${top.y + 0.6}" />`;
    }).join('');
    return `<path d="M${x - 0.7 * s},100 Q${x + lean * 0.2},${100 - h * 0.6} ${top.x - 0.3},${top.y} L${top.x + 0.3},${top.y} Q${x + lean * 0.25 + 0.8 * s},${100 - h * 0.6} ${x + 0.7 * s},100 Z"/>${fronds}`;
  };
  root.insertAdjacentHTML('beforeend', `
    <div id="loading">
      <div class="sun"></div>
      <svg class="palms left" viewBox="0 0 48 100" preserveAspectRatio="xMinYMax meet" fill="#14051f">
        ${palm(12, 72, 9, 1.4)}${palm(26, 52, -5, 1.1)}
      </svg>
      <svg class="palms right" viewBox="108 0 52 100" preserveAspectRatio="xMaxYMax meet" fill="#14051f">
        ${palm(134, 78, -11, 1.5)}${palm(147, 55, 4, 1.1)}${palm(118, 40, 6, 0.9)}
      </svg>
      <div class="grid"></div>
      <div class="logo"><div class="l1">LEONIDA</div><div class="l2">drive</div><div class="l3">LOW-POLY · VICE CITY</div></div>
      <div class="ltop"><span class="modebadge"></span>
      <label class="langsel"><svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19"/><path d="M12 2.5a14.5 14.5 0 0 1 0 19 14.5 14.5 0 0 1 0-19z"/></svg><select></select></label></div>
      <div class="tip"></div>
      <div class="lcredits"></div>
      <div class="progress"><div class="spinner"></div><span class="ptext"></span></div>
      <div class="pbar"></div>
    </div>`);
  const el = root.querySelector('#loading');
  const tip = el.querySelector('.tip');
  const sel = el.querySelector('select');
  const mode = loadingMode();
  const touch = touchFirst();
  const tips = [...Array(TIPS).keys()].map((i) => i + 1)
    .filter((n) => !(mode === 'online' ? SANDBOX_TIPS : ONLINE_TIPS).has(n) && !(touch && KEYBOARD_TIPS.has(n)));
  let ti = Math.floor(Math.random() * tips.length);
  let failed = false;
  const showTip = () => {
    if (failed) return;
    const params = { amount: i18n.money(COLLECTIBLES.each * incomeScale('collectible', mode === 'online')), price: i18n.money(mode === 'online' ? 50000 : PRICE_OVERRIDES.tank?.price ?? 1500000) };
    tip.innerHTML = `<b>${t('load.tip')}</b> ${t(`tip.${tips[ti % tips.length]}`, params)}`;
  };
  const render = () => {
    showTip();
    const mb = el.querySelector('.modebadge');
    mb.className = `modebadge ${mode}`;
    mb.innerHTML = `<i></i>${t(mode === 'online' ? 'gm.badge.online' : 'gm.badge.single')}`;
    const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    el.querySelector('.lcredits').innerHTML = `${esc(t('credits.mapSourceShort'))} — ${mapSourceLink(MAP_SOURCE.host)} · ${esc(t('credits.disclaimer'))} · <b class="age">18+</b> · <span class="ver">${esc(VERSION_LABEL)}</span>`;
    const pt = el.querySelector('.ptext');
    if (pt) pt.textContent = t('load.loading');
    renderChoice?.();
    const auto = i18n.languages.find((l) => l.code === i18n.autoLang);
    sel.innerHTML = [`<option value="auto">${t('set.auto')} · ${auto?.name ?? ''}</option>`, ...i18n.languages.map((l) => `<option value="${l.code}">${l.name}</option>`)].join('');
    sel.value = i18n.pref;
  };
  render();
  const offLang = i18n.onChange(render);
  sel.addEventListener('change', () => i18n.setLang(sel.value));
  sel.addEventListener('keydown', (e) => e.stopPropagation());
  const tipTimer = setInterval(() => { ti++; showTip(); }, 5000);
  return {
    progress(p, text) {
      el.querySelector('.pbar').style.width = `${Math.round(p * 100)}%`;
      if (text) el.querySelector('.ptext').textContent = text.toUpperCase();
    },
    // Start choice: Singleplayer or Multiplayer · N online (the loaded mode is preselected; picking the other one
    // reloads into it and starts at once). Multiplayer on a full server shows the place in line and starts when it
    // is our turn. Keyboard (arrows / Tab, Enter / Space, Esc), gamepad (D-pad / stick, A, B) and touch.
    waitStart(onStart) {
      return new Promise((resolve) => {
        el.querySelector('.progress')?.remove();
        const box = document.createElement('div');
        box.className = 'startbox';
        box.innerHTML = `<button class="choice" data-m="single"><b></b><small></small></button><button class="choice" data-m="online"><b></b><small></small></button>`;
        el.appendChild(box);
        const btn = { single: box.querySelector('[data-m=single]'), online: box.querySelector('[data-m=online]') };
        let sel = mode, card = null, waiting = false, done = false, waitT = null;
        const client = () => netGate.client;
        renderChoice = () => {
          for (const m of ['single', 'online']) btn[m].classList.toggle('sel', m === sel);
          btn.single.querySelector('b').textContent = tn('startSingle');
          btn.single.querySelector('small').textContent = '';
          btn.online.querySelector('b').textContent = tn('startMulti');
          const c = client(), q = c?.status === 'queued' ? c.queue : null;
          let sub;
          if (waiting) sub = tn('connecting');
          else if (q) sub = tn('queuePill', { pos: i18n.number?.(q.position) ?? q.position });
          else if (mpStatus) sub = tn('online', { count: i18n.number?.(mpStatus.online) ?? mpStatus.online }) + (mpStatus.queue ? ` · ${tn('startWaiting', { count: i18n.number?.(mpStatus.queue) ?? mpStatus.queue })}` : '');
          // no /status (older server, blocked): the live connection still tells us whether multiplayer works
          else if (c?.status === 'online') sub = tn('online', { count: i18n.number?.(c.global?.online ?? 1) ?? (c.global?.online ?? 1) });
          else if (mpStatus === undefined || c?.status === 'connecting') sub = '…';
          else sub = tn('offline').toLowerCase();
          btn.online.querySelector('small').textContent = sub;
          card?.relabel?.();
        };
        const finish = () => {
          if (done) return;
          done = true;
          window.removeEventListener('keydown', key);
          clearInterval(padTimer);
          clearTimeout(waitT);
          offGate();
          stopPoll();
          card?.remove();
          onStart?.();
          el.classList.add('done');
          clearInterval(tipTimer);
          offLang();
          setTimeout(() => el.remove(), 1200);
          resolve();
        };
        const hideCard = () => { card?.remove(); card = null; box.style.visibility = ''; };
        const showCard = (q) => {
          if (!card) {
            box.style.visibility = 'hidden';
            card = createQueueCard(el, {
              t: tn, num: (n) => i18n.number?.(n) ?? String(n),
              onSingle: () => switchTo('single'),
              onCancel: () => { client()?.leaveQueue(); hideCard(); renderChoice(); },
            });
          }
          card.update(q);
        };
        // multiplayer: in now, in line, or (unreachable / another version) the graceful offline game
        const multi = () => {
          if (mode !== 'online') { switchTo('online'); return; }
          const c = client();
          if (!c || c.status === 'online' || c.status === 'offline' || c.status === 'kicked') { finish(); return; }
          if (c.status === 'idle') c.rejoin(); // left the line before: a new place at the back
          if (c.status === 'queued') { showCard(c.queue); return; }
          waiting = true; // connecting: decide on the next status change (or start offline after a while)
          renderChoice();
          clearTimeout(waitT);
          waitT = setTimeout(() => { if (waiting) { waiting = false; finish(); } }, 6000);
        };
        const offGate = netGate.on((c) => {
          if (done || !c) return;
          if (c.status === 'queued' && (card || waiting)) { waiting = false; showCard(c.queue); }
          else if (c.status === 'connecting' && card) card.admitted(); // ADMIT: the WELCOME follows
          else if (c.status === 'online' && (card || waiting)) {
            waiting = false;
            if (card) { card.admitted(); setTimeout(finish, 700); } else finish();
          } else if ((c.status === 'offline' || c.status === 'kicked') && waiting) { waiting = false; finish(); }
          else if ((c.status === 'offline' || c.status === 'reconnecting') && card) hideCard();
          renderChoice();
        });
        const pick = (m) => {
          sel = m; renderChoice();
          try { localStorage.setItem('leonida.mode', m); } catch { /* private mode */ } // preselected next time
          if (m === 'single') { if (mode === 'single') finish(); else switchTo('single'); } else multi();
        };
        btn.single.addEventListener('click', () => pick('single'));
        btn.online.addEventListener('click', () => pick('online'));
        const key = (e) => {
          if (card) {
            if (e.code === 'Escape') { e.preventDefault(); card.el.querySelector('.cancel').click(); }
            else if (/^Arrow|^Tab$/.test(e.code)) { e.preventDefault(); card.focusNext(e.code === 'ArrowLeft' || e.code === 'ArrowUp' || e.shiftKey ? -1 : 1); }
            else if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); card.activate(); }
            return;
          }
          if (/^Arrow|^Tab$/.test(e.code)) { e.preventDefault(); sel = sel === 'single' ? 'online' : 'single'; renderChoice(); btn[sel].focus({ preventScroll: true }); }
          else if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); pick(sel); }
        };
        window.addEventListener('keydown', key);
        // gamepad: D-pad / left stick switches, A picks (or presses the focused card button), B leaves the line
        let padPrev = 0;
        const padTimer = setInterval(() => {
          const pad = [...(navigator.getGamepads?.() || [])].find(Boolean);
          if (!pad) return;
          const ax = pad.axes?.[1] ?? 0, ay = pad.axes?.[0] ?? 0, b = (i) => !!pad.buttons?.[i]?.pressed;
          const bits = (b(0) ? 1 : 0) | (b(1) ? 2 : 0) | (b(12) || b(14) || ax < -0.6 || ay < -0.6 ? 4 : 0) | (b(13) || b(15) || ax > 0.6 || ay > 0.6 ? 8 : 0);
          const down = bits & ~padPrev;
          padPrev = bits;
          if (!down) return;
          if (card) {
            if (down & 1) card.activate(); else if (down & 2) card.el.querySelector('.cancel').click(); else card.focusNext(down & 4 ? -1 : 1);
            return;
          }
          if (down & 12) { sel = sel === 'single' ? 'online' : 'single'; renderChoice(); } else if (down & 1) pick(sel);
        }, 100);
        renderChoice();
        btn[sel].focus({ preventScroll: true });
        // picked the other mode on the previous page: start right away (no second click)
        let auto = null;
        try { auto = sessionStorage.getItem('leonida.autostart'); sessionStorage.removeItem('leonida.autostart'); } catch { /* private mode */ }
        if (auto === mode) pick(mode);
      });
    },
    error(msg) {
      failed = true;
      stopPoll();
      tip.innerHTML = `<b style="color:#ff6b6b">${t('load.error')}</b><br><code style="font-size:12px;white-space:pre-wrap">${String(msg).replace(/</g, '&lt;').slice(0, 1200)}</code>`;
      clearInterval(tipTimer);
    },
  };
}
