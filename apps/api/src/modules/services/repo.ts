import type { TenantTx } from '../../db/tenant-tx';

/*
 * Every function filters by tx.tenantId explicitly (application-layer isolation),
 * and RLS filters again in the database (defence in depth).
 */

export async function listServices(tx: TenantTx, opts: { activeOnly?: boolean } = {}) {
  let q = tx.db.selectFrom('services').selectAll().where('tenant_id', '=', tx.tenantId);
  if (opts.activeOnly) q = q.where('active', '=', true);
  return q.orderBy('name').execute();
}

export async function getService(tx: TenantTx, id: string) {
  return tx.db
    .selectFrom('services')
    .selectAll()
    .where('tenant_id', '=', tx.tenantId)
    .where('id', '=', id)
    .executeTakeFirst();
}

export async function insertService(
  tx: TenantTx,
  data: { name: string; durationMinutes: number; pricePaise: number; active?: boolean },
) {
  return tx.db
    .insertInto('services')
    .values({
      tenant_id: tx.tenantId,
      name: data.name,
      duration_minutes: data.durationMinutes,
      price_paise: data.pricePaise,
      active: data.active ?? true,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updateService(
  tx: TenantTx,
  id: string,
  patch: Partial<{ name: string; duration_minutes: number; price_paise: number; active: boolean }>,
) {
  return tx.db
    .updateTable('services')
    .set(patch)
    .where('tenant_id', '=', tx.tenantId)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

/** Services with bookings are deactivated instead of deleted, to keep history. */
export async function serviceHasBookings(tx: TenantTx, id: string) {
  const row = await tx.db
    .selectFrom('bookings')
    .select('id')
    .where('tenant_id', '=', tx.tenantId)
    .where('service_id', '=', id)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

export async function deleteService(tx: TenantTx, id: string) {
  const res = await tx.db
    .deleteFrom('services')
    .where('tenant_id', '=', tx.tenantId)
    .where('id', '=', id)
    .executeTakeFirst();
  return Number(res.numDeletedRows) > 0;
}
