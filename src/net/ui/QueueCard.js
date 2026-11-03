// "The server is full" card: place in line, estimated wait, and the two ways out (singleplayer instead / leave the
// line). Used by the start screen (full card) and in the game after a reconnect to a full server (compact, while the
// game goes on offline). Plain DOM, styles injected once, no per-frame work: it only changes when a QUEUE arrives
// (≤ 1 per 4 s) and a 1 s timer counts the estimate down.

const CSS = `
.ldq{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:60;width:min(440px,90vw);padding:22px 26px 20px;
  background:rgba(12,4,24,.82);border:1px solid rgba(255,255,255,.18);border-radius:6px;box-shadow:0 18px 60px rgba(0,0,0,.55);
  color:#fff;text-align:center;font-family:var(--f-ui,'Oswald',sans-serif);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);pointer-events:auto}
.ldq.compact{top:auto;bottom:auto;top:64px;transform:translateX(-50%);width:min(380px,92vw);padding:14px 18px}
.ldq h3{margin:0 0 6px;font:500 15px/1.2 var(--f-ui,'Oswald',sans-serif);letter-spacing:.18em;text-transform:uppercase;color:var(--gold,#ffd36b)}
.ldq .pos{font-family:var(--f-disp,'Russo One',sans-serif);font-size:38px;line-height:1.15;letter-spacing:.02em;text-shadow:0 2px 0 #2a0b3d}
.ldq.compact .pos{font-size:24px}
.ldq .eta{font-size:18px;opacity:.95;margin-top:2px}
.ldq .info{font-size:13px;opacity:.7;margin-top:8px;letter-spacing:.04em}
.ldq .keep{font-size:13px;opacity:.75;margin-top:10px;line-height:1.35}
.ldq .row{display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap}
.ldq button{font:500 15px var(--f-ui,'Oswald',sans-serif);letter-spacing:.08em;padding:9px 16px;border-radius:3px;cursor:pointer;
  color:#fff;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.3)}
.ldq button.pri{color:#1a0826;background:linear-gradient(90deg,#ffd36b,#ff8a3d);border-color:transparent}
.ldq button:focus-visible,.ldq button.focus{outline:2px solid var(--teal,#29f0e0);outline-offset:2px}
.ldq .bar{height:3px;margin-top:14px;background:rgba(255,255,255,.12);overflow:hidden;border-radius:2px}
.ldq .bar i{display:block;height:100%;width:30%;background:linear-gradient(90deg,var(--pink,#ff4fa0),var(--orange,#ff8a3d));animation:ldqbar 1.6s ease-in-out infinite}
@keyframes ldqbar{0%{transform:translateX(-100%)}100%{transform:translateX(340%)}}
.ldq.admit .pos{color:var(--teal,#29f0e0)}
`;
let styled = false;

/**
 * opts: { t(key, params) (net namespace), onSingle(), onCancel(), compact, num(n) }.
 * Returns { el, update(queue), admitted(), remove(), focusNext(), activate() }.
 */
export function createQueueCard(parent, opts) {
  if (!styled && typeof document !== 'undefined') {
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    styled = true;
  }
  const t = opts.t, num = opts.num || ((n) => Math.round(n).toLocaleString());
  const el = document.createElement('div');
  el.className = `ldq${opts.compact ? ' compact' : ''}`;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `<h3></h3><div class="pos"></div><div class="eta"></div><div class="info"></div>${opts.compact ? '' : '<div class="keep"></div>'}
    <div class="row"><button class="single"></button><button class="cancel"></button></div><div class="bar"><i></i></div>`;
  parent.appendChild(el);
  const $ = (s) => el.querySelector(s);
  const bSingle = $('.single'), bCancel = $('.cancel');
  bSingle.addEventListener('click', () => opts.onSingle?.());
  bCancel.addEventListener('click', () => opts.onCancel?.());
  let q = null, recvAt = 0, timer = null, focus = 0;
  const btns = [bSingle, bCancel];
  const label = () => {
    $('h3').textContent = t('queueTitle');
    bSingle.textContent = t('queueSingle');
    bCancel.textContent = t('queueCancel');
    const keep = $('.keep');
    if (keep) keep.textContent = t('queueKeep');
    if (!q) return;
    $('.pos').textContent = t('queuePos', { pos: num(q.position) });
    const left = q.etaSec == null ? null : Math.max(0, q.etaSec - (performance.now() - recvAt) / 1000);
    $('.eta').textContent = left == null ? t('queueEtaUnknown') : left < 60 ? t('queueEtaSoon') : t('queueEta', { min: num(Math.ceil(left / 60)) });
    $('.info').textContent = opts.compact ? t('queueMid') : t('queueInfo', { waiting: num(q.waiting), capacity: num(q.capacity) });
  };
  const setFocus = (i) => { focus = (i + btns.length) % btns.length; btns.forEach((b, k) => b.classList.toggle('focus', k === focus)); };
  return {
    el,
    update(queue) {
      if (!queue) return;
      q = queue; recvAt = queue.at || performance.now();
      el.classList.remove('admit');
      label();
      if (!timer) timer = setInterval(label, 1000);
    },
    relabel: label,
    admitted() {
      clearInterval(timer); timer = null;
      el.classList.add('admit');
      $('.pos').textContent = t('queueAdmit');
      $('.eta').textContent = ''; $('.info').textContent = '';
    },
    focusNext(d = 1) { setFocus(focus + d); },
    activate() { btns[focus]?.click(); },
    remove() { clearInterval(timer); timer = null; el.remove(); },
  };
}
