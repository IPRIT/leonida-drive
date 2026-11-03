// Opt-in snapshot impairment. Reliable purchases/authentication are never dropped.
// Disabling it discards queued snapshots, so an old delayed pose cannot rewind a live connection.
export class LinkEmulator {
  constructor() { this.active = false; this.timers = new Set(); this.dropped = 0; this.delayed = 0; }
  configure(profile) {
    this.clear();
    this.profile = profile;
    const p = { normal: [0, 0, 0], poor: [250, 120, .05], severe: [750, 350, .15], outage: [0, 0, 1] }[profile] || [0, 0, 0];
    [this.latency, this.jitter, this.loss] = p; this.active = profile !== 'normal';
  }
  incoming(data, deliver) { this._schedule(data, deliver); }
  outgoing(data, deliver) { this._schedule(data, deliver); }
  _schedule(data, deliver) {
    if (Math.random() < this.loss || this.timers.size >= 128) { this.dropped++; return; }
    this.delayed++;
    const delay = Math.max(0, this.latency + (Math.random() * 2 - 1) * this.jitter);
    const timer = setTimeout(() => { this.timers.delete(timer); deliver(data); }, delay);
    this.timers.add(timer);
  }
  clear() { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
  stop() { this.configure('normal'); }
}
