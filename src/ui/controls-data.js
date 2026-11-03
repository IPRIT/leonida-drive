// Control layouts shown in the CONTROLS tab. Tokens starting with '@' are i18n keys (key names that get translated).
// Update this table when the characters (D) / aircraft & boats (B) workstreams finalise their bindings.
// `touch` (shown instead of the keyboard on touch screens): tokens starting with '#' are icons of the touch overlay
// (src/mobile/icons.js, the same glyphs as its buttons); '@' tokens as above.
export const CONTROL_MODES = [
  {
    id: 'general', icon: 'gamepad',
    touch: [['act.menu', ['#menu']], ['act.map', ['#map']], ['life.photo.title', ['#photo']], ['act.freeCam', ['#freefly']], ['act.look', ['#swipe']]],
    kb: [['act.menu', ['Esc']], ['act.map', ['M']], ['act.players', ['Tab']], ['act.freeCam', ['V']], ['act.timeSkip', ['T']], ['act.hideHud', ['U']],
      ['act.fps', ['F3']], ['act.tabs', ['Q', 'E']], ['act.navigate', ['@key.arrows', 'Enter']]],
    pad: [['act.menu', ['Start']], ['act.map', ['Back']], ['act.players', ['R3']], ['act.tabs', ['LB', 'RB']], ['act.navigate', ['@pad.dpad', 'A', 'B']]],
  },
  {
    id: 'foot', icon: 'user',
    touch: [['act.move', ['@pad.ls']], ['act.look', ['#swipe']], ['act.sprint', ['#sprint']], ['act.jump', ['#jump']], ['act.enter', ['#enter']], ['act.camera', ['#camera']]],
    kb: [['act.move', ['W', 'A', 'S', 'D']], ['act.look', ['@key.mouse']], ['act.sprint', ['Shift']], ['act.jump', ['@key.space']],
      ['act.enter', ['F']]],
    pad: [['act.move', ['@pad.ls']], ['act.look', ['@pad.rs']], ['act.sprint', ['A']], ['act.jump', ['X']], ['act.enter', ['Y']]],
  },
  {
    id: 'car', icon: 'car',
    touch: [['act.accelerate', ['#gas']], ['act.brake', ['#brake']], ['act.steer', ['#slider', '#tilt']], ['act.handbrake', ['#handbrake']], ['act.nitro', ['#nitro']],
      ['act.horn', ['#horn']], ['act.lights', ['#lights']], ['act.camera', ['#camera']], ['act.look', ['#swipe']], ['act.reset', ['#flip']], ['act.enter', ['#exit']]],
    kb: [['act.accelerate', ['W', '↑']], ['act.brake', ['S', '↓']], ['act.steer', ['A', 'D']], ['act.handbrake', ['@key.space']],
      ['act.nitro', ['Shift']], ['act.camera', ['C']], ['act.lights', ['H']], ['act.horn', ['G']], ['act.siren', ['L']], ['act.reset', ['R']],
      ['act.enter', ['F']], ['act.look', ['@key.mouse']]],
    pad: [['act.accelerate', ['RT']], ['act.brake', ['LT']], ['act.steer', ['@pad.ls']], ['act.handbrake', ['A', 'X']],
      ['act.nitro', ['B', 'RB']], ['act.horn', ['L3']], ['act.look', ['@pad.rs']], ['act.enter', ['Y']]],
  },
  {
    id: 'bike', icon: 'motorcycle',
    touch: [['act.accelerate', ['#gas']], ['act.brake', ['#brake']], ['act.steer', ['#slider', '#tilt']], ['act.handbrake', ['#handbrake']], ['act.enter', ['#exit']]],
    kb: [['act.accelerate', ['W']], ['act.brake', ['S']], ['act.steer', ['A', 'D']], ['act.lean', ['↑', '↓']], ['act.pedal', ['W']],
      ['act.handbrake', ['@key.space']], ['act.enter', ['F']]],
    pad: [['act.accelerate', ['RT']], ['act.brake', ['LT']], ['act.steer', ['@pad.ls']], ['act.lean', ['@pad.ls']], ['act.enter', ['Y']]],
  },
  {
    // src/air/controls.js (workstream B)
    id: 'heli', icon: 'heli',
    touch: [['act.collective', ['@pad.ls']], ['act.yaw', ['@pad.ls']], ['act.pitchRoll', ['@pad.rs']], ['act.flightAssist', ['#assist']], ['act.camera', ['#camera']],
      ['act.look', ['#swipe']], ['act.enter', ['#exit']]],
    kb: [['act.pitch', ['W', 'S']], ['act.roll', ['A', 'D']], ['act.yaw', ['Q', 'E']], ['act.collective', ['@key.space', 'Shift']],
      ['act.camera', ['C']], ['act.enter', ['F']]],
    pad: [['act.pitchRoll', ['@pad.ls']], ['act.yaw', ['LB', 'RB']], ['act.collective', ['RT', 'LT']], ['act.look', ['@pad.rs']],
      ['act.enter', ['Y']]],
  },
  {
    id: 'plane', icon: 'plane',
    touch: [['act.throttle', ['#throttle']], ['act.pitchRoll', ['@pad.rs']], ['act.rudder', ['#left', '#right']], ['act.wheelBrakes', ['#brake']], ['act.flaps', ['#flaps']],
      ['act.gear', ['#gear']], ['act.flightAssist', ['#assist']], ['act.smoke', ['#smoke']], ['act.camera', ['#camera']], ['act.enter', ['#exit']]],
    kb: [['act.pitch', ['W', 'S']], ['act.roll', ['A', 'D']], ['act.rudder', ['Q', 'E']], ['act.throttle', ['Shift', 'Z']],
      ['act.wheelBrakes', ['@key.space']], ['act.flaps', ['G']], ['act.gear', ['B']], ['act.flightAssist', ['N']], ['act.smoke', ['X']],
      ['act.camera', ['C']], ['act.enter', ['F']]],
    pad: [['act.pitchRoll', ['@pad.ls']], ['act.rudder', ['LB', 'RB']], ['act.throttle', ['RT', 'LT']], ['act.wheelBrakes', ['A']],
      ['act.flaps', ['@pad.dpad', '▼']], ['act.gear', ['@pad.dpad', '◀']], ['act.flightAssist', ['@pad.dpad', '▶']], ['act.smoke', ['X']], ['act.enter', ['Y']]],
  },
  {
    id: 'boat', icon: 'boat',
    touch: [['act.accelerate', ['#gas']], ['act.brake', ['#brake']], ['act.steer', ['#slider', '#tilt']], ['act.horn', ['#horn']], ['act.camera', ['#camera']], ['act.enter', ['#exit']]],
    kb: [['act.accelerate', ['W', '↑']], ['act.brake', ['S', '↓']], ['act.steer', ['A', 'D']], ['act.idle', ['@key.space']],
      ['act.camera', ['C']], ['act.enter', ['F']]],
    pad: [['act.accelerate', ['RT']], ['act.brake', ['LT']], ['act.steer', ['@pad.ls']], ['act.idle', ['A']], ['act.look', ['@pad.rs']],
      ['act.enter', ['Y']]],
  },
  {
    id: 'free', icon: 'bolt',
    touch: [['act.fly', ['@pad.ls']], ['act.upDown', ['#down', '#up']], ['act.fast', ['#boost']], ['act.look', ['#swipe']], ['act.freeCam', ['#freecam']]],
    kb: [['act.fly', ['W', 'A', 'S', 'D']], ['act.upDown', ['Q', 'E']], ['act.fast', ['Shift']], ['act.look', ['@key.mouse', '@key.rmb']],
      ['act.speed', ['@key.wheel']], ['act.freeCam', ['V']]],
    pad: [],
  },
];
