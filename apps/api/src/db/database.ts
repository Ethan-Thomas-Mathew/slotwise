import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './schema';

// Postgres returns COUNT(*) and other bigints as strings by default (they can
// exceed JS's safe integer range). Our counts are small, so parse them as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));

export type Database = Kysely<DB>;

export function createDatabase(connectionString: string, options: { max?: number } = {}): Database {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
