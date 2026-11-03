// Transport selection: uWebSockets.js (native pub/sub, C++ fan-out, multi-threaded acceptor) with a pure-JS `ws`
// fallback that keeps the same API subset (single-threaded, encode-once buffers fanned out in JS).
export async function loadTransport(pref = 'auto', log = console) {
  if (pref !== 'ws') {
    try {
      const m = await import('uWebSockets.js');
      const uWS = m.default || m;
      return { kind: 'uws', App: () => uWS.App(), uWS };
    } catch (e) {
      if (pref === 'uws') throw e;
      // production should never silently lose the multi-threaded transport (wrong Node ABI, musl libc, …)
      const say = process.env.NODE_ENV === 'production' ? log.error : log.warn;
      say?.(`[transport] uWebSockets.js unavailable (${e.message.split('\n')[0]}), falling back to ws (single thread, ~10x lower capacity). Use Node 22/24 LTS on glibc Linux.`);
    }
  }
  const { App } = await import('./transport-ws.js');
  return { kind: 'ws', App, uWS: null };
}
