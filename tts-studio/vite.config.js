import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The UI lives in client/. In dev, /api is proxied to the Node server.
export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  build: { outDir: '../dist', emptyOutDir: true },
});
