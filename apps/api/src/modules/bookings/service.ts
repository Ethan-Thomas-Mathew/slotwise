import { sql } from 'kysely';
import { HOLD_MINUTES, type BookingDto } from '@slotwise/shared';
import type { Booking, MembershipRole, Tenant } from '../../db/schema';
import { PG, pgErrorCode } from '../../db/pg-errors';
import type { TenantTx } from '../../db/tenant-tx';
import type { Jobs } from '../../jobs/types';
import type { Effects } from '../../lib/effects';
import { AppError, notFound } from '../../lib/errors';
import { writeAudit } from '../audit/repo';
import { findSlots, findSlotsAnyStaff } from '../availability/service';
import { localDateOf } from '../availability/slots';
import {
  cancelPendingNotifications,
  createNotification,
  reminderTime,
} from '../notifications/repo';
import * as payments from '../payments/repo';
import { staffOffersService } from '../staff/repo';
import { getTenant } from '../tenants/repo';
import * as repo from './repo';
import { transitionBooking } from './state-machine';

const MAX_ACTIVE_HOLDS_PER_CUSTOMER = 3;

export interface Actor {
  userId: string;
  membershipId: string;
  role: MembershipRole;
}

interface Deps {
  jobs: Jobs;
}

// ---------------------------------------------------------------------------
// Policy: who may do what, and when
// ---------------------------------------------------------------------------

interface BookingPolicy {
  canCancel: boolean;
  canReschedule: boolean;
  /** If cancelled now, is the payment refunded? */
  refundOnCancel: boolean;
}

/**
 * The business's cancellation policy as a pure function.
 * - Owners can always cancel/reschedule an upcoming booking, and their
 *   cancellations are always fully refunded (the business cancelled).
 * - Customers can cancel their own upcoming booking any time, but are refunded
 *   only if they cancel at least `cancellation_window_hours` before the start.
 *   They can reschedule only inside that same window.
 */
export function bookingPolicy(
  b: Pick<Booking, 'status' | 'start_at' | 'customer_membership_id'>,
  tenant: Pick<Tenant, 'cancellation_window_hours'>,
  actor: Pick<Actor, 'role' | 'membershipId'>,
  now = new Date(),
): BookingPolicy {
  const isOwner = actor.role === 'OWNER';
  const isOwnCustomer =
    actor.role === 'CUSTOMER' && b.customer_membership_id === actor.membershipId;
  const upcoming = b.start_at.getTime() > now.getTime();
  const windowStart = b.start_at.getTime() - tenant.cancellation_window_hours * 3600_000;
  const insideFreeWindow = now.getTime() <= windowStart;

  if (b.status === 'HELD') {
    return { canCancel: isOwner || isOwnCustomer, canReschedule: false, refundOnCancel: false };
  }
  if (b.status === 'CONFIRMED' && upcoming) {
    return {
      canCancel: isOwner || isOwnCustomer,
      canReschedule: isOwner || (isOwnCustomer && insideFreeWindow),
      refundOnCancel: isOwner || insideFreeWindow,
    };
  }
  return { canCancel: false, canReschedule: false, refundOnCancel: false };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Loads a booking the actor is allowed to see, or throws 404. */
export async function getVisibleBooking(tx: TenantTx, actor: Actor, id: string) {
  const b = await repo.getBookingView(tx, id);
  if (!b) throw notFound('Booking');
  const visible =
    actor.role === 'OWNER' ||
    (actor.role === 'STAFF' && b.staff_membership_id === actor.membershipId) ||
    (actor.role === 'CUSTOMER' && b.customer_membership_id === actor.membershipId);
  if (!visible) throw notFound('Booking');
  return b;
}

type BookingRow = NonNullable<Awaited<ReturnType<typeof repo.getBookingView>>>;

export async function toBookingDtos(
  tx: TenantTx,
  rows: BookingRow[],
  actor: Actor,
  tenant?: Tenant,
): Promise<BookingDto[]> {
  const t = tenant ?? (await getTenant(tx));
  const pays = await payments.latestPaymentsFor(
    tx,
    rows.map((r) => r.id),
  );
  const now = new Date();
  return rows.map((b) => {
    const p = pays.get(b.id);
    const policy = bookingPolicy(b, t, actor, now);
    return {
      id: b.id,
      status: b.status,
      startAt: b.start_at.toISOString(),
      endAt: b.end_at.toISOString(),
      holdExpiresAt: b.status === 'HELD' ? (b.hold_expires_at?.toISOString() ?? null) : null,
      pricePaise: b.price_paise,
      service: { id: b.service_id, name: b.service_name },
      staff: { membershipId: b.staff_membership_id, name: b.staff_name },
      customer: {
        membershipId: b.customer_membership_id,
        name: b.customer_name,
        email: b.customer_email,
      },
      payment: p
        ? { status: p.status, amountPaise: p.amount_paise, refundReason: p.refund_reason }
        : null,
      canCancel: policy.canCancel,
      canReschedule: policy.canReschedule,
    };
  });
}

// ---------------------------------------------------------------------------
// Hold
// ---------------------------------------------------------------------------

/**
 * Reserves a slot for 10 minutes while the customer pays.
 *
 * Correctness under concurrency does NOT depend on the "is it free?" check
 * below: two requests can both pass it at the same instant. The INSERT is what
 * decides. The exclusion constraint lets exactly one of them in and the
 * other gets Postgres error 23P01, which we turn into 409 SLOT_TAKEN.
 */
export async function holdSlot(
  tx: TenantTx,
  actor: Actor,
  input: { serviceId: string; staffId: string; startAt: string },
  effects: Effects,
  deps: Deps,
) {
  if (actor.role !== 'CUSTOMER') throw new AppError('FORBIDDEN', 'Only customers can book');
  const tenant = await getTenant(tx);
  const startAt = new Date(input.startAt);
  const date = localDateOf(startAt, tenant.timezone);

  // 1. Is this an actual available slot (right hours, not in the past, not too far ahead)?
  //    For "anyone available", also work out who could take it, least busy first.
  let slots, service, candidates: string[];
  if (input.staffId === 'any') {
    const any = await findSlotsAnyStaff(tx, { serviceId: input.serviceId, date });
    ({ slots, service } = any);
    candidates = any.candidatesAt(startAt);
  } else {
    ({ slots, service } = await findSlots(tx, {
      serviceId: input.serviceId,
      staffId: input.staffId,
      date,
    }));
    candidates = [input.staffId];
  }
  const slot = slots.find((s) => s.startAt.getTime() === startAt.getTime());
  if (!slot || candidates.length === 0)
    throw new AppError('SLOT_TAKEN', 'That time is no longer available. Please pick another.');

  // 2. Stop one customer from holding every slot at once.
  await repo.lockCustomerHolds(tx, actor.membershipId);
  // Account erasure takes the same lock. Re-check here, after it, so a request
  // that passed its session check just before an erasure can't book afterwards.
  const user = await tx.db
    .selectFrom('users')
    .select('deleted_at')
    .where('id', '=', actor.userId)
    .executeTakeFirst();
  if (!user || user.deleted_at) throw new AppError('UNAUTHENTICATED', 'Please log in again');
  const active = await tx.db
    .selectFrom('bookings')
    .select(sql<number>`count(*)`.as('n'))
    .where('tenant_id', '=', tx.tenantId)
    .where('customer_membership_id', '=', actor.membershipId)
    .where('status', '=', 'HELD')
    .where('hold_expires_at', '>', sql<Date>`now()`)
    .executeTakeFirstOrThrow();
  if (active.n >= MAX_ACTIVE_HOLDS_PER_CUSTOMER) {
    throw new AppError(
      'CONFLICT',
      'You have too many unpaid bookings. Pay for or cancel one first.',
    );
  }

  // 3 + 4. For each candidate (just one unless "anyone available"):
  //   - queue behind other writers for this staff member (prevents deadlocks),
  //   - clear any timed-out holds in the way (in case their expiry job is late),
  //   - INSERT. The database is the referee.
  // Each attempt runs inside a SAVEPOINT: if the exclusion constraint rejects
  // it, we undo just that attempt (releasing its lock) and try the next person.
  const holdExpiresAt = new Date(Date.now() + HOLD_MINUTES * 60_000);
  let booking;
  for (const staffId of candidates) {
    await sql`SAVEPOINT hold_attempt`.execute(tx.db);
    try {
      await repo.lockStaffCalendar(tx, staffId);
      await repo.expireStaleHoldsInRange(tx, staffId, slot.startAt, slot.endAt);
      booking = await repo.insertHeldBooking(tx, {
        serviceId: service.id,
        staffMembershipId: staffId,
        customerMembershipId: actor.membershipId,
        startAt: slot.startAt,
        endAt: slot.endAt,
        pricePaise: service.price_paise,
        holdExpiresAt,
      });
      await sql`RELEASE SAVEPOINT hold_attempt`.execute(tx.db);
      break;
    } catch (err) {
      if (pgErrorCode(err) !== PG.EXCLUSION_VIOLATION) throw err;
      await sql`ROLLBACK TO SAVEPOINT hold_attempt`.execute(tx.db);
    }
  }
  if (!booking) {
    throw new AppError('SLOT_TAKEN', 'Someone just took that slot. Please pick another.');
  }
  const tenantId = tx.tenantId;
  // Fire one second after expiry so the job never runs a moment too early.
  const runAt = new Date(holdExpiresAt.getTime() + 1000);
  effects.push(() => deps.jobs.scheduleHoldExpiry(tenantId, booking.id, runAt));
  return booking;
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export async function cancelBooking(
  tx: TenantTx,
  actor: Actor,
  bookingId: string,
  effects: Effects,
  deps: Deps,
) {
  await getVisibleBooking(tx, actor, bookingId); // 404 if not theirs
  const booking = await repo.getBookingForUpdate(tx, bookingId);
  if (!booking) throw notFound('Booking');
  const tenant = await getTenant(tx);
  const policy = bookingPolicy(booking, tenant, actor);
  if (!policy.canCancel) {
    if (actor.role === 'STAFF') throw new AppError('FORBIDDEN', 'Staff cannot cancel bookings');
    throw new AppError('INVALID_STATE', 'This booking can no longer be cancelled');
  }
  transitionBooking(booking.status, 'CANCELLED');
  const updated = await repo.setBookingStatus(tx, bookingId, booking.status, 'CANCELLED', {
    cancelled_at: new Date(),
  });
  if (!updated)
    throw new AppError('INVALID_STATE', 'The booking changed. Please refresh and try again.');

  const tenantId = tx.tenantId;
  let refund: 'FULL' | 'NONE' = 'NONE';
  if (booking.status === 'CONFIRMED') {
    // Stop the reminder; tell the customer it's cancelled.
    const cancelledIds = await cancelPendingNotifications(tx, bookingId, ['BOOKING_REMINDER']);
    for (const id of cancelledIds) effects.push(() => deps.jobs.cancelNotification(id));
    const n = await createNotification(tx, bookingId, 'BOOKING_CANCELLED');
    effects.push(() => deps.jobs.scheduleNotification(tenantId, n.id, n.scheduled_for));

    const payment = await payments.getCapturedPaymentForUpdate(tx, bookingId);
    if (payment && policy.refundOnCancel) {
      await payments.updatePayment(tx, payment.id, ['CAPTURED'], {
        status: 'REFUND_PENDING',
        refund_reason:
          actor.role === 'OWNER'
            ? 'Cancelled by the business'
            : 'Cancelled by customer within the free cancellation window',
      });
      refund = 'FULL';
      effects.push(() => deps.jobs.enqueueRefund(tenantId, payment.id));
    }
  }
  await writeAudit(tx, {
    action: 'booking.cancel',
    entity: 'booking',
    entityId: bookingId,
    before: { status: booking.status },
    after: { status: 'CANCELLED', refund, by: actor.role },
  });
  return { refund };
}

// ---------------------------------------------------------------------------
// Reschedule
// ---------------------------------------------------------------------------

/**
 * Moves a booking with ONE UPDATE of the same row. There is never a moment
 * where both the old and the new slot are held, or neither is. The exclusion
 * constraint re-checks the new time inside that same statement.
 */
export async function rescheduleBooking(
  tx: TenantTx,
  actor: Actor,
  bookingId: string,
  input: { startAt: string; staffId?: string | undefined },
  effects: Effects,
  deps: Deps,
) {
  await getVisibleBooking(tx, actor, bookingId);
  const booking = await repo.getBookingForUpdate(tx, bookingId);
  if (!booking) throw notFound('Booking');
  const tenant = await getTenant(tx);
  const policy = bookingPolicy(booking, tenant, actor);
  if (!policy.canReschedule) {
    if (actor.role === 'STAFF') throw new AppError('FORBIDDEN', 'Staff cannot reschedule bookings');
    throw new AppError(
      'INVALID_STATE',
      `Bookings can only be rescheduled more than ${tenant.cancellation_window_hours} hours before they start`,
    );
  }

  const staffId = input.staffId ?? booking.staff_membership_id;
  if (!(await staffOffersService(tx, staffId, booking.service_id))) throw notFound('Staff member');
  const startAt = new Date(input.startAt);
  const { slots } = await findSlots(tx, {
    serviceId: booking.service_id,
    staffId,
    date: localDateOf(startAt, tenant.timezone),
    excludeBookingId: bookingId, // its own current time doesn't block it
  });
  const slot = slots.find((s) => s.startAt.getTime() === startAt.getTime());
  if (!slot) throw new AppError('SLOT_TAKEN', 'That time is not available. Please pick another.');

  await repo.lockStaffCalendar(tx, staffId);
  await repo.expireStaleHoldsInRange(tx, staffId, slot.startAt, slot.endAt);
  let moved;
  try {
    moved = await repo.moveBooking(tx, bookingId, {
      staffMembershipId: staffId,
      startAt: slot.startAt,
      endAt: slot.endAt,
    });
  } catch (err) {
    if (pgErrorCode(err) === PG.EXCLUSION_VIOLATION) {
      throw new AppError('SLOT_TAKEN', 'Someone just took that slot. Please pick another.');
    }
    throw err;
  }

  // Move the reminder: cancel the old one, create a new one for the new time.
  const tenantId = tx.tenantId;
  const cancelledIds = await cancelPendingNotifications(tx, bookingId, ['BOOKING_REMINDER']);
  for (const id of cancelledIds) effects.push(() => deps.jobs.cancelNotification(id));
  const at = reminderTime(slot.startAt);
  if (at) {
    const n = await createNotification(tx, bookingId, 'BOOKING_REMINDER', at);
    effects.push(() => deps.jobs.scheduleNotification(tenantId, n.id, at));
  }

  await writeAudit(tx, {
    action: 'booking.reschedule',
    entity: 'booking',
    entityId: bookingId,
    before: { startAt: booking.start_at.toISOString(), staffId: booking.staff_membership_id },
    after: { startAt: slot.startAt.toISOString(), staffId, by: actor.role },
  });
  return moved!;
}

// ---------------------------------------------------------------------------
// Completed / no-show (staff or owner, after the appointment has started)
// ---------------------------------------------------------------------------

export async function markOutcome(
  tx: TenantTx,
  actor: Actor,
  bookingId: string,
  outcome: 'COMPLETED' | 'NO_SHOW',
) {
  if (actor.role === 'CUSTOMER') throw new AppError('FORBIDDEN', 'Customers cannot do that');
  await getVisibleBooking(tx, actor, bookingId); // staff: own bookings only
  const booking = await repo.getBookingForUpdate(tx, bookingId);
  if (!booking) throw notFound('Booking');
  transitionBooking(booking.status, outcome);
  if (booking.start_at.getTime() > Date.now()) {
    throw new AppError('INVALID_STATE', 'You can only mark a booking after it has started');
  }
  const updated = await repo.setBookingStatus(tx, bookingId, booking.status, outcome);
  if (!updated)
    throw new AppError('INVALID_STATE', 'The booking changed. Please refresh and try again.');
  await writeAudit(tx, {
    action: outcome === 'COMPLETED' ? 'booking.complete' : 'booking.no_show',
    entity: 'booking',
    entityId: bookingId,
    before: { status: booking.status },
    after: { status: outcome },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Background job: hold expiry
// ---------------------------------------------------------------------------

/** Called by the hold-expiry job. Only expires it if it's STILL held and the time has passed. */
export async function expireHold(tx: TenantTx, bookingId: string) {
  const res = await tx.db
    .updateTable('bookings')
    .set({ status: 'EXPIRED', updated_at: sql`now()` })
    .where('tenant_id', '=', tx.tenantId)
    .where('id', '=', bookingId)
    .where('status', '=', 'HELD')
    .where('hold_expires_at', '<=', sql<Date>`now()`)
    .returning('id')
    .executeTakeFirst();
  return res !== undefined;
}
