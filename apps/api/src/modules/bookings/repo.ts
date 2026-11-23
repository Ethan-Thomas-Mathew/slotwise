import { sql } from 'kysely';
import type { BookingStatus } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-tx';

/** A booking with the names needed to show it (service, staff, customer). */
function bookingView(tx: TenantTx) {
  return tx.db
    .selectFrom('bookings as b')
    .innerJoin('services as s', 's.id', 'b.service_id')
    .innerJoin('memberships as sm', 'sm.id', 'b.staff_membership_id')
    .innerJoin('users as su', 'su.id', 'sm.user_id')
    .innerJoin('memberships as cm', 'cm.id', 'b.customer_membership_id')
    .innerJoin('users as cu', 'cu.id', 'cm.user_id')
    .select([
      'b.id',
      'b.tenant_id',
      'b.service_id',
      'b.staff_membership_id',
      'b.customer_membership_id',
      'b.start_at',
      'b.end_at',
      'b.status',
      'b.price_paise',
      'b.hold_expires_at',
      'b.cancelled_at',
      'b.created_at',
      's.name as service_name',
      's.duration_minutes',
      'su.name as staff_name',
      'cu.name as customer_name',
      'cu.email as customer_email',
    ])
    .where('b.tenant_id', '=', tx.tenantId);
}

export type BookingView = Awaited<ReturnType<typeof getBookingView>> & {};

export async function getBookingView(tx: TenantTx, id: string) {
  return bookingView(tx).where('b.id', '=', id).executeTakeFirst();
}

/** Locks the row until the transaction ends, so two requests can't change it at once. */
export async function getBookingForUpdate(tx: TenantTx, id: string) {
  return tx.db
    .selectFrom('bookings')
    .selectAll()
    .where('tenant_id', '=', tx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

export async function listBookings(
  tx: TenantTx,
  filter: {
    customerMembershipId?: string;
    staffMembershipId?: string;
    statuses?: BookingStatus[];
    from?: Date;
    to?: Date;
    limit?: number;
    order?: 'asc' | 'desc';
  },
) {
  let q = bookingView(tx);
  if (filter.customerMembershipId)
    q = q.where('b.customer_membership_id', '=', filter.customerMembershipId);
  if (filter.staffMembershipId) q = q.where('b.staff_membership_id', '=', filter.staffMembershipId);
  if (filter.statuses?.length) q = q.where('b.status', 'in', filter.statuses);
  if (filter.from) q = q.where('b.end_at', '>', filter.from);
  if (filter.to) q = q.where('b.start_at', '<', filter.to);
  return q
    .orderBy('b.start_at', filter.order ?? 'asc')
    .limit(filter.limit ?? 200)
    .execute();
}

/**
 * Time ranges when a staff member is busy: CONFIRMED bookings and HELD bookings
 * whose hold hasn't expired yet. (An expired hold that the background job
 * hasn't cleaned up yet does NOT block the slot.)
 */
export async function listBusyIntervals(
  tx: TenantTx,
  staffMembershipId: string,
  range: { from: Date; to: Date },
  opts: { excludeBookingId?: string } = {},
) {
  let q = tx.db
    .selectFrom('bookings')
    .select(['start_at', 'end_at'])
    .where('tenant_id', '=', tx.tenantId)
    .where('staff_membership_id', '=', staffMembershipId)
    .where('end_at', '>', range.from)
    .where('start_at', '<', range.to)
    .where((eb) =>
      eb.or([
        eb('status', '=', 'CONFIRMED'),
        eb.and([eb('status', '=', 'HELD'), eb('hold_expires_at', '>', sql<Date>`now()`)]),
      ]),
    );
  if (opts.excludeBookingId) q = q.where('id', '!=', opts.excludeBookingId);
  return q.execute();
}

/**
 * Marks this staff member's overlapping holds that have already timed out as
 * EXPIRED. Run just before inserting a new hold, so a late expiry job can never
 * block a free slot.
 */
export async function expireStaleHoldsInRange(
  tx: TenantTx,
  staffMembershipId: string,
  startAt: Date,
  endAt: Date,
) {
  const rows = await tx.db
    .updateTable('bookings')
    .set({ status: 'EXPIRED', updated_at: sql`now()` })
    .where('tenant_id', '=', tx.tenantId)
    .where('staff_membership_id', '=', staffMembershipId)
    .where('status', '=', 'HELD')
    .where('hold_expires_at', '<=', sql<Date>`now()`)
    .where(sql<boolean>`tstzrange(start_at, end_at, '[)') && tstzrange(${startAt}, ${endAt}, '[)')`)
    .returning('id')
    .execute();
  return rows.map((r) => r.id);
}

export async function insertHeldBooking(
  tx: TenantTx,
  data: {
    serviceId: string;
    staffMembershipId: string;
    customerMembershipId: string;
    startAt: Date;
    endAt: Date;
    pricePaise: number;
    holdExpiresAt: Date;
  },
) {
  return tx.db
    .insertInto('bookings')
    .values({
      tenant_id: tx.tenantId,
      service_id: data.serviceId,
      staff_membership_id: data.staffMembershipId,
      customer_membership_id: data.customerMembershipId,
      start_at: data.startAt,
      end_at: data.endAt,
      status: 'HELD',
      price_paise: data.pricePaise,
      hold_expires_at: data.holdExpiresAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Changes status only if the row is still in the status we expect ("compare
 * and set"). Returns the updated row, or undefined if someone else changed it first.
 */
export async function setBookingStatus(
  tx: TenantTx,
  id: string,
  from: BookingStatus,
  to: BookingStatus,
  extra: { cancelled_at?: Date } = {},
) {
  return tx.db
    .updateTable('bookings')
    .set({ status: to, updated_at: sql`now()`, ...extra })
    .where('tenant_id', '=', tx.tenantId)
    .where('id', '=', id)
    .where('status', '=', from)
    .returningAll()
    .executeTakeFirst();
}

/** Moves a booking in place. One UPDATE = atomic; the exclusion constraint re-checks it. */
export async function moveBooking(
  tx: TenantTx,
  id: string,
  data: { staffMembershipId: string; startAt: Date; endAt: Date },
) {
  return tx.db
    .updateTable('bookings')
    .set({
      staff_membership_id: data.staffMembershipId,
      start_at: data.startAt,
      end_at: data.endAt,
      updated_at: sql`now()`,
    })
    .where('tenant_id', '=', tx.tenantId)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}
