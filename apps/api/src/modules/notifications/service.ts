import { sql } from 'kysely';
import type { Database } from '../../db/database';
import { withTenant } from '../../db/tenant-tx';
import type { Mailer } from '../../lib/mailer';
import * as bookings from '../bookings/repo';
import { getTenant } from '../tenants/repo';
import * as repo from './repo';
import { renderBookingEmail } from './templates';

type NotificationOutcome = 'sent' | 'skipped' | 'not_due' | 'cancelled' | 'failed';

/**
 * Sends one notification row. Called by the BullMQ worker; safe to call any
 * number of times:
 * - not PENDING any more (already sent / cancelled) → skip
 * - scheduled for later (job fired early, or the booking was rescheduled and a
 *   newer job exists) → skip
 * - reminder/confirmation for a booking that's no longer CONFIRMED → cancel it
 * On a sending error it records the attempt; on the final attempt the row
 * becomes FAILED, which owners see on their dashboard and can retry.
 *
 * Delivery is "at least once": if the process died after the SMTP server
 * accepted the email but before the commit, a retry would send it again.
 */
export async function processNotification(
  deps: { db: Database; mailer: Mailer; webOrigin: string },
  tenantId: string,
  notificationId: string,
  attempt: { number: number; max: number } = { number: 1, max: 1 },
): Promise<NotificationOutcome> {
  let sendError: unknown = null;
  const outcome = await withTenant(deps.db, tenantId, async (tx): Promise<NotificationOutcome> => {
    const n = await repo.getNotificationForUpdate(tx, notificationId);
    if (!n || n.status !== 'PENDING') return 'skipped';
    if (n.scheduled_for.getTime() > Date.now() + 5_000) return 'not_due';

    const b = await bookings.getBookingView(tx, n.booking_id);
    if (!b) return 'skipped';
    const needsConfirmed = n.type === 'BOOKING_CONFIRMED' || n.type === 'BOOKING_REMINDER';
    if (
      needsConfirmed &&
      (b.status !== 'CONFIRMED' ||
        (n.type === 'BOOKING_REMINDER' && b.start_at.getTime() < Date.now()))
    ) {
      await tx.db
        .updateTable('notifications')
        .set({ status: 'CANCELLED' })
        .where('id', '=', n.id)
        .execute();
      return 'cancelled';
    }

    const tenant = await getTenant(tx);
    const payment = await tx.db
      .selectFrom('payments')
      .select('refund_reason')
      .where('tenant_id', '=', tx.tenantId)
      .where('booking_id', '=', b.id)
      .where('status', 'in', ['REFUND_PENDING', 'REFUNDED'])
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    const email = renderBookingEmail(n.type, {
      businessName: tenant.name,
      timezone: tenant.timezone,
      currency: tenant.currency,
      customerName: b.customer_name,
      customerEmail: b.customer_email,
      serviceName: b.service_name,
      staffName: b.staff_name,
      startAt: b.start_at,
      pricePaise: b.price_paise,
      refundReason: payment?.refund_reason ?? null,
      manageUrl: `${deps.webOrigin}/app/bookings`,
    });

    try {
      await deps.mailer.send(email);
    } catch (err) {
      sendError = err;
      const final = attempt.number >= attempt.max;
      await repo.recordFailure(tx, n.id, err instanceof Error ? err.message : String(err), final);
      return 'failed';
    }
    await repo.markSent(tx, n.id);
    return 'sent';
  });
  // Re-throw AFTER the failure was saved, so BullMQ schedules a retry.
  if (sendError) throw sendError;
  return outcome;
}

/**
 * The safety net, run every minute by the maintenance queue:
 * - expires holds whose expiry job never ran,
 * - re-queues emails that are due but were never queued (outbox),
 * - re-queues refunds stuck in REFUND_PENDING,
 * - deletes expired sessions and old one-time tokens.
 */
export async function reconcile(
  db: Database,
  jobs: {
    scheduleNotification(t: string, id: string, at: Date): Promise<void>;
    enqueueRefund(t: string, id: string): Promise<void>;
  },
) {
  const { rows: expired } = await sql<{ n: number }>`SELECT app_expire_stale_holds() AS n`.execute(
    db,
  );
  const { rows: due } = await sql<{
    id: string;
    tenant_id: string;
  }>`SELECT * FROM app_due_notifications(100)`.execute(db);
  for (const n of due) await jobs.scheduleNotification(n.tenant_id, n.id, new Date());
  const { rows: refunds } = await sql<{
    id: string;
    tenant_id: string;
  }>`SELECT * FROM app_pending_refunds(50)`.execute(db);
  for (const p of refunds) await jobs.enqueueRefund(p.tenant_id, p.id);

  // Housekeeping: expired sessions and spent one-time tokens are useless, and
  // keeping them only grows tables that are read on every request.
  const sessions = await db
    .deleteFrom('sessions')
    .where('expires_at', '<', sql<Date>`now()`)
    .executeTakeFirst();
  const tokens = await db
    .deleteFrom('auth_tokens')
    .where((eb) =>
      eb.or([
        eb('expires_at', '<', sql<Date>`now() - interval '1 day'`),
        eb('used_at', '<', sql<Date>`now() - interval '1 day'`),
      ]),
    )
    .executeTakeFirst();

  return {
    expiredHolds: expired[0]?.n ?? 0,
    requeuedNotifications: due.length,
    requeuedRefunds: refunds.length,
    deletedSessions: Number(sessions.numDeletedRows),
    deletedTokens: Number(tokens.numDeletedRows),
  };
}
