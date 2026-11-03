// Node checks for the pure parts of the mobile layer:  node src/mobile/test.mjs
import { driveAxis, driveSteerFromAxis, linAxis, axisFromPad, tiltAngle, frameGate, stickVector, steerCurve } from './math.js';
import { VirtualPad, GP } from './VirtualPad.js';
import { detectDevice } from './detect.js';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.error('FAIL', msg); } else console.log('ok  ', msg); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// DriveInput / InputManager.axis inverses
let worst = 0;
for (let s = -1; s <= 1.0001; s += 0.01) worst = Math.max(worst, Math.abs(driveSteerFromAxis(driveAxis(s)) - s));
ok(worst < 1e-9, `driveAxis inverts DriveInput's deadzone + curve (max err ${worst.toExponential(1)})`);
worst = 0;
for (let s = -1; s <= 1.0001; s += 0.01) worst = Math.max(worst, Math.abs(axisFromPad(linAxis(s)) - s));
ok(worst < 1e-9, `linAxis inverts InputManager.axis deadzone (max err ${worst.toExponential(1)})`);
ok(driveAxis(0) === 0 && linAxis(0) === 0, 'zero stays zero');
ok(steerCurve(1) === 1 && steerCurve(-1) === -1 && Math.abs(steerCurve(0.5)) < 0.5, 'steer curve: full lock at the ends, softer centre');

// tilt: landscape-primary (screen angle 90), phone upright (gamma -90) → 0; turned clockwise 20° → +20°
const deg = (r) => (r * 180) / Math.PI;
ok(near(deg(tiltAngle(0, -90, 90)), 0, 1e-6), 'tilt: upright landscape = centre');
// clockwise by 20° in landscape-primary: up in device coords = (cos20, sin20, 0) → beta = asin(sin20)=20°, gamma: -cos(b) sin(g) = cos20 → g=-90
ok(near(deg(tiltAngle(20, -90, 90)), 20, 1e-6), 'tilt: right edge down 20° = +20° (steer right)');
ok(near(deg(tiltAngle(-20, -90, 90)), -20, 1e-6), 'tilt: left edge down 20° = −20°');
// landscape-secondary (270): upright → gamma +90
ok(near(deg(tiltAngle(0, 90, 270)), 0, 1e-6), 'tilt: upright landscape-secondary = centre');
ok(near(deg(tiltAngle(-20, 90, 270)), 20, 1e-6), 'tilt: landscape-secondary clockwise = +');
// tilted back 45° and turned 15°: still ≈ 15°
{
  // build the up vector for a phone tilted back 45° then rolled 15° clockwise, landscape-primary, and invert to beta/gamma
  const t = (15 * Math.PI) / 180, back = (45 * Math.PI) / 180;
  // screen frame (right, up, out): world up = (-sin t * cos back, cos t * cos back, sin back)
  const sr = -Math.sin(t) * Math.cos(back), su = Math.cos(t) * Math.cos(back), so = Math.sin(back);
  // landscape-primary: screen-right = -y_dev, screen-up = +x_dev, out = z
  const ux = su, uy = -sr, uz = so;
  const b = Math.asin(uy), g = Math.atan2(-ux, uz);
  ok(near(deg(tiltAngle(deg(b), deg(g), 90)), 15, 1e-6), 'tilt: works tilted back 45° (gravity projection)');
}
ok(Number.isNaN(tiltAngle(0, 0, 90)), 'tilt: flat on the table = no reading');

// frame cap: 120 Hz / 90 Hz / 60 Hz / 144 Hz displays → ~60 fps
for (const hz of [60, 90, 120, 144]) {
  const st = { last: -1, acc: 0 };
  let ran = 0;
  const N = hz * 10;
  for (let i = 0; i < N; i++) if (frameGate(st, i * (1000 / hz) + (Math.random() - 0.5) * 0.6, 60)) ran++;
  ok(Math.abs(ran / 10 - Math.min(60, hz)) < 1.5, `frame cap 60 on ${hz} Hz → ${(ran / 10).toFixed(1)} fps`);
}
{
  const st = { last: -1, acc: 0 };
  let ran = 0;
  for (let i = 0; i < 1200; i++) if (frameGate(st, i * (1000 / 120), 0)) ran++;
  ok(ran === 1200, 'cap 0 = uncapped');
}

// stick
{
  const o = { x: 0, y: 0, mag: 0, over: 0 };
  stickVector(30, 40, 50, 0.1, o);
  ok(near(o.mag, 1) && near(o.x, 0.6) && near(o.y, 0.8) && near(o.over, 1), 'stick: edge = full magnitude');
  stickVector(3, 0, 50, 0.1, o);
  ok(o.mag === 0 && o.x === 0, 'stick: inner deadzone');
  stickVector(120, 0, 50, 0.1, o);
  ok(near(o.mag, 1) && near(o.over, 2.4), 'stick: past the edge reports over > 1 (sprint)');
}

// virtual pad
{
  globalThis.performance ??= { now: () => Date.now() };
  const pad = new VirtualPad();
  ok(pad.poll() === null, 'pad idle → null (keyboard/mouse untouched)');
  pad.tap(GP.Y);
  const s1 = pad.poll();
  ok(s1 && s1.buttons[GP.Y].pressed, 'tap reads pressed for one poll');
  const s2 = pad.poll();
  ok(s2 === null, '…and released on the next');
  pad.press(GP.A); pad.release(GP.A); // shorter than a frame
  ok(pad.poll()?.buttons[GP.A].pressed === true, 'sub-frame press still seen once');
  pad.press(GP.RT, 1, 7);
  const a = pad.poll().buttons[GP.RT].value;
  ok(a > 0.04 && a < 0.5, `ramped throttle starts low (${a.toFixed(2)})`);
  pad.release(GP.RT);
  ok(pad.poll() === null, 'release is instant');
  pad.setAxis(0, 0.5);
  const s3 = pad.poll();
  ok(s3.axes[0] === 0.5 && s3 === pad.state, 'axes copied; same snapshot object every frame (no allocations)');
}

// detection with a fake environment
{
  const mm = (q) => ({ matches: /coarse|hover: none/.test(q) });
  const phone = detectDevice({ navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile', maxTouchPoints: 5, hardwareConcurrency: 8, deviceMemory: 8 }, screen: { width: 412, height: 915 }, matchMedia: mm, ontouchstart: null, location: { search: '' } });
  ok(phone.phone && phone.mobile && phone.android && !phone.lowEnd, 'detect: Android phone');
  const ipad = detectDevice({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', maxTouchPoints: 5 }, screen: { width: 820, height: 1180 }, matchMedia: mm, ontouchstart: null });
  ok(ipad.tablet && ipad.iPadOS && ipad.ios && !ipad.phone, 'detect: iPadOS (desktop UA)');
  const desk = detectDevice({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome', maxTouchPoints: 0 }, screen: { width: 1728, height: 1117 }, matchMedia: () => ({ matches: false }) });
  ok(!desk.touch && !desk.mobile, 'detect: desktop');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
