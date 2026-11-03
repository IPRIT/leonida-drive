// Minimal leveled logger (stdout, one line per event; Docker/systemd capture it).
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
export function makeLogger(level = 'info', prefix = '') {
  const min = LEVELS[level] ?? 20;
  const out = (lvl, fn) => (...a) => { if (LEVELS[lvl] >= min) fn(`${new Date().toISOString()} ${lvl.toUpperCase()}${prefix ? ' ' + prefix : ''}`, ...a); };
  return { debug: out('debug', console.log), info: out('info', console.log), warn: out('warn', console.warn), error: out('error', console.error) };
}
