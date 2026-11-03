// Entry point: `node src/main.js` (env: PORT, DB_PATH, ALLOWED_ORIGINS, TICK_HZ, WORKERS, ... see README.md).
import { startServer } from './server.js';

const srv = await startServer();
let stopping = false;
const stop = async (sig) => {
  if (stopping) return;
  stopping = true;
  console.log(`${new Date().toISOString()} INFO ${sig}: saving and shutting down`);
  const hard = setTimeout(() => process.exit(1), 15000);
  hard.unref();
  try { await srv.close(); } catch (e) { console.error(e); }
  process.exit(0);
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
process.on('uncaughtException', (e) => { console.error('uncaught', e); stop('uncaughtException'); });
