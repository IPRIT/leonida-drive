// Pause-menu performance bench (dev tool: nothing in the game imports this file, it is not bundled).
// Run in the live game (dev server, after PLAY), from the console or an automation tool:
//   const { runMenuBench } = await import('/src/ui/menu-bench.js');
//   const r = await runMenuBench();          // ~30-60 s, opens/closes the menu, cycles every tab twice
//   console.table(r.rows); r.summary
// Reload the page before a run to also get honest "first open" / "first visit" numbers.
//
// Metrics (ms unless noted):
//   js      synchronous JS of the action (open / tab switch / click / hover handler)
//   layout  style recalc + layout forced right after the action (what the next frame would pay anyway)
//   paint   input → end of the main-thread work of the first frame that shows the result (rAF → style → paint)
//   html    characters assigned through innerHTML by the action (rebuild scope; garbage + parse cost proxy)
//   frames  rAF interval while the menu idles on a tab: mean / p95 / max, plus loop CPU ms (ui.update + scene render)
//   longTasks / loaf   PerformanceObserver 'longtask' and 'long-animation-frame' entries after the first open
const now = () => performance.now();
const raf = () => new Promise((r) => requestAnimationFrame(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// resolves at the end of the next rendered frame (rAF callbacks → style → layout → paint → this task)
const afterPaint = () => new Promise((r) => requestAnimationFrame(() => postTask(r)));
function postTask(r) { const c = new MessageChannel(); c.port1.onmessage = () => r(now()); c.port2.postMessage(0); }
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

function key(code) {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
}

export async function runMenuBench(opts = {}) {
  const g = window.__leonida;
  if (!g?.ui?.menu) throw new Error('game not running (click PLAY first)');
  const ui = g.ui, menu = ui.menu;
  const quick = !!opts.quick; // shorter run (3 opens, short idle samples, fewer clicks): fits a foreground window
  const idleMs = opts.idleMs ?? (quick ? 700 : 1500);
  const rows = [];
  const frames = [];
  let throttled = 0;

  // ---- instrumentation ----
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  let html = 0, htmlWrites = 0;
  Object.defineProperty(Element.prototype, 'innerHTML', {
    configurable: true, get: desc.get, set(v) { html += String(v).length; htmlWrites++; desc.set.call(this, v); },
  });
  const longTasks = [], loafs = [];
  const obs = [];
  try {
    const o1 = new PerformanceObserver((l) => longTasks.push(...l.getEntries())); o1.observe({ type: 'longtask' }); obs.push(o1);
  } catch { /* unsupported */ }
  try {
    const o2 = new PerformanceObserver((l) => loafs.push(...l.getEntries())); o2.observe({ type: 'long-animation-frame' }); obs.push(o2);
  } catch { /* unsupported */ }

  // wraps a menu method: js + forced layout + (when called from the game loop) the end of that frame
  let last = null, busy = false;
  const restore = [];
  const probe = (obj, name) => {
    const orig = obj[name];
    obj[name] = function (...a) {
      if (busy) return orig.apply(this, a);
      busy = true;
      const h0 = html, t0 = now();
      try { return orig.apply(this, a); } finally {
        const t1 = now();
        void document.body.offsetHeight;
        const t2 = now();
        busy = false;
        const rec = { name, t0, js: t1 - t0, layout: t2 - t1, html: html - h0, paint: null };
        rec.painted = new Promise((res) => postTask((t) => { rec.paint = t; res(t); }));
        last = rec;
      }
    };
    restore.push(() => { obj[name] = orig; });
  };
  probe(menu, 'show');
  probe(menu, 'select');
  probe(menu, 'hide');

  const waitRec = async (name, t0, maxFrames = 120) => {
    for (let i = 0; i < maxFrames; i++) {
      if (last && last.name === name && last.t0 >= t0) { await last.painted; return last; }
      await raf();
    }
    return null;
  };
  // frame-gap watcher: a paint latency that spans a > 200 ms gap between frames (tab in the background, window
  // occluded) is not a measurement of the menu — it is reported as null and counted in summary.invalid
  const gaps = [];
  let watch = true, prevF = now();
  (function tick(t) { if (!watch) return; if (t - prevF > 200) gaps.push([prevF, t]); prevF = t; requestAnimationFrame(tick); })(prevF);
  const valid = (a, b) => !gaps.some(([s, e]) => e > a && s < b);
  let invalid = 0;
  const lat = (t0, tp) => { if (tp == null) return null; if (!valid(t0, tp)) { invalid++; return null; } return r1(tp - t0); };
  const push = (kind, label, rec, t0, extra = {}) => {
    rows.push({ kind, label, js: r1(rec?.js), layout: r1(rec?.layout), paint: lat(t0, rec?.paint), html: rec?.html ?? null, ...extra });
  };

  // frame sampling while idle on the current tab
  const sampleFrames = async (label, ms = idleMs) => {
    const dts = [];
    const h0 = html, w0 = htmlWrites;
    let prev = await raf(), cpu = 0, gpu = 0, n = 0;
    const end = now() + ms;
    while (now() < end) {
      const t = await raf();
      dts.push(t - prev);
      prev = t;
      const s = g.render?.stats?.();
      if (s) { cpu += s.cpuMs || 0; gpu += s.gpuMs || 0; n++; }
    }
    throttled += dts.filter((d) => d > 200).length; // > 200 ms frames: the tab was in the background (excluded)
    const ok = dts.filter((d) => d <= 200);
    frames.push({
      label, mean: ok.length ? r1(ok.reduce((a, b) => a + b, 0) / ok.length) : null, p95: r1(pct(ok, 0.95)), max: ok.length ? r1(Math.max(...ok)) : null, n: ok.length,
      loopCpu: r1(cpu / Math.max(1, n)), gpu: r1(gpu / Math.max(1, n)), htmlPerS: Math.round((html - h0) / (ms / 1000)), writesPerS: r1((htmlWrites - w0) / (ms / 1000)),
      dom: document.getElementsByTagName('*').length,
    });
  };

  try {
    const settle = async (n = 20) => { for (let i = 0; i < n; i++) await raf(); };
    if (ui.isOpen) { ui.close(); await settle(); }
    await sampleFrames('game (menu closed)');

    // ---- open (Esc) — first, then repeats ----
    const firstDirty = menu.tabs.filter((t) => t.dirty).length;
    for (let i = 0; i < (opts.opens ?? (quick ? 3 : 4)); i++) {
      if (ui.isOpen) { ui.close(); await settle(); }
      const t0 = now();
      key('Escape');
      const rec = await waitRec('show', t0);
      push('open', `${i === 0 ? 'first ' : ''}open (Esc) → ${menu.tab.id}${i === 0 ? ` [${firstDirty} dirty tabs]` : ''}`, rec, t0);
      await settle(10);
    }
    const tFirstOpenDone = now();

    // ---- tab switch with E: first visits, then repeats ----
    const tabs = menu.visibleTabs().map((t) => t.id);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < tabs.length; i++) {
        const from = menu.tab.id;
        const t0 = now();
        key('KeyE');
        const rec = await waitRec('select', t0);
        push(pass ? 'tab (repeat)' : 'tab (first)', `E: ${from} → ${menu.tab.id}`, rec, t0);
        await settle(6);
        if (pass === 0) await sampleFrames(`idle on ${menu.tab.id}`);
      }
    }
    // ---- tab switch by clicking the tab buttons ----
    for (const id of tabs) {
      const b = menu.tabsEl.querySelector(`[data-tab="${id}"]`);
      if (!b || menu.tab.id === id) continue;
      const t0 = now();
      b.click();
      const rec = last && last.t0 >= t0 ? last : null;
      const tp = await afterPaint();
      push('tab (click)', `click ${id}`, rec, t0, { paint: lat(t0, tp) });
      await settle(4);
    }

    // ---- clicks inside tabs (visual response) ----
    const click = async (tab, sel, label) => {
      if (menu.tab.id !== tab) { menu.select(tab); await settle(6); }
      const el = menu.tab.el.querySelector(sel);
      if (!el) return;
      const h0 = html, t0 = now();
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      const t1 = now();
      void document.body.offsetHeight;
      const t2 = now();
      const tp = await afterPaint();
      rows.push({ kind: 'click', label: `${tab}: ${label}`, js: r1(t1 - t0), layout: r1(t2 - t1), paint: lat(t0, tp), html: html - h0 });
      await settle(4);
    };
    await click('vehicles', '.vcat[data-nav]:nth-child(4)', 'category');
    await click('vehicles', '.vcat[data-cat="all"]', 'category all');
    await click('vehicles', '.vcard:nth-child(3)', 'select card');
    await click('vehicles', '.vcard:nth-child(5)', 'select card 2');
    await click('vehicles', '.vcard:nth-child(5) .fav', 'favourite');
    await click('vehicles', '.vcard:nth-child(5) .fav', 'unfavourite');
    await click('settings', '[data-key="showFps"]', 'toggle');
    await click('settings', '[data-key="showFps"]', 'toggle back');
    if (!quick) {
      await click('settings', '[data-key="units"] .r', 'choice');
      await click('settings', '[data-key="units"] .r', 'choice back');
    }
    await click('controls', '.mode:nth-child(2)', 'mode');
    await click('controls', '.mode[data-mode="car"]', 'mode back');
    await click('wardrobe', '.wdcat:nth-child(1)', 'category');
    await click('wardrobe', '.wdcat[data-cat="tops"]', 'category back');
    await click('wardrobe', '.wcard:nth-child(2)', 'try on item');
    await click('wardrobe', '[data-act="reset"]', 'reset try-on');
    await click('service', '[data-act="horn"]:not(.on)', 'horn option');
    await click('world', '.tile.on[data-act="weather"]', 'weather tile (same)');

    // ---- hover (mouseover → focus highlight) ----
    for (const tab of ['vehicles', 'settings', 'world']) {
      if (!tabs.includes(tab)) continue;
      menu.select(tab);
      await settle(6);
      const items = [...menu.tab.el.querySelectorAll('[data-nav]')].slice(0, 24);
      const js = [], lay = [];
      for (const el of items) {
        const t0 = now();
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        const t1 = now();
        void document.body.offsetHeight;
        js.push(t1 - t0); lay.push(now() - t1);
        await raf();
      }
      rows.push({ kind: 'hover', label: `${tab}: ${items.length} items`, js: r1(js.reduce((a, b) => a + b, 0) / Math.max(1, js.length)), layout: r1(lay.reduce((a, b) => a + b, 0) / Math.max(1, lay.length)), paint: null, html: null, max: r1(Math.max(...js.map((x, i) => x + lay[i]))) });
    }

    // ---- close (Esc) ----
    {
      const t0 = now();
      key('Escape');
      const rec = await waitRec('hide', t0);
      push('close', 'close (Esc)', rec, t0);
      await settle(10);
    }

    const lt = longTasks.filter((e) => e.startTime >= tFirstOpenDone);
    const lf = loafs.filter((e) => e.startTime >= tFirstOpenDone);
    const worst = (kind) => rows.filter((r) => r.kind.startsWith(kind)).reduce((m, r) => Math.max(m, r.paint ?? 0), 0);
    const summary = {
      viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
      quality: g.render?.profile?.name,
      throttledFrames: throttled, invalidPaintSamples: invalid,
      openFirstPaint: rows.find((r) => r.kind === 'open')?.paint,
      openRepeatPaintAvg: r1(avg(rows.filter((r) => r.kind === 'open').slice(1).map((r) => r.paint))),
      tabFirstWorst: worst('tab (first)'), tabRepeatWorst: worst('tab (repeat)'), tabClickWorst: worst('tab (click)'),
      tabRepeatJsWorst: rows.filter((r) => r.kind === 'tab (repeat)').reduce((m, r) => Math.max(m, (r.js ?? 0) + (r.layout ?? 0)), 0),
      clickJsLayoutWorst: r1(rows.filter((r) => r.kind === 'click').reduce((m, r) => Math.max(m, (r.js ?? 0) + (r.layout ?? 0)), 0)),
      clickPaintWorst: worst('click'),
      longTasksAfterOpen: lt.length, longTaskMax: r1(Math.max(0, ...lt.map((e) => e.duration))),
      loafAfterOpen: lf.length, loafMax: r1(Math.max(0, ...lf.map((e) => e.duration))),
      menuFrameMean: r1(avg(frames.filter((f) => f.label.startsWith('idle')).map((f) => f.mean))),
      menuLoopCpu: r1(avg(frames.filter((f) => f.label.startsWith('idle')).map((f) => f.loopCpu))),
    };
    return { summary, rows, frames, loaf: lf.slice(0, 12).map((e) => ({ start: r1(e.startTime), dur: r1(e.duration), block: r1(e.blockingDuration), render: r1(e.renderStart ? e.startTime + e.duration - e.renderStart : 0), scripts: (e.scripts || []).slice(0, 3).map((s) => `${r1(s.duration)}ms ${s.sourceFunctionName || s.invoker || ''} @${(s.sourceURL || '').split('/').pop()}:${s.sourceCharPosition}`) })) };
  } finally {
    watch = false;
    for (const f of restore) f();
    Object.defineProperty(Element.prototype, 'innerHTML', desc);
    for (const o of obs) o.disconnect();
  }
}

function avg(a) { const v = a.filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }

// Controlled A/B of one menu frame (works in a background tab: drives the game loop callback directly and waits
// for the GPU after each frame with a 1-pixel readPixels). A = the 3D scene re-rendered behind the menu every frame
// (old behaviour), B = frozen backdrop (renderBackdrop). Optional: the vehicle turntable frame on top.
//   const { frameCostAB } = await import('/src/ui/menu-bench.js'); await frameCostAB({ tab: 'vehicles', turntable: true })
export async function frameCostAB({ frames = 30, rounds = 4, tab = 'settings', turntable = false } = {}) {
  const g = window.__leonida, ui = g.ui, R = g.render;
  const cb = R.loopCallback;
  if (!cb || !ui.renderBackdrop) throw new Error('needs the game loop callback and ui.renderBackdrop');
  const gl = g.renderer.getContext();
  const px = new Uint8Array(4);
  if (!ui.isOpen) ui.open(tab); else ui.menu.select(tab);
  for (let i = 0; i < 6; i++) { cb(now()); await sleep(60); } // settle (live turntable starts after ~0.3 s of menu time)
  const tt = turntable ? ui.menu.byId.get('vehicles')?.turn : null;
  const own = Object.getOwnPropertyDescriptor(ui, 'renderBackdrop');
  const res = { A: [], B: [], ttA: [], ttB: [] };
  let fake = now() + 1e6; // turntable clock: always far enough ahead to render a frame
  try {
    for (let r = 0; r < rounds; r++) {
      for (const mode of ['A', 'B']) {
        ui.renderBackdrop = mode === 'A' ? () => true : own.value;
        for (let i = 0; i < frames; i++) {
          const t0 = now();
          cb(t0);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const t1 = now();
          res[mode].push(t1 - t0);
          if (tt) { fake += 1000; tt._frame(fake); res[`tt${mode}`].push(now() - t1); }
          if (i % 5 === 4) await sleep(0);
        }
      }
    }
  } finally {
    Object.defineProperty(ui, 'renderBackdrop', own);
  }
  const st = (a) => (a.length ? { mean: r1(a.reduce((x, y) => x + y, 0) / a.length), p50: r1(pct(a, 0.5)), p95: r1(pct(a, 0.95)) } : null);
  return { tab, frameA_sceneEveryFrame: st(res.A), frameB_frozenBackdrop: st(res.B), turntableA: st(res.ttA), turntableB: st(res.ttB) };
}

// rAF-free sweep (valid in a background / occluded tab): synchronous JS + the style/layout it causes for
// open → every tab (first visit, repeat) → typical clicks → close. Run on a freshly loaded game for "first" numbers.
//   const { syncSweep } = await import('/src/ui/menu-bench.js'); await syncSweep()
export async function syncSweep() {
  const g = window.__leonida, ui = g.ui, m = ui.menu;
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  let html = 0;
  Object.defineProperty(Element.prototype, 'innerHTML', { configurable: true, get: desc.get, set(v) { html += String(v).length; desc.set.call(this, v); } });
  const out = [];
  const step = async (label, fn) => {
    const h0 = html, t0 = now();
    fn();
    const t1 = now();
    void document.body.offsetHeight;
    out.push({ label, js: r1(t1 - t0), layout: r1(now() - t1), kb: r1((html - h0) / 1024) });
    await sleep(120);
  };
  try {
    if (ui.isOpen) ui.close();
    const dirty = m.tabs.filter((t) => t.dirty).length;
    await step(`open (first, ${dirty} unbuilt tabs)`, () => ui.open('map'));
    const tabs = m.visibleTabs().map((t) => t.id);
    for (const id of [...tabs.slice(1), tabs[0]]) await step(`tab first: ${id}`, () => m.select(id));
    for (const id of [...tabs.slice(1), tabs[0]]) await step(`tab repeat: ${id}`, () => m.select(id));
    const click = (tab, sel) => () => { if (m.tab.id !== tab) m.select(tab); m.tab.el.querySelector(sel)?.dispatchEvent(new MouseEvent('click', { bubbles: true })); };
    m.select('vehicles'); await sleep(150);
    await step('click: vehicles category', click('vehicles', '.vcat[data-cat="sports"]'));
    await step('click: vehicles category all', click('vehicles', '.vcat[data-cat="all"]'));
    await step('click: vehicles select card', click('vehicles', '.vcard:nth-child(6)'));
    await step('click: vehicles favourite', click('vehicles', '.vcard:nth-child(6) .fav'));
    await step('click: vehicles unfavourite', click('vehicles', '.vcard:nth-child(6) .fav'));
    m.select('settings'); await sleep(150);
    await step('click: settings toggle', click('settings', '[data-key="showFps"]'));
    await step('click: settings toggle back', click('settings', '[data-key="showFps"]'));
    m.select('wardrobe'); await sleep(150);
    await step('click: wardrobe category', click('wardrobe', '.wdcat[data-cat="legs"]'));
    await step('click: wardrobe try on', click('wardrobe', '.wcard:nth-child(2)'));
    await step('click: wardrobe reset', click('wardrobe', '[data-act="reset"]'));
    await step('click: wardrobe category back', click('wardrobe', '.wdcat[data-cat="tops"]'));
    await step('close', () => ui.close());
    await step('open (repeat)', () => ui.open('map'));
    await step('close', () => ui.close());
  } finally {
    Object.defineProperty(Element.prototype, 'innerHTML', desc);
  }
  return out;
}

// Short input → paint probe that only measures while the page is actually rendering (visible tab, frames ≤ 200 ms
// apart); each action is retried until it gets a clean sample. Works on the original and the optimised UI.
//   const { paintProbe } = await import('/src/ui/menu-bench.js'); await paintProbe()
export async function paintProbe({ reps = 3, maxWaitMs = 600000 } = {}) {
  const g = window.__leonida, ui = g.ui, menu = ui.menu;
  const deadline = now() + maxWaitMs;
  const visible = async () => { while (document.visibilityState !== 'visible' && now() < deadline) await sleep(250); };
  // a sample is valid when every frame interval between input and paint was ≤ 200 ms
  const timed = async (act) => {
    for (let tries = 0; tries < 20 && now() < deadline; tries++) {
      await visible();
      await raf(); await raf();
      let prevF = now(), bad = false, stop = false;
      (function tick(t) { if (stop) return; if (t - prevF > 200) bad = true; prevF = t; requestAnimationFrame(tick); })(prevF);
      const t0 = now();
      const until = await act();
      const tp = await until;
      stop = true;
      if (!bad && document.visibilityState === 'visible') return r1(tp - t0);
    }
    return null;
  };
  // key-triggered actions are handled by the game loop: resolve after the frame in which the menu changed
  const afterChange = (check) => new Promise((res) => { const f = () => (check() ? postTask(res) : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const out = {};
  const add = (k, v) => { (out[k] ||= []).push(v); };
  for (let i = 0; i < reps; i++) {
    if (ui.isOpen) ui.close();
    await sleep(200);
    add('open (Esc)', await timed(() => { key('Escape'); return afterChange(() => ui.isOpen); }));
    for (const id of ['vehicles', 'settings', 'wardrobe', 'map']) {
      add(`tab → ${id} (click)`, await timed(() => { menu.tabsEl.querySelector(`[data-tab="${id}"]`)?.click(); return afterPaint(); }));
    }
    menu.select('vehicles'); await sleep(300);
    add('vehicles: category all ↔ sports', await timed(() => { menu.tab.el.querySelector(`.vcat[data-cat="${i % 2 ? 'all' : 'sports'}"]`)?.click(); return afterPaint(); }));
    add('vehicles: select card', await timed(() => { menu.tab.el.querySelector(`.vcard:not(.hidden):nth-child(${3 + i})`)?.dispatchEvent(new MouseEvent('click', { bubbles: true })); return afterPaint(); }));
    menu.select('wardrobe'); await sleep(300);
    add('wardrobe: try on', await timed(() => { menu.tab.el.querySelector(`.wcard:nth-child(${2 + i})`)?.dispatchEvent(new MouseEvent('click', { bubbles: true })); return afterPaint(); }));
    add('close (Esc)', await timed(() => { key('Escape'); return afterChange(() => !ui.isOpen); }));
  }
  if (ui.isOpen) ui.close();
  return Object.fromEntries(Object.entries(out).map(([k, v]) => { const ok = v.filter((x) => x != null); return [k, ok.length ? { median: r1(pct(ok, 0.5)), max: r1(Math.max(...ok)), n: ok.length } : null]; }));
}

// MAP tab layout check: the menu's own elements must not overlap the full map's controls (src/map FullMap),
// and the map controls must stay inside the map area. → { overlaps: [], ... } (empty = OK)
export async function mapLayoutCheck() {
  const g = window.__leonida, ui = g.ui, m = ui.menu;
  ui.open('map');
  await sleep(250);
  const mt = m.byId.get('map');
  mt.full?.resize?.();
  const R = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? r : null;
  };
  const q = (s) => mt.el.querySelector(s);
  const mine = { actions: R(q('#map-actions')), credit: R(q('.mattr')), info: R(q('#map-info')) };
  const map = { poi: R(q('.ldm-poibtn')), zoom: R(q('.ldm-zoom')), scale: R(q('.ldm-bottom')), info: R(q('.ldm-info')), card: R(q('.ldm-card')) };
  const wrap = mt.wrap.getBoundingClientRect();
  const hit = (a, b) => a && b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const overlaps = [];
  for (const [k, a] of Object.entries(mine)) {
    for (const [j, b] of Object.entries(map)) if (hit(a, b)) overlaps.push(`${k}×map.${j}`);
    if (k === 'actions' && hit(a, wrap)) overlaps.push('actions×map area');
  }
  const outside = Object.entries(map).filter(([, r]) => r && (r.left < wrap.left - 1 || r.right > wrap.right + 1 || r.top < wrap.top - 1 || r.bottom > wrap.bottom + 1)).map(([k]) => k);
  const f = (r) => (r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null);
  const res = { viewport: `${innerWidth}x${innerHeight}`, compact: !!q('.ldm-root')?.classList.contains('compact'), overlaps, mapControlsOutside: outside,
    mapArea: f(wrap), actions: f(mine.actions), buttons: [...mt.el.querySelectorAll('#map-actions .mbtn')].map((b) => f(b.getBoundingClientRect())), side: f(R(q('#map-side'))) };
  ui.close();
  return res;
}
