// IP privacy. Raw client IPs live only in memory (per-IP connection limits). Anything that is logged or persisted
// gets the masked network instead (IPv4 → a.b.c.0/24, IPv6 → the first 48 bits) plus, for correlating abuse, a
// short keyed hash that changes every UTC day: HMAC-SHA256(daily key, ip), daily key = HMAC(IP_HASH_SECRET, date).
// Without IP_HASH_SECRET the server makes a random one at start (tags then also change on every restart).
import crypto from 'node:crypto';

/** Expand an IPv6 text form into 8 numbers (null if it is not IPv6). Handles '::', zone ids and a trailing IPv4. */
function ipv6Words(ip) {
  let s = ip.trim().toLowerCase();
  if (s.startsWith('[')) s = s.slice(1, s.indexOf(']') > 0 ? s.indexOf(']') : undefined);
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return null;
  const lastColon = s.lastIndexOf(':');
  if (s.slice(lastColon + 1).includes('.')) { // ::ffff:1.2.3.4 → ::ffff:102:304
    const v4 = ipv4Bytes(s.slice(lastColon + 1));
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [], back = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - back.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const words = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...back];
  if (words.length !== 8 || !words.every((w) => /^[0-9a-f]{1,4}$/.test(w))) return null;
  return words.map((w) => parseInt(w, 16));
}

function ipv4Bytes(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}

/** Network of an address for logs: IPv4 → 'a.b.c.0/24', IPv6 → 'x:y:z::/48'. Anything else → '?'. */
export function maskIp(ip) {
  if (typeof ip !== 'string' || !ip) return '?';
  const v4 = ipv4Bytes(ip);
  if (v4) return `${v4[0]}.${v4[1]}.${v4[2]}.0/24`;
  const w = ipv6Words(ip);
  if (!w) return '?';
  // IPv4-mapped (::ffff:a.b.c.d) is really IPv4
  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0xffff) {
    return `${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.0/24`;
  }
  return `${w[0].toString(16)}:${w[1].toString(16)}:${w[2].toString(16)}::/48`;
}

let secret = null;
const dayKeys = new Map(); // 'YYYY-MM-DD' → key (two days at most)

/** Set the server secret (IP_HASH_SECRET); called once per thread from the config. */
export function setIpSecret(s) {
  secret = s ? Buffer.from(String(s)) : null;
  dayKeys.clear();
}

function dayKey(now) {
  const day = new Date(now).toISOString().slice(0, 10);
  let k = dayKeys.get(day);
  if (!k) {
    if (!secret) secret = crypto.randomBytes(32);
    k = crypto.createHmac('sha256', secret).update(`leonida-ip-tag:${day}`).digest();
    dayKeys.clear(); // yesterday's key is never needed again: tags cannot be linked across days
    dayKeys.set(day, k);
  }
  return k;
}

/** Keyed, daily-rotating tag of an address (10 hex chars): the same IP gives the same tag within one UTC day. */
export function ipTag(ip, now = Date.now()) {
  if (typeof ip !== 'string' || !ip) return '-';
  return crypto.createHmac('sha256', dayKey(now)).update(ip.trim().toLowerCase()).digest('hex').slice(0, 10);
}

/** 'net=a.b.c.0/24 ipk=…' for log lines and the security log. */
export function ipForLog(ip, now = Date.now()) {
  return `net=${maskIp(ip)} ipk=${ipTag(ip, now)}`;
}
