import { VERSION_LABEL } from '../core/version.js';

export class FrameHistory {
  constructor(size = 240) { this.values = new Float32Array(size); this.head = 0; this.n = 0; }
  push(ms) { this.values[this.head] = ms; this.head = (this.head + 1) % this.values.length; this.n = Math.min(this.n + 1, this.values.length); }
  ordered() { return Array.from({ length: this.n }, (_, i) => this.values[(this.head - this.n + i + this.values.length) % this.values.length]); }
  summary() {
    if (!this.n) return { mean: 0, p50: 0, p95: 0, p99: 0 };
    const a = this.ordered().sort((a, b) => a - b);
    return { mean: a.reduce((sum,v)=>sum+v,0)/a.length, p50: a[Math.floor((a.length - 1) * .5)], p95: a[Math.floor((a.length - 1) * .95)], p99: a[Math.floor((a.length - 1) * .99)] };
  }
}

// Explicit allowlist: never serialize the game, socket, storage, handlers or raw
// network messages. Those contain player credentials and admin login payloads.
export function diagnostics(g, history) {
  const c = g.net?.client, v = g.player?.controllable, p = v?.object3d?.position || g.player?.focus || {};
  const r = g.render?.stats?.() || {};
  return {
    version: VERSION_LABEL, at: new Date().toISOString(), mode: g.mode, paused: !!g.paused,
    render: Object.fromEntries(['fps', 'cpuMs', 'gpuMs', 'drawCalls', 'triangles', 'programs', 'compiles', 'width', 'height', 'quality', 'antialiasing', 'samples', 'appliedScale'].map((k) => [k, r[k] ?? null])),
    frames: history?.summary(),
    network: c ? { status: c.status, rtt: c.clock.rtt, jitter: c.store.jitter || 0, delay: c.store.delay,
      kbps: c.kbps, bufferedBytes: c.ws?.bufferedAmount || 0, remote3d: c.store.list.length, mapTracks: c.tracks.list.length, mapTotal: c.mapTotal,
      corrections: g.net.local?.corrections || 0, records: c.store.stats.records, dissolves: c.store.stats.teleports,
      simulation: c.link?.active ? c.link.profile : 'normal' } : null,
    vehicle: { model: v?.catalogId || 'foot', x: p.x || 0, y: p.y || 0, z: p.z || 0,
      speed: v?.telemetry?.speed ?? 0, health: v?.health ?? v?.damage?.health ?? null },
    world: { roads: g.roads?.edges?.length || 0, crossings: g.roads?.overpasses?.length || 0,
      roadWorkerMs: g.roads?.workerBuildMs || 0, roadHydrateMs: g.roads?.buildMs || 0 },
  };
}
