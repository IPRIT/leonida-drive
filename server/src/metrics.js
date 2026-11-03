// /health (JSON) and /metrics (Prometheus text). Everything is read from shared memory, so any gateway thread can
// answer for the whole process.
import {
  STATS, STAT_CONN, STAT_MSGS_IN, STAT_BYTES_IN, STAT_PUB_BYTES, STAT_DIRECT_BYTES, STAT_KICKS, STAT_VIOLATIONS, STAT_CLAIMS_OK,
  STAT_CLAIMS_BAD, STAT_SESSIONS, STAT_REJECTED_UPGRADES, STAT_PUBLISHES, STAT_CORRECTIONS, STAT_LAG_TICKS,
  H_TICK, H_TICK_MS, H_TICK_MS_MAX, H_ONLINE, H_VISIBLE, H_ARENA_BYTES, H_TOTAL_PLAYERS, H_START_MS, H_TICK_P99, H_ENC_RECORDS, H_DROPPED_TICKS, H_EGRESS, H_BUDGET,
} from './shared-mem.js';
import { stats as queueStats } from './queue.js';

function sum(v, i) {
  let s = 0;
  for (let w = 0; w < Math.max(1, v.workers); w++) s += v.stats[w * STATS + i];
  return s;
}

export function renderHealth(v, cfg) {
  const h = v.hub, q = queueStats(v.q);
  return JSON.stringify({
    ok: true,
    online: h[H_ONLINE],
    admitted: q.active,
    capacity: cfg.capacity,
    queue: q.waiting,
    admitted_per_min: +q.perMin.toFixed(1),
    visible: h[H_VISIBLE],
    tick: h[H_TICK],
    tick_ms: +h[H_TICK_MS].toFixed(3),
    tick_p99_ms: +h[H_TICK_P99].toFixed(3),
    egress_mbps: +((h[H_EGRESS] * 8) / 1e6).toFixed(2),
    total_players: h[H_TOTAL_PLAYERS],
    uptime_s: Math.round((Date.now() - h[H_START_MS]) / 1000),
    version: cfg.version,
    workers: v.workers,
  });
}

export function renderMetrics(v, cfg) {
  const h = v.hub, mem = process.memoryUsage();
  const lines = [];
  const g = (name, help, val, type = 'gauge') => { lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${Number.isFinite(val) ? val : 0}`); };
  g('leonida_online', 'Connected players', h[H_ONLINE]);
  const q = queueStats(v.q);
  g('leonida_capacity', 'Admission capacity (MAX_PLAYERS)', cfg.capacity);
  g('leonida_admitted', 'Sessions holding capacity (in the world or joining)', q.active);
  g('leonida_queue_length', 'Connections waiting in the queue', q.waiting);
  g('leonida_queue_admitted_total', 'Connections admitted from the queue', q.admitted, 'counter');
  g('leonida_queue_admitted_per_minute', 'Admissions from the queue per minute (smoothed)', q.perMin);
  g('leonida_queue_rejected_total', 'Connections refused because the queue was full', q.rejected, 'counter');
  g('leonida_visible', 'Players visible in the world (sending state)', h[H_VISIBLE]);
  g('leonida_players_total', 'Registered players (database)', h[H_TOTAL_PLAYERS]);
  g('leonida_tick', 'Current hub tick', h[H_TICK], 'counter');
  g('leonida_tick_ms', 'Hub tick duration, EWMA (ms)', h[H_TICK_MS]);
  g('leonida_tick_p99_ms', 'Hub tick duration, p99 over the last 600 ticks (ms)', h[H_TICK_P99]);
  g('leonida_tick_max_ms', 'Hub tick duration, max since start (ms)', h[H_TICK_MS_MAX]);
  g('leonida_dropped_ticks_total', 'Ticks skipped because a gateway was still publishing', h[H_DROPPED_TICKS], 'counter');
  g('leonida_arena_bytes', 'Bytes encoded by the hub in the last tick (all topics, before fan-out)', h[H_ARENA_BYTES]);
  g('leonida_records_last_tick', 'Entity records encoded in the last tick', h[H_ENC_RECORDS]);
  g('leonida_egress_bytes_per_second', 'Pub/sub egress (bytes x subscribers), EWMA, computed by the hub', h[H_EGRESS]);
  g('leonida_budget_scale', 'Per-cell record budget scale applied by the egress controller (1 = full)', h[H_BUDGET]);
  g('leonida_connections_total', 'WebSocket connections accepted', sum(v, STAT_CONN), 'counter');
  g('leonida_sessions', 'Open sessions (all gateways)', sum(v, STAT_SESSIONS));
  g('leonida_rejected_upgrades_total', 'Rejected WebSocket upgrades (origin, per-IP limits, capacity)', sum(v, STAT_REJECTED_UPGRADES), 'counter');
  g('leonida_messages_in_total', 'Client messages received', sum(v, STAT_MSGS_IN), 'counter');
  g('leonida_bytes_in_total', 'Client bytes received', sum(v, STAT_BYTES_IN), 'counter');
  g('leonida_pubsub_bytes_out_total', 'Estimated bytes fanned out by pub/sub (sampled)', sum(v, STAT_PUB_BYTES), 'counter');
  g('leonida_direct_bytes_out_total', 'Bytes sent directly to clients', sum(v, STAT_DIRECT_BYTES), 'counter');
  g('leonida_publishes_total', 'Pub/sub publishes', sum(v, STAT_PUBLISHES), 'counter');
  g('leonida_kicks_total', 'Kicked connections', sum(v, STAT_KICKS), 'counter');
  g('leonida_violations_total', 'Rejected client messages (movement, rate)', sum(v, STAT_VIOLATIONS), 'counter');
  g('leonida_corrections_total', 'Movement corrections sent', sum(v, STAT_CORRECTIONS), 'counter');
  g('leonida_claims_granted_total', 'Granted earn claims', sum(v, STAT_CLAIMS_OK), 'counter');
  g('leonida_claims_rejected_total', 'Rejected earn claims', sum(v, STAT_CLAIMS_BAD), 'counter');
  g('leonida_gateway_lag_ticks_total', 'Ticks a gateway could not publish in time', sum(v, STAT_LAG_TICKS), 'counter');
  g('process_resident_memory_bytes', 'Resident memory', mem.rss);
  g('process_heap_used_bytes', 'V8 heap used (this thread)', mem.heapUsed);
  const cpu = process.cpuUsage();
  g('process_cpu_seconds_total', 'User + system CPU time of the process', (cpu.user + cpu.system) / 1e6, 'counter');
  return lines.join('\n') + '\n';
}

export { H_START_MS, STAT_DIRECT_BYTES, STAT_KICKS, STAT_VIOLATIONS, STAT_CLAIMS_OK, STAT_CLAIMS_BAD, STAT_CORRECTIONS };
