import { GP } from './input.js';

// Horn: hold G (or L3 on a gamepad) in any land vehicle or boat. Emits 'horn' {vehicle, on} like the touch button;
// the audio module plays the vehicle's horn variant (v.hornType) and pedestrians react to it.
const NO_HORN = new Set(['plane', 'heli', 'helicopter', 'jet']);

export function hornKeyModule(game) {
  let cur = null;
  return {
    update() {
      const p = game.player, inp = game.input;
      const v = p?.mode === 'vehicle' ? p.controllable : null;
      const want = !!v && !NO_HORN.has(v.kind) && !game.paused && !game.ui?.isOpen
        && (inp.held('KeyG') || inp.gpHeld?.(GP.LS)) ? v : null;
      if (want === cur) return;
      if (cur) game.events.emit('horn', { vehicle: cur, on: false });
      cur = want;
      if (cur) game.events.emit('horn', { vehicle: cur, on: true });
    },
  };
}
