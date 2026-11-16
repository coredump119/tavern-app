import { defineConfig, type Plugin, type ServerOptions } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const host = process.env.TAURI_DEV_HOST;

const server: ServerOptions = {
  port: 1420,
  strictPort: true,
  host: host || false,
  watch: { ignored: ['**/src-tauri/**'] },
};
if (host) server.hmr = { protocol: 'ws', host, port: 1421 };

/**
 * The bundled CJK serif (DEV_NOTES §9.43) ships as woff2 slices; its CSS also names a woff copy of
 * every slice, which no web view we target needs and which would double the size of the package.
 */
const woff2Only: Plugin = {
  name: 'tm-fontsource-woff2-only',
  enforce: 'pre',
  transform(code, id) {
    if (!id.includes('@fontsource') || !/\.css(\?|$)/.test(id)) return null;
    return code.replace(/,\s*url\([^)]*\.woff\)\s*format\('woff'\)/g, '');
  },
};

export default defineConfig({
  plugins: [woff2Only, svelte()],
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
