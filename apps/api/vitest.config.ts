import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // NestJS DI relies on decorator metadata, which esbuild does not emit; SWC does.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts'],
    // Integration tests start PostgreSQL via Testcontainers (a first run pulls the image).
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
