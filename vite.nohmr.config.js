import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

// version shown in About and on the loading screen: package.json version + UTC build stamp (dev server: "dev")
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const stamp = (d = new Date()) => d.toISOString().slice(0, 16).replace(/-/g, '').replace('T', '.').replace(':', '');
const versionDefine = (dev) => ({ __APP_VERSION__: JSON.stringify(pkg.version), __APP_BUILD__: JSON.stringify(dev ? 'dev' : stamp()) });

// Integrator's test server: no HMR pushes, so pages don't reload while other workstreams edit files.
// File watching stays on so a manual reload always gets fresh modules.
export default defineConfig({
  define: versionDefine(true),
  server: { host: '127.0.0.1', port: 5320, strictPort: true, hmr: false },
});
