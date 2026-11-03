// Admission control and the waiting queue, in shared memory (every gateway thread enqueues / leaves; the main thread
// admits). Capacity (MAX_PLAYERS) counts admitted sessions; when it is reached, new connections take a ticket and wait.
//
//  - Tickets are monotonic (u32). A ring of QRING entries holds each ticket's number, state (1 waiting) and gateway;
//    a Fenwick tree over the ring counts waiting tickets, so a position is O(log n) and leaving from the middle is
//    O(log n): nothing is shifted, and nothing is scanned per tick.
//  - The admitter (one thread) walks the head forward over departed tickets (amortised O(1)) and claims waiting ones
//    with a compare-and-swap, so a departure racing with an admission is resolved exactly once.
//  - Leaving is final: a closed socket gives its ticket up; there is no reservation and no resume by token.
// Queued clients cost a WebSocket and a small object: no slot, no world subscription, no per-tick work.

export const QRING = 1 << 16; // > the longest allowed queue (QUEUE_MAX is clamped below it)
const MASK = QRING - 1;
export const Q_NEXT = 0, Q_HEAD = 1, Q_WAITING = 2, Q_ACTIVE = 3, Q_ADMITTED = 4, Q_VERSION = 5, Q_REJECTED = 6;
const Q_HDR = 8;

export function createQueueShared() {
  return {
    qHdr: new SharedArrayBuffer(Q_HDR * 4),
    qRate: new SharedArrayBuffer(8), // Float64: admissions per second, smoothed over about a minute
    qTicket: new SharedArrayBuffer(QRING * 4),
    qState: new SharedArrayBuffer(QRING),
    qOwner: new SharedArrayBuffer(QRING),
    qFen: new SharedArrayBuffer((QRING + 1) * 4),
  };
}

export function queueViews(s) {
  return {
    hdr: new Int32Array(s.qHdr), uhdr: new Uint32Array(s.qHdr), rate: new Float64Array(s.qRate),
    ticket: new Uint32Array(s.qTicket), state: new Uint8Array(s.qState), owner: new Uint8Array(s.qOwner), fen: new Int32Array(s.qFen),
    // admitter-local (one thread): admissions counted for the rate estimate
    sec: 0, n: 0,
  };
}

function fenAdd(q, i, d) { for (i += 1; i <= QRING; i += i & -i) Atomics.add(q.fen, i, d); }
function fenSum(q, i) { let s = 0; for (; i > 0; i -= i & -i) s += Atomics.load(q.fen, i); return s; } // waiting in ring [0, i)

/** Waiting tickets in [a, b) (ticket numbers, b - a < QRING). */
function countRange(q, a, b) {
  if (a === b) return 0;
  const ia = a & MASK, ib = b & MASK;
  return ia < ib ? fenSum(q, ib) - fenSum(q, ia) : fenSum(q, QRING) - fenSum(q, ia) + fenSum(q, ib);
}

/**
 * A new session wants in. → { admitted: true } (capacity taken) | { ticket } (queued) | { full: true } (queue cap).
 * Nobody jumps the queue: with anyone waiting, newcomers queue even if a slot just freed (the admitter fills it).
 */
export function enter(q, gwId, capacity, queueMax) {
  if (Atomics.load(q.hdr, Q_WAITING) === 0) {
    for (;;) {
      const a = Atomics.load(q.hdr, Q_ACTIVE);
      if (a >= capacity) break;
      if (Atomics.compareExchange(q.hdr, Q_ACTIVE, a, a + 1) === a) return { admitted: true };
    }
  }
  // the ring spans [head, next): refuse before it could wrap onto a ticket that may still be waiting (the margin
  // covers gateways allocating concurrently)
  if (Atomics.load(q.hdr, Q_WAITING) >= queueMax || ((Atomics.load(q.uhdr, Q_NEXT) - Atomics.load(q.uhdr, Q_HEAD)) >>> 0) >= QRING - 256) {
    Atomics.add(q.uhdr, Q_REJECTED, 1);
    return { full: true };
  }
  const t = Atomics.add(q.uhdr, Q_NEXT, 1) >>> 0;
  const i = t & MASK;
  q.owner[i] = gwId;
  fenAdd(q, i, 1);
  Atomics.add(q.hdr, Q_WAITING, 1);
  Atomics.store(q.state, i, 1);
  Atomics.store(q.ticket, i, t); // last: the admitter treats the entry as published once it carries this ticket
  return { ticket: t };
}

/** The socket went away while waiting: give the place up (false if it was admitted in the meantime). */
export function leave(q, ticket) {
  const i = ticket & MASK;
  if (Atomics.load(q.ticket, i) !== (ticket >>> 0) || Atomics.compareExchange(q.state, i, 1, 0) !== 1) return false;
  fenAdd(q, i, -1);
  Atomics.sub(q.hdr, Q_WAITING, 1);
  Atomics.add(q.hdr, Q_VERSION, 1);
  return true;
}

/** 1-based position of a waiting ticket (0 if it is not waiting any more). O(log n). */
export function position(q, ticket) {
  const i = ticket & MASK;
  if (Atomics.load(q.state, i) !== 1 || Atomics.load(q.ticket, i) !== (ticket >>> 0)) return 0;
  return countRange(q, Atomics.load(q.uhdr, Q_HEAD), ticket >>> 0) + 1;
}

/** An admitted (or directly joined) session ended, or an admission found its socket gone: capacity back. */
export function release(q) { Atomics.sub(q.hdr, Q_ACTIVE, 1); }

/**
 * Admitter (one thread, every tick; returns at once while nobody waits or nothing is free). Claims waiting tickets in
 * order and calls notify(gatewayId, ticket) for each; the gateway then sends ADMIT and runs the join.
 */
export function admit(q, capacity, notify, now = Date.now()) {
  let n = 0;
  if (Atomics.load(q.hdr, Q_WAITING) > 0 || Atomics.load(q.uhdr, Q_HEAD) !== Atomics.load(q.uhdr, Q_NEXT)) {
    let head = Atomics.load(q.uhdr, Q_HEAD);
    const next = Atomics.load(q.uhdr, Q_NEXT);
    while (head !== next) {
      const i = head & MASK;
      if (Atomics.load(q.ticket, i) !== head) break; // still being published by its gateway: next tick
      if (Atomics.load(q.state, i) === 1) {
        if (Atomics.load(q.hdr, Q_ACTIVE) >= capacity) break;
        if (Atomics.compareExchange(q.state, i, 1, 0) === 1) {
          fenAdd(q, i, -1);
          Atomics.sub(q.hdr, Q_WAITING, 1);
          Atomics.add(q.hdr, Q_ACTIVE, 1);
          Atomics.add(q.uhdr, Q_ADMITTED, 1);
          notify(q.owner[i], head);
          n++;
        }
      }
      head = (head + 1) >>> 0;
    }
    Atomics.store(q.uhdr, Q_HEAD, head);
    if (n) Atomics.add(q.hdr, Q_VERSION, 1);
  }
  // admissions per second, smoothed over about a minute (ETA estimates)
  q.n += n;
  const sec = Math.floor(now / 1000);
  if (sec !== q.sec) {
    if (q.sec) q.rate[0] = q.rate[0] * 0.983 + (q.n / Math.min(60, sec - q.sec)) * 0.017;
    q.sec = sec;
    q.n = 0;
  }
  return n;
}

/** Seconds until a position is admitted at the recent admission rate (null while unknown). */
export function etaSec(q, pos) {
  const r = q.rate[0];
  return r > 0.002 ? Math.round(pos / r) : null;
}

export function stats(q) {
  return {
    waiting: Atomics.load(q.hdr, Q_WAITING), active: Atomics.load(q.hdr, Q_ACTIVE), admitted: Atomics.load(q.uhdr, Q_ADMITTED),
    rejected: Atomics.load(q.uhdr, Q_REJECTED), perMin: q.rate[0] * 60,
  };
}
