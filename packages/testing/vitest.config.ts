import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Container start-up (including a first image pull) is slow.
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
