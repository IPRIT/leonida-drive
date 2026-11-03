// Container health probe: exit 0 when GET /health answers ok (used by the Dockerfile HEALTHCHECK).
import { loadConfig } from './config.js';

const { port } = loadConfig();
try {
  const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) });
  process.exit(r.ok ? 0 : 1);
} catch {
  process.exit(1);
}
