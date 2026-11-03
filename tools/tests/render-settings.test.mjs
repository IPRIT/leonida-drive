import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSize, clampRenderScale, antialiasingModes } from '../../src/core/renderSettings.js';
import { Renderer } from '../../src/core/Renderer.js';
import { QualityGovernor } from '../../src/core/quality.js';

test('manual 100% uses native display pixels even when a low preset has a reduced pixel budget', () => {
  const base = { width: 1600, height: 900, dpr: 2, basePR: 0.75, auto: false, maxPixels: 64e6 };
  const native = renderSize({ ...base, scale: 1 }), supersampled = renderSize({ ...base, scale: 2 });
  assert.deepEqual([native.width, native.height], [3200, 1800]);
  assert.deepEqual([supersampled.width, supersampled.height], [6400, 3600]);
  const automatic = renderSize({ ...base, auto: true, scale: 0.8 });
  assert.equal(automatic.width, 960);
});

test('frame dimensions respect texture and memory limits without distorting the aspect ratio', () => {
  const s = renderSize({ width: 3840, height: 2160, dpr: 2, scale: 2, auto: false, maxDimension: 8192, maxPixels: 12e6 });
  assert.ok(s.limited); assert.ok(s.width * s.height <= 12e6);
  assert.ok(s.width <= 8192 && s.height <= 8192);
  assert.ok(Math.abs(s.width / s.height - 16 / 9) < 0.001);
  assert.equal(clampRenderScale(NaN), 1); assert.equal(clampRenderScale(null), 1);
  assert.equal(clampRenderScale(3), 2); assert.equal(clampRenderScale(0.1), 0.5);
});

test('saved manual scale and AA survive startup, preset changes and returning from dynamic resolution', () => {
  const handlers = new Map();
  const game = { settings: { resScale: 1.8, autoRes: false, antialiasing: 'smaa' }, onSetting(k, fn) { handlers.set(k, fn); } };
  const r = Object.create(Renderer.prototype);
  r.msaaSamples = [4]; r._config = () => {}; r.resize = () => {};
  r.profile = { apply() {} }; r.detected = { name: 'medium' }; r.governor = new QualityGovernor();
  r.attach(game);
  assert.equal(r.autoRes, false); assert.equal(r.scale, 1.8); assert.equal(r.antialiasing, 'smaa');
  r.setQuality('low'); assert.equal(r.scale, 1.8);
  handlers.get('autoRes')(true); assert.equal(r.scale, 1);
  handlers.get('autoRes')(false); assert.equal(r.scale, 1.8);
  handlers.get('resScale')(2); assert.equal(r.scale, 2);
  handlers.get('antialiasing')('msaa4'); assert.equal(r.antialiasing, 'msaa4');
  assert.deepEqual(antialiasingModes([4]), ['auto', 'none', 'fxaa', 'smaa', 'msaa4']);
});
