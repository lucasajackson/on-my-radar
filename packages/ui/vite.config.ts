import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_TARGET = process.env['API_TARGET'] ?? 'http://127.0.0.1:3500';

/** Paths the SPA does not own — proxied to the API in dev, same-origin in prod. */
const proxied = ['/api', '/mcp', '/oauth', '/health', '/.well-known'];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5273,
    proxy: Object.fromEntries(
      proxied.map((path) => [path, { target: API_TARGET, changeOrigin: true }]),
    ),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Hashed filenames under /assets are what the server caches immutably.
    assetsDir: 'assets',
  },
});
