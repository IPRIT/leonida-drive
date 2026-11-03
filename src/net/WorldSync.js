// Shared world clock + weather. The schedule is a pure function of server time (shared/worldclock.js): every client
// computes the same sky from its synced server clock (game.sky.sync() smooths drift, game.weather.set() blends), so no
// bytes are spent broadcasting it; offline the local clock is used and nothing jumps when the connection comes back.
import { worldClock, WEATHER_IDS } from './shared/worldclock.js';

export class WorldSync {
  constructor(game, client) {
    this.game = game;
    this.client = client;
    this.applied = null; // weather id currently applied
    this.t = 0;
    this.synced = false;
    // the schedule is deterministic: nothing needs to be broadcast — re-sync right away when the clock gets corrected
    this._off = client.on('welcome', () => { this.t = 0; this.synced = false; });
  }

  _weather(cur, prev, transition, dur) {
    const w = this.game.weather;
    if (!w?.set || !cur) return;
    if (this.applied === cur) return;
    if (this.applied === null) {
      // joining: start from where the blend is right now, finish the rest of it
      if (prev && prev !== cur && transition < 1) {
        w.set(prev, 0);
        w.set(cur, Math.max(1, (1 - transition) * dur));
      } else w.set(cur, 0);
    } else w.set(cur, Math.max(8, (1 - Math.min(transition, 0.9)) * dur));
    this.applied = cur;
  }

  /** Every 2 s: the sky and weather of the shared schedule at server time (local time while offline). */
  update(dt) {
    this.t -= dt;
    if (this.t > 0) return;
    const clock = this.client.clock;
    const online = this.client.online && clock.synced;
    this.t = online && !this.synced ? 0.5 : 2;
    if (online) this.synced = true;
    const wc = worldClock(online ? clock.now() : Date.now());
    this.game.sky?.sync?.(wc.hour, wc.timeScale);
    this._weather(wc.weather, wc.prev, wc.transition, wc.transitionS);
  }

  dispose() { this._off(); }
}
