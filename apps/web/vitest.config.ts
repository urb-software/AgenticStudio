import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `@/` imports (shadcn aliases in components.json) resolve through tsconfig.json paths.
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', '*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
