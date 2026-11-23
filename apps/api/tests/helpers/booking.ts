import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import type { Database } from '../../src/db/database';
import type { BookingStatus } from '../../src/db/schema';
import { withTenant } from '../../src/db/tenant-tx';
import { insertMembership } from '../../src/modules/memberships/repo';
import { insertUser } from '../../src/modules/users/repo';
import { TEST_PASSWORD_HASH, type TestTenant } from './factory';

/** YYYY-MM-DD, `days` from today in the tenant's timezone. */
export const dateIn = (days: number, tz = 'Asia/Kolkata') =>
  DateTime.now().setZone(tz).plus({ days }).toISODate()!;

export async function slotsFor(
  app: FastifyInstance,
  t: TestTenant,
  date: string,
  staffId = t.staff.membershipId,
) {
  const res = await app.inject({
    url: `/public/${t.slug}/slots?serviceId=${t.service.id}&staffId=${staffId}&date=${date}`,
  });
  return (res.json().slots as { startAt: string; endAt: string }[]).map((s) => s.startAt);
}

/** Adds `n` more customers to a tenant. */
export async function addCustomers(db: Database, t: TestTenant, n: number) {
  return withTenant(db, t.tenantId, async (tx) => {
    const out: { email: string; membershipId: string }[] = [];
    for (let i = 0; i < n; i++) {
      const email = `c${i}-${randomUUID().slice(0, 8)}@test.local`;
      const u = await insertUser(tx, {
        email,
        name: `Customer ${i}`,
        passwordHash: TEST_PASSWORD_HASH,
      });
      const m = await insertMembership(tx, u.id, 'CUSTOMER');
      out.push({ email, membershipId: m.id });
    }
    return out;
  });
}

/**
 * Turns a HELD booking into CONFIRMED with a CAPTURED payment, directly in the
 * database (the real path is the payment webhook, tested in payments.test.ts).
 */
export async function confirmDirect(db: Database, tenantId: string, bookingId: string) {
  await withTenant(db, tenantId, async (tx) => {
    const b = await tx.db
      .updateTable('bookings')
      .set({ status: 'CONFIRMED' })
      .where('id', '=', bookingId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await tx.db
      .insertInto('payments')
      .values({
        tenant_id: tenantId,
        booking_id: bookingId,
        provider: 'mock',
        provider_order_id: `order_${randomUUID()}`,
        provider_payment_id: `pay_${randomUUID()}`,
        amount_paise: b.price_paise,
        currency: 'INR',
        status: 'CAPTURED',
      })
      .execute();
  });
}

/** Inserts a booking at any time (e.g. in the past), bypassing the API. */
export async function insertBookingDirect(
  db: Database,
  t: TestTenant,
  opts: {
    startAt: Date;
    status: BookingStatus;
    customerMembershipId?: string;
    staffMembershipId?: string;
  },
) {
  return withTenant(db, t.tenantId, (tx) =>
    tx.db
      .insertInto('bookings')
      .values({
        tenant_id: t.tenantId,
        service_id: t.service.id,
        staff_membership_id: opts.staffMembershipId ?? t.staff.membershipId,
        customer_membership_id: opts.customerMembershipId ?? t.customer.membershipId,
        start_at: opts.startAt,
        end_at: new Date(opts.startAt.getTime() + 30 * 60_000),
        status: opts.status,
        price_paise: 50000,
        hold_expires_at: opts.status === 'HELD' ? new Date(Date.now() + 600_000) : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow(),
  );
}
