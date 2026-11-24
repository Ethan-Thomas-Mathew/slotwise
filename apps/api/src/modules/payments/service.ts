import { createHash } from 'node:crypto';
import { HOLD_MINUTES } from '@slotwise/shared';
import { sql } from 'kysely';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { Database } from '../../db/database';
import { PG, pgErrorCode } from '../../db/pg-errors';
import { withTenant, type TenantTx } from '../../db/tenant-tx';
import type { Jobs } from '../../jobs/types';
import { runEffects, type Effects } from '../../lib/effects';
import { AppError, notFound } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { writeAudit } from '../audit/repo';
import * as bookings from '../bookings/repo';
import { transitionBooking } from '../bookings/state-machine';
import { createNotification, reminderTime } from '../notifications/repo';
import { getTenant } from '../tenants/repo';
import type { PaymentProvider } from './provider';
import * as repo from './repo';

interface Deps {
  db: Database;
  jobs: Jobs;
  payments: PaymentProvider;
  log?: FastifyBaseLogger;
}

// ---------------------------------------------------------------------------
// 1. Create an order (customer clicks "Pay")
// ---------------------------------------------------------------------------

/**
 * The amount ALWAYS comes from our database (the price copied onto the booking),
 * never from the browser, so nobody can pay ₹1 for a ₹500 service.
 */
export async function createOrderForBooking(
  deps: Deps,
  ctx: { tenantId: string; userId: string; membershipId: string },
  bookingId: string,
) {
  const { db, payments } = deps;
  const inTx = <T>(fn: (tx: TenantTx) => Promise<T>) =>
    withTenant(db, ctx.tenantId, fn, { userId: ctx.userId });

  // Step 1 (short transaction): check the booking and look for an existing open order.
  const check = await inTx(async (tx) => {
    const b = await bookings.getBookingView(tx, bookingId);
    if (!b || b.customer_membership_id !== ctx.membershipId) throw notFound('Booking');
    if (b.status !== 'HELD')
      throw new AppError('INVALID_STATE', 'This booking is not waiting for payment');
    if (!b.hold_expires_at || b.hold_expires_at.getTime() <= Date.now()) {
      throw new AppError(
        'INVALID_STATE',
        `Your ${HOLD_MINUTES}-minute hold has expired. Please pick a slot again.`,
      );
    }
    const tenant = await getTenant(tx);
    const existing = await repo.getOpenOrderForBooking(tx, bookingId);
    return { booking: b, tenant, existing };
  });

  const response = (orderId: string, amountPaise: number, currency: string) => ({
    provider: payments.name,
    orderId,
    amountPaise,
    currency,
    keyId: payments.publicKeyId,
    businessName: check.tenant.name,
    customer: { name: check.booking.customer_name, email: check.booking.customer_email },
  });

  // Same booking, same order: clicking "Pay" twice never creates two orders.
  if (check.existing) {
    return response(
      check.existing.provider_order_id,
      check.existing.amount_paise,
      check.existing.currency,
    );
  }

  // Step 2 (no transaction open): call the provider. Never hold a DB
  // transaction open while waiting on an external API.
  let orderId: string;
  try {
    ({ orderId } = await payments.createOrder({
      amountPaise: check.booking.price_paise,
      currency: check.tenant.currency,
      receipt: bookingId.slice(0, 40),
      notes: { booking_id: bookingId, tenant_id: ctx.tenantId },
    }));
  } catch (err) {
    deps.log?.error({ err }, 'Payment provider createOrder failed');
    throw new AppError('PAYMENT_PROVIDER_ERROR', 'Could not start the payment. Please try again.');
  }

  // Step 3 (short transaction): record it. A unique index allows only one open
  // order per booking; if a parallel request won, return its order instead.
  try {
    const p = await inTx((tx) =>
      repo.insertPayment(tx, {
        bookingId,
        provider: payments.name,
        orderId,
        amountPaise: check.booking.price_paise,
        currency: check.tenant.currency,
      }),
    );
    return response(p.provider_order_id, p.amount_paise, p.currency);
  } catch (err) {
    if (pgErrorCode(err) !== PG.UNIQUE_VIOLATION) throw err;
    const winner = await inTx((tx) => repo.getOpenOrderForBooking(tx, bookingId));
    if (!winner) throw err;
    return response(winner.provider_order_id, winner.amount_paise, winner.currency);
  }
}

// ---------------------------------------------------------------------------
// 2. Webhook: the provider tells us what happened (the source of truth)
// ---------------------------------------------------------------------------

/**
 * The parts of a Razorpay event we read. Everything is optional because event
 * types differ; unknown fields are ignored. Checked after the signature, so a
 * malformed body from the real provider is a 400, not a crash.
 */
const RazorpayEvent = z.object({
  event: z.string(),
  payload: z
    .object({
      payment: z
        .object({
          entity: z
            .object({
              id: z.string(),
              order_id: z.string(),
              amount: z.number().int(),
              currency: z.string(),
              status: z.string(),
            })
            .partial(),
        })
        .partial(),
      refund: z
        .object({ entity: z.object({ id: z.string(), payment_id: z.string() }).partial() })
        .partial(),
    })
    .partial()
    .optional(),
});
type RazorpayEvent = z.infer<typeof RazorpayEvent>;

function parseEvent(rawBody: string): RazorpayEvent {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Webhook body is not valid JSON');
  }
  return parse(RazorpayEvent, json);
}

/** `rejected`: stored and acknowledged, but deliberately not applied (see onPaymentCaptured). */
export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored' | 'rejected';

/**
 * Steps:
 *  1. Verify the HMAC signature on the RAW body (before trusting anything in it).
 *  2. Find which tenant the order belongs to (narrow SECURITY DEFINER lookup).
 *  3. In ONE transaction: record the event id (UNIQUE) → if it was already
 *     there, stop (duplicate). Otherwise apply the change.
 *     Recording and applying commit together, so a crash halfway means
 *     neither happened and the provider's retry will process it properly.
 */
export async function handleWebhook(
  deps: Deps,
  input: { rawBody: string; signature: string | undefined; eventId: string | undefined },
): Promise<WebhookOutcome> {
  if (!input.signature || !deps.payments.verifyWebhookSignature(input.rawBody, input.signature)) {
    deps.log?.warn('Rejected webhook with an invalid signature');
    throw new AppError('BAD_SIGNATURE', 'Invalid webhook signature');
  }
  const event = parseEvent(input.rawBody);
  // Razorpay sends a unique id per event in a header; fall back to a hash of the body.
  const eventId =
    input.eventId ?? `sha256:${createHash('sha256').update(input.rawBody).digest('hex')}`;

  const orderId = event.payload?.payment?.entity?.order_id;
  const refundPaymentId = event.payload?.refund?.entity?.payment_id;
  let tenantId: string | null = null;
  if (orderId) {
    const { rows } = await sql<{
      t: string | null;
    }>`SELECT app_tenant_for_payment_order(${orderId}) AS t`.execute(deps.db);
    tenantId = rows[0]?.t ?? null;
  } else if (refundPaymentId) {
    const { rows } = await sql<{
      t: string | null;
    }>`SELECT app_tenant_for_provider_payment(${refundPaymentId}) AS t`.execute(deps.db);
    tenantId = rows[0]?.t ?? null;
  }

  if (!tenantId) {
    // Not an order we know (or an event type we don't use). Acknowledge so the
    // provider stops retrying, and keep a record.
    await deps.db
      .insertInto('webhook_events')
      .values({
        provider: 'razorpay',
        event_id: eventId,
        type: event.event,
        payload: input.rawBody,
        processed_at: new Date(),
      })
      .onConflict((oc) => oc.column('event_id').doNothing())
      .execute();
    deps.log?.info({ type: event.event, orderId }, 'Ignored webhook for unknown order');
    return 'ignored';
  }

  const effects: Effects = [];
  const outcome = await withTenant(deps.db, tenantId, async (tx) => {
    const inserted = await tx.db
      .insertInto('webhook_events')
      .values({
        provider: 'razorpay',
        event_id: eventId,
        type: event.event,
        payload: input.rawBody,
      })
      .onConflict((oc) => oc.column('event_id').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) return 'duplicate' as const; // seen before: do nothing

    let result: WebhookOutcome = 'processed';
    switch (event.event) {
      case 'payment.captured':
      case 'order.paid':
        result = await onPaymentCaptured(tx, event, effects, deps);
        break;
      case 'payment.failed':
        await onPaymentFailed(tx, event);
        break;
      case 'refund.processed':
        await onRefundProcessed(tx, event);
        break;
      default:
        break; // stored, nothing to do
    }
    await tx.db
      .updateTable('webhook_events')
      .set({ processed_at: sql`now()` })
      .where('id', '=', inserted.id)
      .execute();
    return result;
  });
  await runEffects(effects, deps.log);
  return outcome;
}

async function onPaymentCaptured(
  tx: TenantTx,
  event: RazorpayEvent,
  effects: Effects,
  deps: Deps,
): Promise<'processed' | 'rejected'> {
  const entity = event.payload!.payment!.entity!;
  const payment = await repo.getPaymentByOrderForUpdate(tx, entity.order_id!);
  if (!payment) return 'processed';
  // Already handled (e.g. we got both order.paid and payment.captured).
  if (
    payment.status === 'CAPTURED' ||
    payment.status === 'REFUND_PENDING' ||
    payment.status === 'REFUNDED'
  )
    return 'processed';
  if (entity.amount !== undefined && entity.amount !== payment.amount_paise) {
    // Money moved, but not the amount we asked for: never confirm on it. Failing
    // the request would make the provider retry an event that can never succeed,
    // so it is recorded and acknowledged; the owner sees it in the activity log
    // and refunds it from the provider's dashboard. Metrics alert on `rejected`.
    deps.log?.error(
      { orderId: entity.order_id, expected: payment.amount_paise, captured: entity.amount },
      'Captured amount does not match the order amount',
    );
    await writeAudit(tx, {
      action: 'payment.amount_mismatch',
      entity: 'payment',
      entityId: payment.id,
      after: {
        orderId: entity.order_id,
        expectedPaise: payment.amount_paise,
        capturedPaise: entity.amount,
      },
    });
    return 'rejected';
  }

  await repo.updatePayment(tx, payment.id, ['CREATED', 'FAILED'], {
    status: 'CAPTURED',
    provider_payment_id: entity.id,
  });

  const booking = await bookings.getBookingForUpdate(tx, payment.booking_id);
  if (!booking) return 'processed';
  const tenantId = tx.tenantId;

  const confirm = async (note: string) => {
    await bookings.setBookingStatus(
      tx,
      booking.id,
      booking.status,
      transitionBooking(booking.status, 'CONFIRMED'),
    );
    const confirmed = await createNotification(tx, booking.id, 'BOOKING_CONFIRMED');
    effects.push(() =>
      deps.jobs.scheduleNotification(tenantId, confirmed.id, confirmed.scheduled_for),
    );
    const at = reminderTime(booking.start_at);
    if (at) {
      const reminder = await createNotification(tx, booking.id, 'BOOKING_REMINDER', at);
      effects.push(() => deps.jobs.scheduleNotification(tenantId, reminder.id, at));
    }
    await writeAudit(tx, {
      action: 'booking.confirm',
      entity: 'booking',
      entityId: booking.id,
      after: { status: 'CONFIRMED', via: note },
    });
  };

  const refund = async (reason: string) => {
    await repo.updatePayment(tx, payment.id, ['CAPTURED'], {
      status: 'REFUND_PENDING',
      refund_reason: reason,
    });
    effects.push(() => deps.jobs.enqueueRefund(tenantId, payment.id));
    const n = await createNotification(tx, booking.id, 'LATE_PAYMENT_REFUNDED');
    effects.push(() => deps.jobs.scheduleNotification(tenantId, n.id, n.scheduled_for));
    await writeAudit(tx, {
      action: 'payment.auto_refund',
      entity: 'payment',
      entityId: payment.id,
      after: { reason },
    });
  };

  if (booking.status === 'HELD') {
    // The row is still HELD, so the slot was never released, even if the
    // 10 minutes just ran out and the expiry job hasn't run yet.
    await confirm('payment');
    return 'processed';
  }

  if (booking.status === 'EXPIRED') {
    // Paid after the hold expired. Re-confirm if the slot is still free;
    // otherwise refund. (See DECISIONS.md D25.)
    if (booking.start_at.getTime() <= Date.now()) {
      await refund('Paid after the appointment time had passed');
      return 'processed';
    }
    await bookings.lockStaffCalendar(tx, booking.staff_membership_id);
    // A SAVEPOINT lets us try the UPDATE and, if the exclusion constraint
    // rejects it, undo just that step without losing the rest of the transaction.
    await sql`SAVEPOINT reconfirm`.execute(tx.db);
    const effectsBefore = effects.length;
    try {
      await confirm('late payment, slot still free');
      await sql`RELEASE SAVEPOINT reconfirm`.execute(tx.db);
    } catch (err) {
      if (pgErrorCode(err) !== PG.EXCLUSION_VIOLATION) throw err;
      await sql`ROLLBACK TO SAVEPOINT reconfirm`.execute(tx.db);
      effects.length = effectsBefore; // drop anything the failed confirm queued
      await refund('Paid after the hold expired and someone else booked the slot');
    }
    return 'processed';
  }

  // CANCELLED (customer abandoned the hold) or already CONFIRMED (paid twice).
  await refund(
    booking.status === 'CANCELLED'
      ? 'Booking was cancelled before the payment completed'
      : 'Duplicate payment for an already confirmed booking',
  );
  return 'processed';
}

async function onPaymentFailed(tx: TenantTx, event: RazorpayEvent) {
  const entity = event.payload!.payment!.entity!;
  const payment = await repo.getPaymentByOrderForUpdate(tx, entity.order_id!);
  if (!payment) return;
  // Only an unpaid order can fail. The booking stays HELD so the customer can retry.
  await repo.updatePayment(tx, payment.id, ['CREATED'], {
    status: 'FAILED',
    provider_payment_id: entity.id,
  });
}

async function onRefundProcessed(tx: TenantTx, event: RazorpayEvent) {
  const entity = event.payload!.refund!.entity!;
  const payment = await tx.db
    .selectFrom('payments')
    .select('id')
    .where('tenant_id', '=', tx.tenantId)
    .where('provider_payment_id', '=', entity.payment_id!)
    .executeTakeFirst();
  if (!payment) return;
  await repo.updatePayment(tx, payment.id, ['REFUND_PENDING'], {
    status: 'REFUNDED',
    provider_refund_id: entity.id,
  });
}

// ---------------------------------------------------------------------------
// 3. Refund job
// ---------------------------------------------------------------------------

/**
 * Runs in the background (BullMQ "refunds" queue). Safe to run any number of
 * times: it acts only on REFUND_PENDING payments, and first asks the provider
 * whether a refund already exists (in case we crashed after refunding but
 * before saving that fact).
 */
export async function processRefund(
  deps: Pick<Deps, 'db' | 'payments'>,
  tenantId: string,
  paymentId: string,
): Promise<'refunded' | 'skipped'> {
  return withTenant(deps.db, tenantId, async (tx) => {
    const payment = await repo.getPaymentForUpdate(tx, paymentId);
    if (!payment || payment.status !== 'REFUND_PENDING' || !payment.provider_payment_id)
      return 'skipped';
    const existing = await deps.payments.findRefund(payment.provider_payment_id);
    const { refundId } =
      existing ??
      (await deps.payments.refund({
        paymentId: payment.provider_payment_id,
        amountPaise: payment.amount_paise,
        notes: { booking_id: payment.booking_id, reason: payment.refund_reason ?? '' },
      }));
    await repo.updatePayment(tx, payment.id, ['REFUND_PENDING'], {
      status: 'REFUNDED',
      provider_refund_id: refundId,
    });
    return 'refunded';
  });
}
