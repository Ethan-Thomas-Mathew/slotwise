import { sql, type Transaction } from 'kysely';
import type { Database } from './database';
import type { DB } from './schema';

/**
 * A database transaction that is locked to ONE tenant.
 *
 * Repository functions take a `TenantTx` instead of the raw database. The only
 * way to get one is `withTenant()`, which has already told Postgres which tenant
 * this is (for RLS). So "forgot to scope by tenant" becomes a type error.
 */
export interface TenantTx {
  readonly db: Transaction<DB>;
  readonly tenantId: string;
  readonly userId: string | null;
}

/** A transaction with NO tenant set: RLS tables return nothing. Used by auth. */
export interface SystemTx {
  readonly db: Transaction<DB>;
  readonly userId: string | null;
}

export async function withTenant<T>(
  db: Database,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
  opts: { userId?: string | null } = {},
): Promise<T> {
  const userId = opts.userId ?? null;
  return db.transaction().execute(async (trx) => {
    // The third argument `true` makes the setting local to THIS transaction.
    await sql`SELECT set_config('app.tenant_id', ${tenantId}, true),
                     set_config('app.user_id', ${userId ?? ''}, true)`.execute(trx);
    return fn({ db: trx, tenantId, userId });
  });
}

export async function withSystem<T>(
  db: Database,
  fn: (tx: SystemTx) => Promise<T>,
  opts: { userId?: string | null } = {},
): Promise<T> {
  const userId = opts.userId ?? null;
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.tenant_id', '', true),
                     set_config('app.user_id', ${userId ?? ''}, true)`.execute(trx);
    return fn({ db: trx, userId });
  });
}
