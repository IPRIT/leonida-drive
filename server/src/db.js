// Persistence: node:sqlite in WAL mode. Players are keyed by SHA-256(token); the raw token never touches the disk.
// Write-behind: gateways batch dirty records and the store upserts them in one transaction.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { netWorth, WORTH_FRACTION } from '../../src/economy/rules.js';

export const FLAG_FROZEN = 1; // claims frozen (suspected cheating): excluded from the leaderboard
export const FLAG_BANNED = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  token_hash BLOB PRIMARY KEY,
  nick TEXT NOT NULL,
  nick_code INTEGER NOT NULL,
  color INTEGER NOT NULL,
  money INTEGER NOT NULL DEFAULT 0,
  x REAL, y REAL, z REAL, yaw REAL,
  mode INTEGER NOT NULL DEFAULT 1,
  vehicle_id TEXT,
  paint INTEGER NOT NULL DEFAULT 0,
  health REAL NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  stats TEXT NOT NULL DEFAULT '{}',
  flags INTEGER NOT NULL DEFAULT 0,
  owned TEXT NOT NULL DEFAULT '[]',
  progress TEXT NOT NULL DEFAULT '{}',
  worth INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS security_log (
  ts INTEGER NOT NULL, token_hash BLOB, kind TEXT NOT NULL, detail TEXT
);
CREATE INDEX IF NOT EXISTS security_log_ts ON security_log(ts);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

export class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;');
    this.db.exec(SCHEMA);
    // migrations for databases created by older builds
    const cols = new Set(this.db.prepare('PRAGMA table_info(players)').all().map((r) => r.name));
    if (!cols.has('owned')) this.db.exec("ALTER TABLE players ADD COLUMN owned TEXT NOT NULL DEFAULT '[]'");
    if (!cols.has('progress')) this.db.exec("ALTER TABLE players ADD COLUMN progress TEXT NOT NULL DEFAULT '{}'");
    if (!cols.has('worth')) this.db.exec('ALTER TABLE players ADD COLUMN worth INTEGER NOT NULL DEFAULT 0');
    if (!cols.has('garage')) this.db.exec("ALTER TABLE players ADD COLUMN garage TEXT NOT NULL DEFAULT '{}'");
    if (!cols.has('wardrobe')) this.db.exec("ALTER TABLE players ADD COLUMN wardrobe TEXT NOT NULL DEFAULT '{}'");
    // custom nicknames: written only by claimNick (never by the write-behind upsert), unique case-insensitively
    if (!cols.has('custom_nick')) this.db.exec("ALTER TABLE players ADD COLUMN custom_nick TEXT NOT NULL DEFAULT ''");
    if (!cols.has('custom_lower')) this.db.exec('ALTER TABLE players ADD COLUMN custom_lower TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS players_worth ON players(worth DESC)');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS players_custom_nick ON players(custom_lower) WHERE custom_lower IS NOT NULL');
    this.qLoad = this.db.prepare('SELECT * FROM players WHERE token_hash = ?');
    this.qUpsert = this.db.prepare(`INSERT INTO players (token_hash, nick, nick_code, color, money, x, y, z, yaw, mode, vehicle_id, paint, health,
        created_at, last_seen, stats, flags, owned, progress, worth, garage, wardrobe)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_hash) DO UPDATE SET nick = excluded.nick, nick_code = excluded.nick_code, color = excluded.color,
        money = excluded.money, x = excluded.x, y = excluded.y, z = excluded.z, yaw = excluded.yaw, mode = excluded.mode,
        vehicle_id = excluded.vehicle_id, paint = excluded.paint, health = excluded.health, last_seen = excluded.last_seen,
        stats = excluded.stats, flags = excluded.flags, owned = excluded.owned, progress = excluded.progress, worth = excluded.worth,
        garage = excluded.garage, wardrobe = excluded.wardrobe`);
    // leaderboard: net worth = cash + 55% of owned vehicles (docs/ECONOMY.md)
    this.qTop = this.db.prepare(`SELECT token_hash, nick_code, custom_nick, color, worth, money FROM players WHERE (flags & ${FLAG_FROZEN | FLAG_BANNED}) = 0 ORDER BY worth DESC LIMIT ?`);
    this.qCount = this.db.prepare('SELECT COUNT(*) AS n FROM players');
    this.qMoney = this.db.prepare(`SELECT worth FROM players WHERE (flags & ${FLAG_FROZEN | FLAG_BANNED}) = 0 ORDER BY worth DESC`);
    this.qLog = this.db.prepare('INSERT INTO security_log (ts, token_hash, kind, detail) VALUES (?, ?, ?, ?)');
    this.qPrune = this.db.prepare('DELETE FROM security_log WHERE ts < ?');
    // retention: profiles nobody has used for a long time and that never got anywhere (never earned, no custom name,
    // never flagged) are deleted; anything with progress is kept
    this.qPruneStale = this.db.prepare(`DELETE FROM players WHERE last_seen < ? AND flags = 0 AND custom_lower IS NULL AND money <= ?
      AND COALESCE(json_extract(stats, '$.earned'), 0) <= 0 AND COALESCE(json_extract(stats, '$.claims'), 0) = 0`);
    this.qNickOwner = this.db.prepare('SELECT token_hash FROM players WHERE custom_lower = ?');
    this.qSetNick = this.db.prepare('UPDATE players SET custom_nick = ?, custom_lower = ? WHERE token_hash = ?');
  }

  /** Rebuild the derived leaderboard cache once per formula / price version, including offline profiles. */
  revalueWorth(prices) {
    const rows = [...prices].map(([id, p]) => [id, p.price, !!p.starter]).sort((a, b) => a[0].localeCompare(b[0]));
    const version = createHash('sha256').update(JSON.stringify(['sellable-vehicles-v1', WORTH_FRACTION, rows])).digest('hex');
    const key = 'worth_formula';
    if (this.db.prepare('SELECT v FROM meta WHERE k = ?').get(key)?.v === version) return 0;
    const update = this.db.prepare('UPDATE players SET worth = ? WHERE token_hash = ? AND worth <> ?');
    let changed = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of this.db.prepare('SELECT token_hash, money, owned FROM players').iterate()) {
        const owned = json(r.owned, []);
        const worth = netWorth(r.money, Array.isArray(owned) ? owned : [], prices);
        changed += update.run(worth, r.token_hash, worth).changes;
      }
      this.db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(key, version);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return changed;
  }

  /** True when `name` (case-insensitive) belongs to another profile. */
  nickOwner(hash, name) {
    const o = name ? this.qNickOwner.get(name.toLowerCase()) : null;
    return !!o && Buffer.compare(Buffer.from(o.token_hash), Buffer.from(hash)) !== 0;
  }

  /**
   * Claim a custom nickname (case-insensitive unique) for `hash`, or release it with name ''. Atomic (single DB
   * thread + transaction). → 'ok' | 'taken' | 'missing' (no saved record yet: retry in a moment)
   */
  claimNick(hash, name) {
    const lower = name ? name.toLowerCase() : null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (lower) {
        const owner = this.qNickOwner.get(lower);
        if (owner && Buffer.compare(Buffer.from(owner.token_hash), Buffer.from(hash)) !== 0) { this.db.exec('ROLLBACK'); return 'taken'; }
      }
      const r = this.qSetNick.run(name || '', lower, hash);
      this.db.exec('COMMIT');
      return r.changes ? 'ok' : 'missing';
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
      if (/UNIQUE/.test(e.message)) return 'taken';
      throw e;
    }
  }

  /** Player record by token hash (Uint8Array(32)) or null. */
  load(hash) {
    const r = this.qLoad.get(hash);
    if (!r) return null;
    return {
      nick: r.nick, nickCode: r.nick_code, color: r.color, money: r.money,
      x: r.x, y: r.y, z: r.z, yaw: r.yaw, mode: r.mode, vehicleId: r.vehicle_id || '', paint: r.paint, health: r.health,
      createdAt: r.created_at, lastSeen: r.last_seen, stats: json(r.stats, {}), flags: r.flags,
      owned: json(r.owned, []), progress: json(r.progress, {}), worth: r.worth,
      garage: json(r.garage, {}), wardrobe: json(r.wardrobe, {}), customNick: r.custom_nick || '',
    };
  }

  /** Upsert many records in one transaction. rec.hash = Uint8Array(32). */
  saveMany(recs) {
    if (!recs.length) return 0;
    this.db.exec('BEGIN');
    try {
      for (const r of recs) {
        this.qUpsert.run(r.hash, r.nick, r.nickCode, r.color, Math.max(0, Math.round(r.money)),
          finite(r.x), finite(r.y), finite(r.z), finite(r.yaw), r.mode | 0, r.vehicleId || null, r.paint >>> 0, finite(r.health, 1),
          r.createdAt, r.lastSeen, JSON.stringify(r.stats || {}), r.flags | 0, JSON.stringify(r.owned || []), JSON.stringify(r.progress || {}),
          Math.max(0, Math.round(r.worth ?? r.money)), JSON.stringify(r.garage || {}), JSON.stringify(r.wardrobe || {}));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return recs.length;
  }

  top(n = 10) {
    return this.qTop.all(n).map((r) => ({ hash: r.token_hash, nickCode: r.nick_code, name: r.custom_nick || '', color: r.color, money: r.worth, cash: r.money }));
  }

  count() { return this.qCount.get().n; }

  /** All non-frozen net worths sorted descending (for rank lookups), written into `out` (Float64Array). Returns count. */
  worthInto(out) {
    let n = 0;
    for (const r of this.qMoney.iterate()) {
      if (n >= out.length) break;
      out[n++] = r.worth;
    }
    return n;
  }

  log(hash, kind, detail) {
    this.qLog.run(Date.now(), hash || null, String(kind).slice(0, 40), detail ? String(detail).slice(0, 500) : null);
  }

  /** Delete security-log rows older than maxAgeMs (default 30 days). Returns the number deleted. */
  pruneLog(maxAgeMs = 30 * 864e5, now = Date.now()) { return Number(this.qPrune.run(now - maxAgeMs).changes); }

  /** Delete profiles unused for maxAgeMs (default 180 days) that never made progress. Returns the number deleted. */
  pruneStale(maxAgeMs = 180 * 864e5, startMoney = 5000, now = Date.now()) { return Number(this.qPruneStale.run(now - maxAgeMs, startMoney).changes); }

  checkpoint() { try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* busy: try later */ } }

  close() {
    this.checkpoint();
    this.db.close();
  }
}

function finite(v, d = 0) { return Number.isFinite(v) ? v : d; }
function json(s, d) { try { const v = JSON.parse(s); return v ?? d; } catch { return d; } }
