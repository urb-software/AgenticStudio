import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The integration test starts PostgreSQL and Redis via Testcontainers and the built API.
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
