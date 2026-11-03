// Multiplayer status for the start screen: the public player count (GET /status on the game server, cached 5 s,
// O(1) on the server) and the live connection the net module opened while the world loads (it may already be
// waiting in line). No DOM, no game object: the loading screen uses it before the game exists.
import { serverUrl } from './NetClient.js';

/** http(s)://host/status for the game server (derived from its WebSocket URL). */
export function statusUrl(wsUrl = serverUrl()) {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '/status';
  u.search = '';
  return u.toString();
}

/** → { ok, online, queue, capacity } or null (unreachable, old server, timeout). */
export async function fetchStatus(timeoutMs = 4000) {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = setTimeout(() => ac?.abort(), timeoutMs);
  try {
    const r = await fetch(statusUrl(), { signal: ac?.signal, mode: 'cors', credentials: 'omit' });
    if (!r.ok) return null;
    const j = await r.json();
    return j && Number.isFinite(j.online) ? { ok: !!j.ok, online: j.online, queue: j.queue | 0, capacity: j.capacity | 0 } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Calls cb(status | null) now and every `everyMs` until the returned stop() is called. */
export function pollStatus(cb, everyMs = 10000) {
  let stopped = false, timer = null;
  const tick = async () => {
    const s = await fetchStatus();
    if (stopped) return;
    cb(s);
    timer = setTimeout(tick, everyMs);
  };
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}

// The net module's connection, for the start screen (set by preconnectNet / createNet; null in singleplayer).
const listeners = new Set();
export const netGate = {
  client: null,
  set(client) {
    if (this.client === client) return;
    this.client = client;
    if (client) for (const ev of ['status', 'queue', 'admit', 'welcome']) client.on(ev, () => { for (const fn of listeners) fn(client); });
    for (const fn of listeners) fn(client);
  },
  /** cb(client) on every status / queue change; returns an unsubscribe function. */
  on(cb) { listeners.add(cb); return () => listeners.delete(cb); },
};
