// NTP-style clock sync: offset = server − local, from ping/pong pairs. Uses the median offset of the lowest-RTT half of
// the last 16 samples (queueing delay only ever adds RTT) and slews (≤ 5 ms/s) instead of stepping once synced.
const N = 16;

export class ClockSync {
  constructor() {
    this.samples = [];
    this.offset = 0; // applied offset (ms): serverNow = performance.now() + offset
    this.target = 0;
    this.rtt = 0; // median RTT of the best samples (ms)
    this.synced = false;
  }

  sample(clientT, serverT, now) {
    const rtt = now - clientT;
    if (!(rtt >= 0) || rtt > 10000) return;
    this.n = (this.n || 0) + 1;
    this.samples.push({ rtt, off: serverT - (clientT + rtt / 2) });
    if (this.samples.length > N) this.samples.shift();
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.ceil(this.samples.length / 2)));
    const offs = best.map((s) => s.off).sort((a, b) => a - b);
    this.target = offs[offs.length >> 1];
    const rtts = this.samples.map((s) => s.rtt).sort((a, b) => a - b);
    this.rtt = rtts[rtts.length >> 1];
    // step (don't slew) while the estimate is still settling (samples taken during loading stalls are bad) or when
    // it is far off; the render clock compensates offset steps, so this never shows as a jump
    if (!this.synced || this.n < 24 || Math.abs(this.target - this.offset) > 100) { this.offset = this.target; this.synced = true; }
  }

  /** Slew the applied offset toward the estimate (call every frame). */
  update(dt) {
    if (!this.synced) return;
    const d = this.target - this.offset, max = 5 * dt;
    this.offset += d > max ? max : d < -max ? -max : d;
  }

  now(local = performance.now()) { return local + this.offset; }

  reset() { this.samples.length = 0; this.synced = false; this.n = 0; }
}
