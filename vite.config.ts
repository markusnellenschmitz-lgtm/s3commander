/// <reference types="vitest/config" />
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

// Tauri erwartet einen festen Port und soll Rust-Dateien nicht beobachten.
const DEV_PORT = 5173;

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  // Version für Einstellungen › Über; einzige Quelle ist package.json.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  clearScreen: false,
  server: {
    port: DEV_PORT,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,svelte}', 'scripts/**/*.mjs'],
      exclude: ['src/**/*.test.ts', 'src/test/**', 'src/main.ts', 'src/lib/ui/icons/sprite.ts', '**/*.d.ts'],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
