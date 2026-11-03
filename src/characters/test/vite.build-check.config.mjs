// Build check including the characters lab: npx vite build --config src/characters/test/vite.build-check.config.mjs
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
export default defineConfig({
  root,
  logLevel: 'warn',
  build: {
    target: 'es2022',
    outDir: process.env.OUT_DIR || '/tmp/leonida-chars-build',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { main: resolve(root, 'index.html'), characters: resolve(root, 'lab-characters.html') } },
  },
});
