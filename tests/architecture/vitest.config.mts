import { defineConfig } from 'vitest/config';

// One project per gate, so `pnpm architecture:<gate>` runs only that gate's checks.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    projects: ['api', 'web', 'monorepo'].map((gate) => ({
      test: { name: gate, include: [`${gate}/**/*.test.ts`], testTimeout: 60_000 },
    })),
  },
});
