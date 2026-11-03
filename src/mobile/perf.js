// Mobile performance profile + frame-rate cap.
// Uses workstream F's quality API (src/core/quality.js / Renderer): profile 'mobile' (DPR ≤ 1.5 × 0.6, 1 shadow cascade,
// no bloom/AO/SSR/god rays, shorter draw distance, 60 fps cap, fewer cars and pedestrians).
import { frameGate } from './math.js';
import { QUALITY_PROFILES } from '../core/quality.js';

/**
 * Switch to F's 'mobile' profile when the device is a phone/tablet, the user left quality on 'auto' and F's own
 * detection picked a heavier desktop preset (e.g. iPads with a desktop UA). Runs at boot, before the loop starts and
 * before render.prewarm(), so the one-off reconfiguration costs nothing in gameplay. Never touches a user choice.
 * @returns {{ applied: boolean, profile: string, reason: string }}
 */
export function applyMobileProfile(game, device) {
  const render = game.render;
  const q = game.quality || render?.profile;
  const userQ = game.settings?.quality ?? 'auto';
  if (!render || !q) return { applied: false, profile: q?.name ?? '?', reason: 'no renderer/quality API' };
  if (userQ !== 'auto') return { applied: false, profile: q.name, reason: `user quality "${userQ}"` };
  if (!device.mobile) return { applied: false, profile: q.name, reason: 'not a phone/tablet' };
  if (q.name === 'mobile' || q.name === 'low') return { applied: false, profile: q.name, reason: `F detection already "${q.name}"` };
  if (typeof q.apply !== 'function' || !QUALITY_PROFILES.mobile) return { applied: false, profile: q.name, reason: 'no mobile profile' };
  const from = q.name;
  q.apply('mobile', true); // keep auto: the governor may still step mobile → low at runtime
  render.quality = 'mobile';
  render.resize?.();
  return { applied: true, profile: 'mobile', reason: `${from} → mobile (touch device)` };
}

/**
 * Runtime budgets that no other module derives from the quality profile yet (non-persistent: the user's
 * traffic/peds/drawDist settings still scale on top). Re-applied when the profile or drawDist changes.
 */
export function applyBudgets(game, state) {
  const q = game.quality || game.render?.profile;
  if (!q) return;
  const mobileQ = q.name === 'mobile' || q.name === 'low';
  const tr = game.traffic, peds = game.peds;
  if (tr && typeof tr.max === 'number') {
    state.trafficBase ??= tr._baseMax ?? tr.max;
    const cap = mobileQ && q.trafficMax ? Math.min(state.trafficBase, q.trafficMax) : state.trafficBase;
    const k = Math.min(1, game.settings?.traffic ?? 1);
    tr._baseMax = cap; // UI fallback (src/ui/index.js applyFallbacks) multiplies the user setting onto this
    tr.max = Math.round(cap * k);
  }
  if (peds && typeof peds.max === 'number') {
    state.pedsBase ??= peds._baseMax ?? peds.max;
    const cap = mobileQ && q.pedsMax ? Math.min(state.pedsBase, q.pedsMax) : state.pedsBase;
    const k = Math.min(1, game.settings?.peds ?? 1);
    peds._baseMax = cap;
    peds.max = Math.round(cap * k);
  }
  const veg = game.veg?.scatters;
  if (veg) {
    const f = mobileQ ? (q.vegRadius ?? 1) : 1;
    const dd = game.settings?.drawDist ?? 1;
    for (const sc of Object.values(veg)) if (sc.baseRadius) sc.radius = sc.baseRadius * dd * f;
  }
}

/**
 * Frame cap: wraps renderer.setAnimationLoop so rAF ticks above the cap skip the game loop entirely
 * (no update, no render: the GPU idles → battery). getCap() → fps or 0 (uncapped), read every tick.
 * Installed before the loop starts (module creation runs before startLoop); if the loop is already running,
 * it re-installs the stored loop callback (Renderer keeps it in render.loopCallback).
 */
export function installFrameCap(game, getCap) {
  const r = game.renderer;
  if (!r || r.__mobileCap) return;
  const base = r.setAnimationLoop;
  const gate = { last: -1, acc: 0 };
  let skipped = false;
  // F's Renderer times the loop callback into render._cpuMs (stats()); a skipped tick must not overwrite the
  // last real measurement with ~0 ms. Ask F for a native limiter (see INTEGRATION.md) to drop this.
  const render = game.render;
  if (render && !Object.getOwnPropertyDescriptor(render, '_cpuMs')?.set) {
    let cpu = render._cpuMs ?? 0;
    Object.defineProperty(render, '_cpuMs', { configurable: true, enumerable: true, get: () => cpu, set: (v) => { if (!skipped) cpu = v; } });
  }
  const wrap = (cb) => {
    if (!cb) return cb;
    const inner = cb.__inner || cb;
    const f = (t, frame) => {
      // manual calls (labs driving a hidden page) pass no timestamp: always run
      skipped = !(t === undefined || frameGate(gate, t, getCap()));
      if (!skipped) inner(t, frame);
    };
    f.__inner = inner;
    return f;
  };
  r.setAnimationLoop = (cb) => base.call(r, wrap(cb));
  r.__mobileCap = true;
  const running = game.render?.loopCallback;
  if (running) r.setAnimationLoop(running);
}
