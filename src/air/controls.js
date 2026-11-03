// Keyboard + gamepad mapping for aircraft and boats (see INTEGRATION.md for the full control scheme).
// Ctrl is deliberately unused: Ctrl+W/Ctrl+S would close/save the browser tab mid-flight.
const GP = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

const key = (inp, ...codes) => codes.some((c) => inp.held(c));
const axis = (inp, neg, pos) => (key(inp, ...pos) ? 1 : 0) - (key(inp, ...neg) ? 1 : 0);
const clamp1 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

export const KEYS = {
  fwd: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  yawL: ['KeyQ'], yawR: ['KeyE'], up: ['Space'], down: ['ShiftLeft', 'ShiftRight'],
  thrUp: ['ShiftLeft', 'ShiftRight'], thrDown: ['KeyZ'], brake: ['Space'],
  flaps: 'KeyG', gear: 'KeyB', assist: 'KeyN', smoke: 'KeyX',
};

/** Helicopter: W/S cyclic pitch, A/D cyclic roll, Q/E tail rotor, Space climb, Shift descend. */
export function readHeli(inp, out) {
  out.active = true;
  out.pitch = clamp1(axis(inp, KEYS.back, KEYS.fwd) - inp.axis(1));
  out.roll = clamp1(axis(inp, KEYS.left, KEYS.right) + inp.axis(0));
  out.yaw = clamp1(axis(inp, KEYS.yawL, KEYS.yawR) + (inp.gpHeld(GP.RB) ? 1 : 0) - (inp.gpHeld(GP.LB) ? 1 : 0));
  out.collective = clamp1(axis(inp, KEYS.down, KEYS.up) + inp.gpValue(GP.RT) - inp.gpValue(GP.LT));
  return out;
}

/** Plane: W/S pitch (S pulls), A/D roll, Q/E rudder, Shift/Z throttle, Space brakes. */
export function readPlane(inp, out, yoke) {
  out.active = true;
  out.pitch = clamp1(axis(inp, KEYS.fwd, KEYS.back) + inp.axis(1) + (yoke ? yoke.y : 0));
  out.roll = clamp1(axis(inp, KEYS.left, KEYS.right) + inp.axis(0) + (yoke ? yoke.x : 0));
  out.yaw = clamp1(axis(inp, KEYS.yawL, KEYS.yawR) + (inp.gpHeld(GP.RB) ? 1 : 0) - (inp.gpHeld(GP.LB) ? 1 : 0));
  out.throttleRate = clamp1(axis(inp, KEYS.thrDown, KEYS.thrUp) + inp.gpValue(GP.RT) - inp.gpValue(GP.LT));
  out.brake = key(inp, ...KEYS.brake) || inp.gpHeld(GP.A) ? 1 : 0;
  return out;
}

/** Boat: W/S throttle & reverse, A/D steer, Space idles the engine. */
export function readBoat(inp, out) {
  out.active = true;
  let thr = axis(inp, KEYS.back, KEYS.fwd) + inp.gpValue(GP.RT) - inp.gpValue(GP.LT);
  if (key(inp, ...KEYS.brake) || inp.gpHeld(GP.A)) thr = 0;
  out.throttle = clamp1(thr);
  out.steer = clamp1(axis(inp, KEYS.left, KEYS.right) + inp.axis(0));
  return out;
}

/** One-shot toggles this frame (keyboard or gamepad d-pad). */
export const pressed = {
  assist: (inp) => inp.pressed(KEYS.assist) || inp.gpPressedBtn(GP.RIGHT),
  flaps: (inp) => inp.pressed(KEYS.flaps) || inp.gpPressedBtn(GP.DOWN),
  flapsUp: (inp) => inp.gpPressedBtn(GP.UP),
  gear: (inp) => inp.pressed(KEYS.gear) || inp.gpPressedBtn(GP.LEFT),
  smoke: (inp) => inp.pressed(KEYS.smoke) || inp.gpPressedBtn(GP.X),
};

export const NO_CTL = Object.freeze({ active: false, collective: 0, pitch: 0, roll: 0, yaw: 0, throttle: 0, throttleRate: 0, steer: 0, brake: 1 });
// sticks centred, throttle held where it is (online: the menu is open and the world keeps running)
export const HOLD_CTL = Object.freeze({ active: true, collective: 0, pitch: 0, roll: 0, yaw: 0, throttle: 0, throttleRate: 0, steer: 0, brake: 0 });
