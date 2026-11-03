import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// version shown in About and on the loading screen: package.json version + UTC build stamp (dev server: "dev")
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const stamp = (d = new Date()) => d.toISOString().slice(0, 16).replace(/-/g, '').replace('T', '.').replace(':', '');
const versionDefine = (dev) => ({ __APP_VERSION__: JSON.stringify(pkg.version), __APP_BUILD__: JSON.stringify(dev ? 'dev' : stamp()) });

export default defineConfig(({ command }) => ({
  define: versionDefine(command === 'serve'),
  server: { host: '127.0.0.1', port: 5317, strictPort: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      // production ships only the game; LABS=1 also builds the lab pages
      input: process.env.LABS ? {
        main: resolve(import.meta.dirname, 'index.html'),
        lab: resolve(import.meta.dirname, 'vehicle-lab.html'),
      } : { main: resolve(import.meta.dirname, 'index.html') },
    },
  },
}));
