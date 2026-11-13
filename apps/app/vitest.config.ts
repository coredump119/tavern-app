import { defineConfig } from 'vitest/config';
// App-layer tests: lib modules with ipc mocked (no Tauri runtime). Svelte components are not covered here.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], environment: 'node' } });
