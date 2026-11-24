import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/support/global-setup.ts'],
    setupFiles: ['tests/support/env.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Process entry points are exercised by the E2E tests, not unit/integration tests.
      exclude: ['src/index.ts', 'src/worker.ts', 'src/db/migrate.ts'],
      reporter: ['text-summary', 'html'],
      // CI fails if coverage drops below these (current: ~88% lines, ~78% branches).
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 72 },
    },
  },
});
