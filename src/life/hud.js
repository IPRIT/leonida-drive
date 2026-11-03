// Minimal DOM overlay for life features (race panel, countdown, prompts, pop-ups, photo-mode flash).
// Reads the UI's CSS variables (src/ui/styles.css, read-only) with fallbacks so it also works in noUI labs.

const CSS = `
#life-hud { position: fixed; inset: 0; pointer-events: none; z-index: 40; color: #fff; overflow: hidden;
  font-family: var(--f-ui, Oswald, 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif); --lf-s: var(--hud-scale, 1); }
#life-hud.off { display: none; }
#life-hud .lf-shadow { text-shadow: var(--text-shadow, 0 0 2px #000, 0 2px 3px rgba(0,0,0,.9), 1px 1px 0 #000, -1px -1px 0 #000); }
#life-hud .lf-race { position: absolute; right: calc(22px * var(--lf-s)); top: 34%; display: none; min-width: calc(250px * var(--lf-s));
  transform-origin: right center; }
#life-hud .lf-race.on { display: block; animation: lf-slide .35s ease-out; }
#life-hud .lf-title { font-family: var(--f-disp, 'Russo One', 'Arial Black', sans-serif); font-weight: var(--fw-disp, 400);
  font-size: calc(17px * var(--lf-s)); letter-spacing: .08em; text-align: right; color: var(--gold, #f5c84c); margin-bottom: 4px; }
#life-hud .lf-row { display: flex; justify-content: space-between; align-items: baseline; gap: 18px; margin: 3px 0;
  padding: calc(4px * var(--lf-s)) calc(12px * var(--lf-s)); background: linear-gradient(90deg, rgba(0,0,0,0) 0%, rgba(0,0,0,.62) 28%, rgba(0,0,0,.72) 100%); }
#life-hud .lf-row b { font-weight: 500; font-size: calc(15px * var(--lf-s)); letter-spacing: .08em; color: #d9dde3; text-transform: uppercase; }
#life-hud .lf-row span { font-family: var(--f-num, 'Russo One', Oswald, sans-serif); font-size: calc(24px * var(--lf-s)); }
#life-hud .lf-row .good { color: var(--gta-green, #6ac259); } #life-hud .lf-row .bad { color: #ff5a5a; }
#life-hud .lf-big { position: absolute; left: 0; right: 0; top: 30%; text-align: center; display: none; }
#life-hud .lf-big.on { display: block; animation: lf-pop .45s cubic-bezier(.2,1.6,.4,1); }
#life-hud .lf-big h1 { margin: 0; font-family: var(--f-disp, 'Russo One', 'Arial Black', sans-serif); font-weight: var(--fw-disp, 400);
  font-size: calc(78px * var(--lf-s)); letter-spacing: .04em; color: #fff; }
#life-hud .lf-big h1.gold { color: var(--gold, #f5c84c); } #life-hud .lf-big h1.pink { color: var(--pink, #ff3fa4); }
#life-hud .lf-big h1.teal { color: var(--teal, #29f0e0); }
#life-hud .lf-big p { margin: 6px 0 0; font-size: calc(22px * var(--lf-s)); letter-spacing: .06em; }
#life-hud .lf-big p.script { font-family: var(--f-script, Yellowtail, cursive); font-size: calc(34px * var(--lf-s)); color: var(--pink, #ff3fa4); letter-spacing: 0; }
#life-hud .lf-prompt { position: absolute; left: 50%; bottom: calc(150px * var(--lf-s)); transform: translateX(-50%) translateY(6px);
  visibility: hidden; opacity: 0; transition: opacity .22s ease-out, transform .22s ease-out, visibility 0s linear .22s;
  display: flex; align-items: center; gap: calc(9px * var(--lf-s)); background: rgba(8,8,12,.8); padding: calc(9px * var(--lf-s)) calc(16px * var(--lf-s));
  border-radius: 4px; font-size: calc(17px * var(--lf-s)); letter-spacing: .03em; white-space: nowrap; border-left: 4px solid var(--pink, #ff3fa4);
  box-shadow: 0 6px 20px rgba(0,0,0,.35); }
#life-hud .lf-prompt.on { visibility: visible; opacity: 1; transform: translateX(-50%); transition: opacity .22s ease-out, transform .22s ease-out; }
#life-hud .lf-prompt b { font-weight: 500; color: #fff; }
#life-hud .lf-prompt em { font-style: normal; color: var(--gold, #f5c84c); font-family: var(--f-disp, 'Russo One', sans-serif); font-weight: var(--fw-disp, 400); letter-spacing: .05em; }
#life-hud .lf-prompt i { font-style: normal; color: #c9ced6; font-size: .9em; }
/* crisp keycap: dark bold glyph on a light cap, no text shadow, bottom edge for depth */
#life-hud .lf-key { display: inline-flex; align-items: center; justify-content: center; min-width: calc(26px * var(--lf-s)); height: calc(26px * var(--lf-s));
  padding: 0 calc(6px * var(--lf-s)); box-sizing: border-box; border-radius: 5px; background: #f7f7f5; color: #101114;
  font-family: var(--f-num, 'Russo One', 'Arial Black', sans-serif); font-weight: 700; font-size: calc(16px * var(--lf-s)); line-height: 1;
  text-shadow: none !important; border: 1px solid #fff; border-bottom: 3px solid #a3a6ad; box-shadow: 0 1px 3px rgba(0,0,0,.6); flex: none; }
#life-hud .lf-pad { width: calc(28px * var(--lf-s)); height: calc(28px * var(--lf-s)); flex: none; filter: drop-shadow(0 1px 2px rgba(0,0,0,.7)); }
#life-hud .lf-tap { position: absolute; left: 50%; bottom: calc(205px * var(--lf-s)); transform: translateX(-50%); pointer-events: auto;
  visibility: hidden; opacity: 0; transition: opacity .22s, visibility 0s linear .22s; touch-action: manipulation; }
#life-hud .lf-tap.on { visibility: visible; opacity: 1; transition: opacity .22s; }
#life-hud .lf-tap button { font-family: var(--f-disp, 'Russo One', sans-serif); font-weight: var(--fw-disp, 400); font-size: 24px; letter-spacing: .1em;
  color: #fff; background: var(--pink, #ff3fa4); border: 2px solid #fff; border-radius: 40px; padding: 14px 36px; min-width: 190px; min-height: 58px;
  box-shadow: 0 6px 22px rgba(255, 63, 164, .55), 0 2px 0 rgba(0,0,0,.4); cursor: pointer; text-shadow: none; }
#life-hud .lf-tap button:active { transform: scale(.96); }
#life-hud .lf-pop { position: absolute; left: 50%; top: calc(96px * var(--lf-s)); transform: translateX(-50%); text-align: center; display: none; }
#life-hud .lf-pop.on { display: block; animation: lf-pop .4s cubic-bezier(.2,1.6,.4,1); }
#life-hud .lf-pop .t { font-family: var(--f-disp, 'Russo One', sans-serif); font-weight: var(--fw-disp, 400); font-size: calc(20px * var(--lf-s));
  letter-spacing: .12em; color: var(--lf-c, var(--teal, #29f0e0)); }
#life-hud .lf-pop .v { font-family: var(--f-num, 'Russo One', sans-serif); font-size: calc(46px * var(--lf-s)); line-height: 1.05; }
#life-hud .lf-pop .s { font-size: calc(16px * var(--lf-s)); letter-spacing: .06em; color: #e8e8e8; }
#life-hud .lf-pop .m { color: var(--money, #72d45b); font-family: var(--f-num, 'Russo One', sans-serif); font-size: calc(22px * var(--lf-s)); }
#life-hud .lf-flash { position: absolute; inset: 0; background: #fff; opacity: 0; transition: opacity .5s ease-out; }
@keyframes lf-pop { 0% { transform: translateX(var(--lf-tx, 0)) scale(.6); opacity: 0; } 100% { transform: translateX(var(--lf-tx, 0)) scale(1); opacity: 1; } }
#life-hud .lf-pop { --lf-tx: -50%; }
@keyframes lf-slide { 0% { transform: translateX(40px); opacity: 0; } 100% { transform: none; opacity: 1; } }
`;

const KEYS = ['time', 'cp', 'best', 'delta'];

export class LifeHud {
  constructor(game) {
    this.game = game;
    if (!document.getElementById('life-hud-css')) {
      const st = document.createElement('style');
      st.id = 'life-hud-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    const root = document.createElement('div');
    root.id = 'life-hud';
    root.innerHTML = `
      <div class="lf-race lf-shadow"><div class="lf-title"></div>
        <div class="lf-row"><b data-k="time"></b><span data-v="time"></span></div>
        <div class="lf-row"><b data-k="cp"></b><span data-v="cp"></span></div>
        <div class="lf-row"><b data-k="best"></b><span data-v="best"></span></div>
        <div class="lf-row" data-row="delta"><b data-k="delta"></b><span data-v="delta"></span></div>
      </div>
      <div class="lf-big lf-shadow"><h1></h1><p></p><p class="script"></p></div>
      <div class="lf-prompt"></div>
      <div class="lf-tap"><button type="button"></button></div>
      <div class="lf-pop lf-shadow"><div class="t"></div><div class="v"></div><div class="s"></div><div class="m"></div></div>
      <div class="lf-flash"></div>`;
    (game.renderer?.domElement?.parentElement || document.body).appendChild(root);
    this.root = root;
    const q = (s) => root.querySelector(s);
    this.el = {
      race: q('.lf-race'), title: q('.lf-race .lf-title'),
      k: { time: q('[data-k=time]'), cp: q('[data-k=cp]'), best: q('[data-k=best]'), delta: q('[data-k=delta]') },
      v: { time: q('[data-v=time]'), cp: q('[data-v=cp]'), best: q('[data-v=best]'), delta: q('[data-v=delta]') },
      deltaRow: q('[data-row=delta]'),
      big: q('.lf-big'), bigH: q('.lf-big h1'), bigP: q('.lf-big p'), bigS: q('.lf-big p.script'),
      prompt: q('.lf-prompt'), tap: q('.lf-tap'), tapBtn: q('.lf-tap button'), pop: q('.lf-pop'), popT: q('.lf-pop .t'), popV: q('.lf-pop .v'), popS: q('.lf-pop .s'), popM: q('.lf-pop .m'),
      flash: q('.lf-flash'),
    };
    this._cache = new Map();
    this.bigT = 0; this.popT = 0;
    this.visible = true;
  }

  set(el, text) {
    if (this._cache.get(el) === text) return;
    this._cache.set(el, text);
    el.textContent = text;
  }

  setVisible(v) {
    if (this.visible === v) return;
    this.visible = v;
    this.root.classList.toggle('off', !v);
  }

  // race panel: null hides it; s = { title, labels:{time,cp,best,delta}, time, cp, best, delta, deltaGood }
  race(s) {
    const e = this.el;
    if (!s) { if (e.race.classList.contains('on')) e.race.classList.remove('on'); return; }
    if (!e.race.classList.contains('on')) e.race.classList.add('on');
    this.set(e.title, s.title);
    for (let i = 0; i < KEYS.length; i++) { const k = KEYS[i]; this.set(e.k[k], s.labels[k]); this.set(e.v[k], s[k] ?? ''); }
    e.deltaRow.style.display = s.delta ? '' : 'none';
    const cls = s.deltaGood === undefined ? '' : s.deltaGood ? 'good' : 'bad';
    if (e.v.delta.className !== cls) e.v.delta.className = cls;
  }

  big(title, sub = '', script = '', seconds = 2, color = '') {
    const e = this.el;
    e.bigH.textContent = title;
    e.bigH.className = color;
    e.bigP.textContent = sub;
    e.bigS.textContent = script;
    e.big.classList.remove('on');
    void e.big.offsetWidth; // restart the animation
    e.big.classList.add('on');
    this.bigT = seconds;
  }

  prompt(html) {
    const e = this.el;
    if (!html) { if (e.prompt.classList.contains('on')) e.prompt.classList.remove('on'); this._cache.delete(e.prompt); return; }
    if (this._cache.get(e.prompt) !== html) { this._cache.set(e.prompt, html); e.prompt.innerHTML = html; }
    if (!e.prompt.classList.contains('on')) e.prompt.classList.add('on');
  }

  // big tappable action button for touch devices (null hides it)
  tapButton(label, fn) {
    const e = this.el;
    this._tapFn = fn || null;
    if (!label || !fn) { if (e.tap.classList.contains('on')) e.tap.classList.remove('on'); return; }
    this.set(e.tapBtn, label);
    if (!this._tapBound) {
      this._tapBound = true;
      e.tapBtn.addEventListener('pointerup', (ev) => { ev.preventDefault(); ev.stopPropagation(); this._tapFn?.(); });
    }
    if (!e.tap.classList.contains('on')) e.tap.classList.add('on');
  }

  pop(title, value, sub = '', moneyText = '', seconds = 3, color = '') {
    const e = this.el;
    e.popT.textContent = title; e.popV.textContent = value; e.popS.textContent = sub; e.popM.textContent = moneyText;
    e.pop.style.setProperty('--lf-c', color || '');
    e.pop.classList.remove('on');
    void e.pop.offsetWidth;
    e.pop.classList.add('on');
    this.popT = seconds;
  }

  flash() {
    const f = this.el.flash;
    f.style.transition = 'none';
    f.style.opacity = '0.85';
    void f.offsetWidth;
    f.style.transition = 'opacity .55s ease-out';
    f.style.opacity = '0';
  }

  update(dt) {
    if (this.bigT > 0 && (this.bigT -= dt) <= 0) this.el.big.classList.remove('on');
    if (this.popT > 0 && (this.popT -= dt) <= 0) this.el.pop.classList.remove('on');
  }

  dispose() { this.root.remove(); }
}

// device-aware input glyphs for prompts
export function keycap(label) { return `<span class="lf-key">${esc(label)}</span>`; }

// gamepad d-pad glyph with one highlighted arm ('up' | 'down' | 'left' | 'right')
export function padGlyph(dir = 'up') {
  const arm = { up: 'M10 2h8v9h-8z', down: 'M10 17h8v9h-8z', left: 'M2 10h9v8H2z', right: 'M17 10h9v8h-9z' }[dir];
  return `<svg class="lf-pad" viewBox="0 0 28 28" aria-label="D-pad ${dir}"><path d="M10 2h8v8h8v8h-8v8h-8v-8H2v-8h8z" fill="#2a2c33" stroke="#e8e8ea" stroke-width="1.2"/><path d="${arm}" fill="#ffd23a"/></svg>`;
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
