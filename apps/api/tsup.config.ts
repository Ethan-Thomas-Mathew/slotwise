import { defineConfig } from 'tsup';

// Bundles the API (and the shared workspace package) into dist/ for production.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    worker: 'src/worker.ts',
    migrate: 'src/db/migrate.ts',
    seed: 'scripts/seed.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: ['@slotwise/shared'],
});
