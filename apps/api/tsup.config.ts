import { defineConfig } from 'tsup';

// Bundles the API (and the shared workspace package) into dist/ for production.
export default defineConfig({
  entry: ['src/index.ts', 'src/worker.ts', 'src/db/migrate.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: ['@slotwise/shared'],
});
