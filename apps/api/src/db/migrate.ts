import { Migrator, type MigrationProvider } from 'kysely';
import { createDatabase } from './database';
import { migrations } from './migrations';

const provider: MigrationProvider = { getMigrations: async () => migrations };

/** Applies every migration that hasn't run yet. Runs as the table-owner role. */
export async function migrateToLatest(connectionString: string): Promise<string[]> {
  const db = createDatabase(connectionString, { max: 1 });
  try {
    const migrator = new Migrator({ db, provider });
    const { error, results } = await migrator.migrateToLatest();
    if (error) throw error;
    return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
  } finally {
    await db.destroy();
  }
}

// Run directly: `pnpm db:migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('MIGRATION_DATABASE_URL is not set');
    process.exit(1);
  }
  const applied = await migrateToLatest(url);
  console.warn(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
}
