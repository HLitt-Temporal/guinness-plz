/*
  Vite serves the React page. In dev it is mounted inside server.ts so the
  page and the API share one origin. The built files go to ../dist, which
  server.ts serves when you run npm start.
*/

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./frontend', import.meta.url)),
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
});
