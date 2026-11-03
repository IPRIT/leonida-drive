import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
export const ADMIN_TTL = 15 * 60 * 1000;

// The deployment tool writes this value to the protected server environment.
// No plaintext password or password verifier belongs in the browser bundle.
export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export class AdminAuth {
  constructor(hash) {
    this.hash = /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash || '') ? hash.split(':') : null;
    this.attempts = new Map(); this.pending = 0;
  }
  get enabled() { return !!this.hash; }
  async verify(ip, password, now) {
    if (!this.hash) return 'disabled';
    if (typeof password !== 'string' || password.length < 1 || password.length > 128) return 'invalid';
    // Gate before expensive crypto. Reconnecting does not reset the IP bucket.
    for (const [key, a] of this.attempts) if (now - a.at > 15 * 60000) this.attempts.delete(key);
    let a = this.attempts.get(ip);
    if (!a) {
      if (this.attempts.size >= 4096) return 'rate';
      this.attempts.set(ip, a = { at: now, n: 0 });
    }
    if (a.n >= 5 || this.pending >= 2) return 'rate';
    a.n++; this.pending++;
    try {
      const candidate = await derive(password, this.hash[1], 64);
      const ok = timingSafeEqual(candidate, Buffer.from(this.hash[2], 'hex'));
      candidate.fill(0);
      // Keep successful authentication bounded too; no unbounded hash oracle.
      return ok ? 'ok' : 'password';
    } finally { this.pending--; }
  }
}
