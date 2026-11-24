import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Config } from '../config';
import type { DB } from './schema';

// Postgres returns COUNT(*) and other bigints as strings by default (they can
// exceed JS's safe integer range). Our counts are small, so parse them as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));

export type Database = Kysely<DB>;

interface PoolOptions {
  max?: number;
  /** Postgres cancels any single statement running longer than this. */
  statementTimeoutMs?: number;
  /** Postgres ends a transaction left open and idle this long, releasing its locks. */
  idleInTransactionMs?: number;
  /** Give up connecting after this long instead of waiting forever. */
  connectTimeoutMs?: number;
}

/**
 * Without timeouts, one stuck query or one forgotten open transaction holds a
 * pooled connection (and its row locks) indefinitely, and requests queue behind it.
 * Migrations and scripts pass no limits; the API and worker do.
 */
export function createDatabase(connectionString: string, options: PoolOptions = {}): Database {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    statement_timeout: options.statementTimeoutMs,
    idle_in_transaction_session_timeout: options.idleInTransactionMs,
    connectionTimeoutMillis: options.connectTimeoutMs,
  });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

/** The pool settings the API and the worker use. */
export const runtimePoolOptions = (config: Config): PoolOptions => ({
  statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
  idleInTransactionMs: config.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  connectTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
});
