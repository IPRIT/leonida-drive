// Server configuration from environment variables (see server/README.md).
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const int = (v, d) => (v === undefined || v === '' || !Number.isFinite(+v) ? d : Math.trunc(+v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export function loadConfig(env = process.env) {
  const cpus = os.availableParallelism?.() ?? os.cpus().length;
  const workersEnv = env.WORKERS ?? 'auto';
  // auto: one gateway thread per spare core (the hub and the DB writer get their own threads)
  const workers = workersEnv === 'auto' ? Math.max(1, Math.min(16, cpus - 2)) : Math.max(0, int(workersEnv, 1));
  const origins = (env.ALLOWED_ORIGINS ?? 'http://localhost:*,http://127.0.0.1:*,https://leonida-drive.io,https://www.leonida-drive.io')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return {
    port: int(env.PORT, 8787),
    host: env.HOST || '0.0.0.0',
    extraPorts: (env.EXTRA_PORTS || '').split(',').map((s) => int(s, 0)).filter((p) => p > 0), // load tests: >16k sockets from one IP
    dbPath: env.DB_PATH || path.resolve(here, '../data/leonida.db'),
    allowedOrigins: origins,
    allowNoOrigin: bool(env.ALLOW_NO_ORIGIN, false), // non-browser clients (bots); browsers always send Origin
    tickHz: Math.max(5, Math.min(60, int(env.TICK_HZ, 20))),
    workers,
    // admission: at most this many players in the world; more connections wait in a FIFO queue (QUEUE_MAX long)
    capacity: Math.max(1, int(env.MAX_PLAYERS, 1000)),
    queueMax: Math.min(60000, Math.max(0, int(env.QUEUE_MAX, 20000))),
    admitGraceMs: Math.max(3000, int(env.ADMIT_GRACE_MS, 15000)), // an admitted client must answer the WELCOME within this
    maxPlayers: Math.min(131072, Math.max(64, int(env.MAX_SLOTS, 131072))), // slot table (≥ capacity per gateway thread)
    maxConnPerIp: Math.max(1, int(env.MAX_CONN_PER_IP, 8)),
    connRatePerIp: Math.max(1, int(env.CONN_RATE_PER_IP, 20)), // new connections per IP per minute
    trustProxy: bool(env.TRUST_PROXY, false), // take the client IP from X-Forwarded-For / X-Real-IP (behind Caddy)
    metricsToken: env.METRICS_TOKEN || '', // optional bearer token for /metrics
    adminPasswordHash: env.ADMIN_PASSWORD_HASH || '', // optional self-admin; scrypt verifier only
    // key for the daily-rotating IP tags in logs (src/privacy.js). Without it: random per process start. Never logged.
    ipHashSecret: env.IP_HASH_SECRET || crypto.randomBytes(32).toString('hex'),
    logRetentionDays: Math.max(1, int(env.LOG_RETENTION_DAYS, 30)), // security_log rows
    staleProfileDays: Math.max(30, int(env.STALE_PROFILE_DAYS, 180)), // profiles that never progressed
    worldData: env.WORLD_DATA || path.resolve(here, '../../public/data'), // world.json + height.bin (optional)
    nearBudget: Math.max(4, int(env.NEAR_BUDGET, 16)), // max records per near cell per tick
    farBudget: Math.max(2, int(env.FAR_BUDGET, 8)), // max records per far cell per far tick
    egressMbps: Math.max(0, int(env.EGRESS_MBPS, 0)), // pub/sub egress target (Mbit/s); 0 = unlimited. ~70% of the NIC
    spawnCooldownS: Math.max(1, int(env.SPAWN_COOLDOWN_S, 8)),
    startMoney: Math.max(0, int(env.START_MONEY, 5000)),
    // LOAD TESTS ONLY: a new connection's first position may be anywhere on the map (bots spread over the city).
    // Never enable in production: it lets a fresh session skip the spawn-area check once.
    joinAnywhere: env.JOIN_ANYWHERE === '1',
    flushMs: Math.max(250, int(env.FLUSH_MS, 2000)),
    posFlushMs: Math.max(1000, int(env.POS_FLUSH_MS, 10000)),
    transport: env.TRANSPORT || 'auto', // auto | uws | ws
    logLevel: env.LOG_LEVEL || 'info',
    version: '0.3.0',
  };
}

/** Origin allowlist check. Patterns: exact origin, 'scheme://host:*' (any port) or '*' (anything, dev only). */
export function originAllowed(origin, cfg) {
  if (!origin) return cfg.allowNoOrigin;
  for (const p of cfg.allowedOrigins) {
    if (p === '*' || p === origin) return true;
    if (p.endsWith(':*')) {
      const base = p.slice(0, -2);
      if (origin === base || (origin.startsWith(base + ':') && /^\d{1,5}$/.test(origin.slice(base.length + 1)))) return true;
    }
  }
  return false;
}
