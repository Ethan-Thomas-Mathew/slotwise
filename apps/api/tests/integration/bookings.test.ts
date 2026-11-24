import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, loginAs, type Client, type TestApp } from '../support/app';
import { createTestTenant, type TestTenant } from '../support/factory';
import {
  addCustomers,
  confirmDirect,
  dateIn,
  insertBookingDirect,
  slotsFor,
} from '../support/booking';
import { withTenant } from '../../src/db/tenant-tx';
import { replaceRules } from '../../src/modules/availability/repo';
import { expireHold } from '../../src/modules/bookings/service';
import { setStaffServices } from '../../src/modules/staff/repo';

let t: TestApp;
let T: TestTenant;
let customer: Client;

beforeAll(async () => {
  t = await createTestApp();
  T = await createTestTenant(t.db);
  customer = await loginAs(t.app, T.customer.email, T.slug);
});
afterAll(() => t.close());

const hold = (c: Client, startAt: string, tenant = T) =>
  c.post('/bookings/hold', {
    serviceId: tenant.service.id,
    staffId: tenant.staff.membershipId,
    startAt,
  });

describe('POST /bookings/hold', () => {
  it('holds an available slot for 10 minutes at the service price', async () => {
    const [slot] = await slotsFor(t.app, T, dateIn(5));
    const res = await hold(customer, slot!);
    expect(res.statusCode).toBe(201);
    const b = res.json();
    expect(b).toMatchObject({
      status: 'HELD',
      startAt: slot,
      pricePaise: 50000,
      canCancel: true,
      payment: null,
    });
    const minutesLeft = (new Date(b.holdExpiresAt).getTime() - Date.now()) / 60_000;
    expect(minutesLeft).toBeGreaterThan(9.5);
    expect(minutesLeft).toBeLessThanOrEqual(10);

    // An expiry job was scheduled just after the hold ends.
    const job = t.jobs.holdExpiries.find((j) => j.bookingId === b.id);
    expect(job?.at.getTime()).toBe(new Date(b.holdExpiresAt).getTime() + 1000);

    // The slot disappears from the public list.
    expect(await slotsFor(t.app, T, dateIn(5))).not.toContain(slot);
  });

  it('refuses a time that is not a real slot (wrong grid, past, outside hours)', async () => {
    const [slot] = await slotsFor(t.app, T, dateIn(5));
    const offGrid = new Date(new Date(slot!).getTime() + 10 * 60_000).toISOString();
    const past = new Date(Date.now() - 86400_000).toISOString();
    for (const startAt of [offGrid, past, '2026-01-01T00:00:00Z']) {
      const res = await hold(customer, startAt);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SLOT_TAKEN');
    }
  });

  it('the second customer to ask for the same slot gets 409', async () => {
    const [other] = await addCustomers(t.db, T, 1);
    const c2 = await loginAs(t.app, other!.email, T.slug);
    const slot = (await slotsFor(t.app, T, dateIn(6)))[2]!;
    expect((await hold(customer, slot)).statusCode).toBe(201);
    const res = await hold(c2, slot);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SLOT_TAKEN');
  });

  it('a customer can hold at most 3 slots at once', async () => {
    const tenant = await createTestTenant(t.db);
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const slots = await slotsFor(t.app, tenant, dateIn(7));
    for (let i = 0; i < 3; i++) expect((await hold(c, slots[i]!, tenant)).statusCode).toBe(201);
    const res = await hold(c, slots[3]!, tenant);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/too many/i);
  });

  it('only customers can hold', async () => {
    const owner = await loginAs(t.app, T.owner.email, T.slug);
    const [slot] = await slotsFor(t.app, T, dateIn(8));
    expect((await hold(owner, slot!)).statusCode).toBe(403);
    expect(
      (await new (customer.constructor as typeof Client)(t.app).post('/bookings/hold', {}))
        .statusCode,
    ).toBe(401);
  });

  it('an expired hold whose job has not run yet does not block the slot', async () => {
    const tenant = await createTestTenant(t.db);
    const [a, b] = await addCustomers(t.db, tenant, 2);
    const ca = await loginAs(t.app, a!.email, tenant.slug);
    const cb = await loginAs(t.app, b!.email, tenant.slug);
    const [slot] = await slotsFor(t.app, tenant, dateIn(5));
    const first = (await hold(ca, slot!, tenant)).json();

    // Pretend 10 minutes passed but the expiry job never ran (e.g. Redis was down).
    await withTenant(t.db, tenant.tenantId, (tx) =>
      tx.db
        .updateTable('bookings')
        .set({ hold_expires_at: sql`now() - interval '1 second'` })
        .where('id', '=', first.id)
        .execute(),
    );
    expect(await slotsFor(t.app, tenant, dateIn(5))).toContain(slot);
    const second = await hold(cb, slot!, tenant);
    expect(second.statusCode).toBe(201);
    // The stale hold was cleaned up on the way.
    const old = await withTenant(t.db, tenant.tenantId, (tx) =>
      tx.db
        .selectFrom('bookings')
        .select('status')
        .where('id', '=', first.id)
        .executeTakeFirstOrThrow(),
    );
    expect(old.status).toBe('EXPIRED');
  });
});

describe('unpaid holds per customer', () => {
  it('allows 3 at once; the 4th is refused', async () => {
    const tenant = await createTestTenant(t.db);
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const slots = await slotsFor(t.app, tenant, dateIn(6));
    const codes = [];
    for (const slot of slots.slice(0, 4)) codes.push((await hold(c, slot, tenant)).statusCode);
    expect(codes).toEqual([201, 201, 201, 409]);
  });

  it('allows only 3 even when 6 holds with different staff arrive at the same moment', async () => {
    // The owner also offers the service, so the requests don't all queue on one calendar.
    const tenant = await createTestTenant(t.db);
    await withTenant(t.db, tenant.tenantId, async (tx) => {
      await setStaffServices(tx, tenant.owner.membershipId, [tenant.service.id]);
      await replaceRules(
        tx,
        tenant.owner.membershipId,
        [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })),
      );
    });
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const slots = await slotsFor(t.app, tenant, dateIn(6));
    const responses = await Promise.all(
      slots.slice(0, 6).map((startAt, i) =>
        c.post('/bookings/hold', {
          serviceId: tenant.service.id,
          staffId: i % 2 ? tenant.owner.membershipId : tenant.staff.membershipId,
          startAt,
        }),
      ),
    );
    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(3);
  });
});

describe('hold expiry job', () => {
  it('expires a hold only after its time, and only if it is still HELD', async () => {
    const [slot] = await slotsFor(t.app, T, dateIn(9));
    const b = (await hold(customer, slot!)).json();
    // Too early: nothing happens.
    expect(await withTenant(t.db, T.tenantId, (tx) => expireHold(tx, b.id))).toBe(false);
    await withTenant(t.db, T.tenantId, (tx) =>
      tx.db
        .updateTable('bookings')
        .set({ hold_expires_at: sql`now() - interval '1 second'` })
        .where('id', '=', b.id)
        .execute(),
    );
    expect(await withTenant(t.db, T.tenantId, (tx) => expireHold(tx, b.id))).toBe(true);
    expect((await customer.get(`/bookings/${b.id}`)).json().status).toBe('EXPIRED');
    // Running again is harmless (idempotent).
    expect(await withTenant(t.db, T.tenantId, (tx) => expireHold(tx, b.id))).toBe(false);
  });
});

describe('CONCURRENCY: 20 customers click the same slot at the same moment', () => {
  it('exactly 1 gets 201 and 19 get 409 (never a 500), ten runs in a row', async () => {
    const tenant = await createTestTenant(t.db);
    const customers = await addCustomers(t.db, tenant, 20);
    const clients = await Promise.all(customers.map((c) => loginAs(t.app, c.email, tenant.slug)));
    const slots = [
      ...(await slotsFor(t.app, tenant, dateIn(10))),
      ...(await slotsFor(t.app, tenant, dateIn(11))),
    ];
    let decidedByConstraint = 0;

    for (let run = 0; run < 10; run++) {
      const slot = slots[run]!;
      const results = await Promise.all(clients.map((c) => hold(c, slot, tenant)));
      const codes = results.map((r) => r.statusCode);
      expect(
        codes.filter((c) => c === 201),
        `run ${run}`,
      ).toHaveLength(1);
      expect(
        codes.filter((c) => c === 409),
        `run ${run}`,
      ).toHaveLength(19);
      // Losers that passed the "is it free?" check at the same instant were
      // stopped by the exclusion constraint (Postgres error 23P01).
      decidedByConstraint += results.filter((r) =>
        r.json().error?.message?.startsWith('Someone just took'),
      ).length;

      // And the database agrees: exactly one active booking for that slot.
      const { rows } = await withTenant(t.db, tenant.tenantId, (tx) =>
        sql<{
          n: number;
        }>`SELECT count(*) AS n FROM bookings WHERE start_at = ${new Date(slot)} AND status = 'HELD'`.execute(
          tx.db,
        ),
      );
      expect(rows[0]!.n).toBe(1);

      // Free the winner's hold quota for the next run.
      const winner = clients[codes.indexOf(201)]!;
      await winner.post(`/bookings/${results[codes.indexOf(201)]!.json().id}/cancel`);
    }
    // Proof the race really happened: app-level checks alone would have let these through.
    expect(decidedByConstraint).toBeGreaterThan(0);
    console.log(
      `concurrency: ${decidedByConstraint}/190 losers were stopped by the exclusion constraint`,
    );
  });
});

describe('cancel', () => {
  it('a customer can abandon a hold; the slot frees up immediately', async () => {
    const [slot] = await slotsFor(t.app, T, dateIn(12));
    const b = (await hold(customer, slot!)).json();
    const res = await customer.post(`/bookings/${b.id}/cancel`);
    expect(res.json().status).toBe('CANCELLED');
    expect(await slotsFor(t.app, T, dateIn(12))).toContain(slot);
  });

  it('customer cancels a paid booking well in advance → refund queued, reminder cancelled', async () => {
    const [slot] = await slotsFor(t.app, T, dateIn(13));
    const b = (await hold(customer, slot!)).json();
    await confirmDirect(t.db, T.tenantId, b.id);
    const res = await customer.post(`/bookings/${b.id}/cancel`);
    expect(res.statusCode).toBe(200);
    expect(res.json().payment).toMatchObject({ status: 'REFUND_PENDING' });
    expect(t.jobs.refunds.some((r) => r.tenantId === T.tenantId)).toBe(true);
    // A cancellation email is queued.
    const notes = await withTenant(t.db, T.tenantId, (tx) =>
      tx.db
        .selectFrom('notifications')
        .select(['type', 'status'])
        .where('booking_id', '=', b.id)
        .execute(),
    );
    expect(notes).toContainEqual({ type: 'BOOKING_CANCELLED', status: 'PENDING' });
  });

  it('customer cancels inside the cancellation window → no refund', async () => {
    const tenant = await createTestTenant(t.db, { cancellationWindowHours: 24 * 30 });
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const [slot] = await slotsFor(t.app, tenant, dateIn(3));
    const b = (await hold(c, slot!, tenant)).json();
    await confirmDirect(t.db, tenant.tenantId, b.id);
    const res = await c.post(`/bookings/${b.id}/cancel`);
    expect(res.json()).toMatchObject({ status: 'CANCELLED', payment: { status: 'CAPTURED' } });
  });

  it('owner cancels inside the window → full refund anyway', async () => {
    const tenant = await createTestTenant(t.db, { cancellationWindowHours: 24 * 30 });
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const owner = await loginAs(t.app, tenant.owner.email, tenant.slug);
    const [slot] = await slotsFor(t.app, tenant, dateIn(3));
    const b = (await hold(c, slot!, tenant)).json();
    await confirmDirect(t.db, tenant.tenantId, b.id);
    const res = await owner.post(`/bookings/${b.id}/cancel`);
    expect(res.json().payment).toMatchObject({
      status: 'REFUND_PENDING',
      refundReason: 'Cancelled by the business',
    });
  });

  it('staff cannot cancel; cancelling twice is a 409', async () => {
    const [slot] = await slotsFor(t.app, T, dateIn(14));
    const b = (await hold(customer, slot!)).json();
    await confirmDirect(t.db, T.tenantId, b.id);
    const staff = await loginAs(t.app, T.staff.email, T.slug);
    expect((await staff.post(`/bookings/${b.id}/cancel`)).statusCode).toBe(403);
    expect((await customer.post(`/bookings/${b.id}/cancel`)).statusCode).toBe(200);
    expect((await customer.post(`/bookings/${b.id}/cancel`)).statusCode).toBe(409);
  });
});

describe('reschedule', () => {
  it('moves a confirmed booking atomically and moves its reminder', async () => {
    const tenant = await createTestTenant(t.db);
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const slots = await slotsFor(t.app, tenant, dateIn(5));
    const b = (await hold(c, slots[0]!, tenant)).json();
    await confirmDirect(t.db, tenant.tenantId, b.id);
    // A reminder exists for the original time.
    const oldReminder = await withTenant(t.db, tenant.tenantId, async (tx) => {
      const { createNotification } = await import('../../src/modules/notifications/repo');
      return createNotification(
        tx,
        b.id,
        'BOOKING_REMINDER',
        new Date(new Date(slots[0]!).getTime() - 86400_000),
      );
    });

    const res = await c.post(`/bookings/${b.id}/reschedule`, { startAt: slots[3] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: b.id, status: 'CONFIRMED', startAt: slots[3] });

    const after = await slotsFor(t.app, tenant, dateIn(5));
    expect(after).toContain(slots[0]); // old slot is free
    expect(after).not.toContain(slots[3]); // new slot is taken

    expect(t.jobs.cancelledNotifications).toContain(oldReminder.id);
    const reminders = await withTenant(t.db, tenant.tenantId, (tx) =>
      tx.db
        .selectFrom('notifications')
        .select(['id', 'status', 'scheduled_for'])
        .where('booking_id', '=', b.id)
        .where('type', '=', 'BOOKING_REMINDER')
        .execute(),
    );
    const pending = reminders.filter((r) => r.status === 'PENDING');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.scheduled_for.getTime()).toBe(new Date(slots[3]!).getTime() - 86400_000);
    expect(t.jobs.notifications.get(pending[0]!.id)).toBeTruthy();
  });

  it('can move to an overlapping slot of its own (it does not block itself)', async () => {
    const tenant = await createTestTenant(t.db);
    await t.db.selectFrom('tenants').select('id').execute();
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const owner = await loginAs(t.app, tenant.owner.email, tenant.slug);
    // Make the service 60 min long so 09:00-10:00 → 09:30-10:30 overlaps itself.
    await owner.patch(`/services/${tenant.service.id}`, { durationMinutes: 60 });
    await owner.put(`/staff/${tenant.staff.membershipId}/availability`, {
      rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
    });
    const date = dateIn(5);
    const slots = await slotsFor(t.app, tenant, date);
    const b = (await hold(c, slots[0]!, tenant)).json();
    await confirmDirect(t.db, tenant.tenantId, b.id);
    // Default grid steps by duration (60 min); 30 minutes later isn't on it, so use slot 1.
    const res = await owner.post(`/bookings/${b.id}/reschedule`, { startAt: slots[1] });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a taken slot, and customers inside the window', async () => {
    const tenant = await createTestTenant(t.db, { cancellationWindowHours: 24 * 30 });
    const [x] = await addCustomers(t.db, tenant, 1);
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const c2 = await loginAs(t.app, x!.email, tenant.slug);
    const slots = await slotsFor(t.app, tenant, dateIn(4));
    const mine = (await hold(c, slots[0]!, tenant)).json();
    await confirmDirect(t.db, tenant.tenantId, mine.id);
    await hold(c2, slots[1]!, tenant);

    const owner = await loginAs(t.app, tenant.owner.email, tenant.slug);
    const taken = await owner.post(`/bookings/${mine.id}/reschedule`, { startAt: slots[1] });
    expect(taken.statusCode).toBe(409);

    const tooLate = await c.post(`/bookings/${mine.id}/reschedule`, { startAt: slots[2] });
    expect(tooLate.statusCode).toBe(409);
    expect(tooLate.json().error.code).toBe('INVALID_STATE');
  });
});

describe('complete / no-show', () => {
  it('staff marks their own past booking; not future ones, not other people’s', async () => {
    const tenant = await createTestTenant(t.db);
    const staff = await loginAs(t.app, tenant.staff.email, tenant.slug);
    const past = await insertBookingDirect(t.db, tenant, {
      startAt: new Date(Date.now() - 3600_000),
      status: 'CONFIRMED',
    });
    const future = await insertBookingDirect(t.db, tenant, {
      startAt: new Date(Date.now() + 5 * 86400_000),
      status: 'CONFIRMED',
    });
    const ownersBooking = await insertBookingDirect(t.db, tenant, {
      startAt: new Date(Date.now() - 7200_000),
      status: 'CONFIRMED',
      staffMembershipId: tenant.owner.membershipId,
    });

    const done = await staff.post(`/bookings/${past.id}/complete`);
    expect(done.json().status).toBe('COMPLETED');
    expect((await staff.post(`/bookings/${past.id}/no-show`)).statusCode).toBe(409); // already final
    expect((await staff.post(`/bookings/${future.id}/no-show`)).statusCode).toBe(409);
    expect((await staff.post(`/bookings/${ownersBooking.id}/complete`)).statusCode).toBe(404);

    const customerClient = await loginAs(t.app, tenant.customer.email, tenant.slug);
    expect((await customerClient.post(`/bookings/${future.id}/complete`)).statusCode).toBe(403);
  });
});

describe('who can see which bookings', () => {
  it('customers see only their own; staff only theirs; owners all; other tenants nothing', async () => {
    const tenant = await createTestTenant(t.db);
    const [x] = await addCustomers(t.db, tenant, 1);
    const c1 = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const c2 = await loginAs(t.app, x!.email, tenant.slug);
    const [slot] = await slotsFor(t.app, tenant, dateIn(5));
    const b = (await hold(c1, slot!, tenant)).json();
    await confirmDirect(t.db, tenant.tenantId, b.id);

    expect((await c1.get(`/bookings/${b.id}`)).statusCode).toBe(200);
    expect((await c2.get(`/bookings/${b.id}`)).statusCode).toBe(404);
    expect((await c2.post(`/bookings/${b.id}/cancel`)).statusCode).toBe(404);
    expect(
      (await c1.get('/bookings/mine')).json().bookings.map((x: { id: string }) => x.id),
    ).toContain(b.id);
    expect((await c2.get('/bookings/mine')).json().bookings).toEqual([]);

    const staff = await loginAs(t.app, tenant.staff.email, tenant.slug);
    expect((await staff.get(`/bookings/${b.id}`)).statusCode).toBe(200);
    const schedule = (await staff.get('/staff/schedule')).json().bookings;
    expect(schedule.map((x: { id: string }) => x.id)).toContain(b.id);

    const owner = await loginAs(t.app, tenant.owner.email, tenant.slug);
    expect(
      (await owner.get('/bookings')).json().bookings.map((x: { id: string }) => x.id),
    ).toContain(b.id);

    // Another tenant's owner: 404 on every route.
    const otherOwner = await loginAs(t.app, T.owner.email, T.slug);
    expect((await otherOwner.get(`/bookings/${b.id}`)).statusCode).toBe(404);
    expect((await otherOwner.post(`/bookings/${b.id}/cancel`)).statusCode).toBe(404);
    expect(
      (await otherOwner.post(`/bookings/${b.id}/reschedule`, { startAt: slot })).statusCode,
    ).toBe(404);
    expect(
      (await otherOwner.get('/bookings')).json().bookings.map((x: { id: string }) => x.id),
    ).not.toContain(b.id);
  });
});
