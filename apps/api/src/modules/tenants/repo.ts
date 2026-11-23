import type { Database } from '../../db/database';
import type { TenantTx } from '../../db/tenant-tx';

export async function findTenantBySlug(db: Database, slug: string) {
  // `tenants` is readable by anyone (RLS policy tenants_read), so no tenant
  // context is needed to resolve a public booking page.
  return db.selectFrom('tenants').selectAll().where('slug', '=', slug).executeTakeFirst();
}

export async function getTenant(tx: TenantTx) {
  return tx.db
    .selectFrom('tenants')
    .selectAll()
    .where('id', '=', tx.tenantId)
    .executeTakeFirstOrThrow();
}

export async function insertTenant(
  tx: TenantTx,
  data: { name: string; slug: string; timezone?: string },
) {
  // The id is chosen BEFORE the transaction starts (withTenant needs it), and
  // the tenants_insert policy checks that it matches app.tenant_id.
  return tx.db
    .insertInto('tenants')
    .values({ id: tx.tenantId, name: data.name, slug: data.slug, timezone: data.timezone })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updateTenantSettings(
  tx: TenantTx,
  patch: Partial<{
    name: string;
    timezone: string;
    cancellation_window_hours: number;
    booking_horizon_days: number;
  }>,
) {
  return tx.db
    .updateTable('tenants')
    .set(patch)
    .where('id', '=', tx.tenantId)
    .returningAll()
    .executeTakeFirstOrThrow();
}
