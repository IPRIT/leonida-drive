// Install only after the game is playable: first-launch work always has priority.
// The worker caches same-origin immutable build/data resources, never API or player traffic.
export function installRuntimeCache() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const start = () => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).then(async () => {
    // register() may resolve while the first worker is still installing.
    const registration = await navigator.serviceWorker.ready;
    const urls = [location.href, ...performance.getEntriesByType('resource').map((e) => e.name)];
    registration.active?.postMessage({ type: 'WARM_URLS', urls });
  }).catch(() => { /* privacy mode / unsupported policy: caching is optional */ });
  // Registration itself is asynchronous and cheap. Do not rely on requestIdleCallback:
  // a GPU-bound device may never report idle time, which would leave repeat launches uncached.
  setTimeout(start, 0);
}
