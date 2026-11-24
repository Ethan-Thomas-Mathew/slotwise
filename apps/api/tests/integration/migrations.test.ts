import { Migrator, sql, type MigrationProvider } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../src/db/database';
import { migrations } from '../../src/db/migrations';

/**
 * Every migration must be reversible. We apply them all, take a "fingerprint"
 * of the schema, roll back one at a time and re-apply, and check we end up with
 * exactly the same schema. Uses its own throwaway database.
 */
const ownerUrl = new URL(process.env.MIGRATION_DATABASE_URL!);
const adminUrl = new URL(ownerUrl);
adminUrl.pathname = '/postgres';
const scratchUrl = new URL(ownerUrl);
scratchUrl.pathname = '/slotwise_migration_check';

const provider: MigrationProvider = { getMigrations: async () => migrations };
let db: Database;
let migrator: Migrator;

async function admin(sqlText: string) {
  const c = new pg.Client({ connectionString: adminUrl.toString() });
  await c.connect();
  try {
    await c.query(sqlText);
  } finally {
    await c.end();
  }
}

/** Tables, columns, constraints, indexes, policies, functions and types in "public". */
async function fingerprint(): Promise<string> {
  const q = async (text: string) =>
    (await sql<{ x: string }>`${sql.raw(text)}`.execute(db)).rows.map((r) => r.x).join('\n');
  return [
    await q(`SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable AS x
             FROM information_schema.columns WHERE table_schema = 'public'
               AND table_name NOT LIKE 'kysely_%' ORDER BY 1`),
    await q(`SELECT conrelid::regclass || ':' || conname || ':' || pg_get_constraintdef(oid) AS x
             FROM pg_constraint WHERE connamespace = 'public'::regnamespace
               AND conrelid::regclass::text NOT LIKE 'kysely_%' ORDER BY 1`),
    await q(`SELECT indexdef AS x FROM pg_indexes WHERE schemaname = 'public'
               AND tablename NOT LIKE 'kysely_%' ORDER BY 1`),
    await q(`SELECT tablename || ':' || policyname || ':' || coalesce(qual, '') AS x
             FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`),
    await q(`SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS x
             FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
               AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
             ORDER BY 1`),
    await q(`SELECT t.typname AS x FROM pg_type t WHERE t.typnamespace = 'public'::regnamespace
               AND t.typtype = 'e' ORDER BY 1`),
  ].join('\n---\n');
}

beforeAll(async () => {
  await admin(`DROP DATABASE IF EXISTS slotwise_migration_check WITH (FORCE)`);
  await admin(`CREATE DATABASE slotwise_migration_check`);
  db = createDatabase(scratchUrl.toString(), { max: 1 });
  migrator = new Migrator({ db, provider });
});
afterAll(async () => {
  await db.destroy();
  await admin(`DROP DATABASE IF EXISTS slotwise_migration_check WITH (FORCE)`);
});

describe('migrations', () => {
  const names = Object.keys(migrations);

  it('apply cleanly to an empty database', async () => {
    const { error, results } = await migrator.migrateToLatest();
    expect(error).toBeUndefined();
    expect(results?.map((r) => r.migrationName)).toEqual(names);
  });

  it('each one can be rolled back and re-applied, giving the identical schema', async () => {
    const full = await fingerprint();
    // Sanity check: the fingerprint really sees the schema.
    expect(full).toContain('no_overlapping_bookings');
    expect(full).toContain('tenant_isolation');
    expect(full).toContain('app_current_tenant()');
    for (const name of [...names].reverse()) {
      const down = await migrator.migrateDown();
      expect(down.error, `down ${name}`).toBeUndefined();
      expect(down.results?.[0]?.migrationName).toBe(name);
    }
    // Everything we created is gone.
    expect(await fingerprint()).toBe(['', '', '', '', '', ''].join('\n---\n'));

    for (const name of names) {
      const up = await migrator.migrateUp();
      expect(up.error, `up ${name}`).toBeUndefined();
      // ...and the step back down then up again also works from this point.
      expect((await migrator.migrateDown()).error, `down ${name} (again)`).toBeUndefined();
      expect((await migrator.migrateUp()).error, `up ${name} (again)`).toBeUndefined();
    }
    expect(await fingerprint()).toBe(full);
  });
});
