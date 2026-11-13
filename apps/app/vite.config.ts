import { defineConfig, type ServerOptions } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const host = process.env.TAURI_DEV_HOST;

const server: ServerOptions = {
  port: 1420,
  strictPort: true,
  host: host || false,
  watch: { ignored: ['**/src-tauri/**'] },
};
if (host) server.hmr = { protocol: 'ws', host, port: 1421 };

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server,
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari15',
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // the TavernHelper realm pages (DEV_NOTES §9.5) are entries of their own
    rollupOptions: {
      input: { main: 'index.html', hub: 'th/hub.html', slot: 'th/slot.html' },
    },
  },
});
