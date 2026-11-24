import { createDatabase, type Database } from '../../src/db/database';

/** Connection as the app role (RLS applies). */
export function appDb(): Database {
  return createDatabase(process.env.DATABASE_URL!, { max: 25 });
}

/** Connection as the table owner (RLS does NOT apply). Only for test setup/inspection. */
export function ownerDb(): Database {
  return createDatabase(process.env.MIGRATION_DATABASE_URL!, { max: 5 });
}
