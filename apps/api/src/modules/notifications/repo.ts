import { sql } from 'kysely';
import type { NotificationType } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-tx';

/**
 * The notifications table is an OUTBOX: rows are written in the same
 * transaction as the booking change, then a job sends them. If the job queue
 * is down, the row is still there and the reconciler sends it later.
 */
export async function createNotification(
  tx: TenantTx,
  bookingId: string,
  type: NotificationType,
  scheduledFor: Date = new Date(),
) {
  return tx.db
    .insertInto('notifications')
    .values({ tenant_id: tx.tenantId, booking_id: bookingId, type, scheduled_for: scheduledFor })
    .returning(['id', 'scheduled_for'])
    .executeTakeFirstOrThrow();
}

/** Cancels not-yet-sent notifications of these types for a booking. Returns their ids. */
export async function cancelPendingNotifications(
  tx: TenantTx,
  bookingId: string,
  types: NotificationType[],
) {
  const rows = await tx.db
    .updateTable('notifications')
    .set({ status: 'CANCELLED' })
    .where('tenant_id', '=', tx.tenantId)
    .where('booking_id', '=', bookingId)
    .where('type', 'in', types)
    .where('status', '=', 'PENDING')
    .returning('id')
    .execute();
  return rows.map((r) => r.id);
}

export async function getNotificationForUpdate(tx: TenantTx, id: string) {
  return tx.db
    .selectFrom('notifications')
    .selectAll()
    .where('tenant_id', '=', tx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

export async function markSent(tx: TenantTx, id: string) {
  await tx.db
    .updateTable('notifications')
    .set({ status: 'SENT', sent_at: sql`now()`, attempts: sql`attempts + 1`, last_error: null })
    .where('tenant_id', '=', tx.tenantId)
    .where('id', '=', id)
    .execute();
}

export async function recordFailure(tx: TenantTx, id: string, error: string, final: boolean) {
  await tx.db
    .updateTable('notifications')
    .set({
      attempts: sql`attempts + 1`,
      last_error: error.slice(0, 500),
      ...(final ? { status: 'FAILED' as const } : {}),
    })
    .where('tenant_id', '=', tx.tenantId)
    .where('id', '=', id)
    .execute();
}

export async function listNotifications(
  tx: TenantTx,
  filter: { status?: 'FAILED' | 'PENDING' | 'SENT'; limit: number },
) {
  let q = tx.db.selectFrom('notifications').selectAll().where('tenant_id', '=', tx.tenantId);
  if (filter.status) q = q.where('status', '=', filter.status);
  return q.orderBy('created_at', 'desc').limit(filter.limit).execute();
}

export async function retryNotification(tx: TenantTx, id: string) {
  return tx.db
    .updateTable('notifications')
    .set({ status: 'PENDING', scheduled_for: sql`now()`, last_error: null })
    .where('tenant_id', '=', tx.tenantId)
    .where('id', '=', id)
    .where('status', '=', 'FAILED')
    .returning(['id', 'scheduled_for'])
    .executeTakeFirst();
}

/** The 24-hour reminder time, or null if that moment has already passed. */
export function reminderTime(startAt: Date, now = new Date()): Date | null {
  const at = new Date(startAt.getTime() - 24 * 60 * 60 * 1000);
  return at.getTime() > now.getTime() ? at : null;
}
