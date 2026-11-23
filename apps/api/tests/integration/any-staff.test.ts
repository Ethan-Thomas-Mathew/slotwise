import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { createTestApp, loginAs, type TestApp } from '../helpers/app';
import { createTestTenant, type TestTenant } from '../helpers/factory';
import { addCustomers, dateIn, insertBookingDirect } from '../helpers/booking';
import { withTenant } from '../../src/db/tenant-tx';
import { setStaffServices } from '../../src/modules/staff/repo';
import { replaceRules } from '../../src/modules/availability/repo';

/**
 * "Anyone available": the customer picks a time, and whoever is free that
 * time gets the booking (the least busy person first).
 */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

/** A tenant where BOTH the staff member (09:00-17:00) and the owner (13:00-19:00) offer the service, every day. */
async function twoPersonTenant() {
  const tenant = await createTestTenant(t.db);
  await withTenant(t.db, tenant.tenantId, async (tx) => {
    await setStaffServices(tx, tenant.owner.membershipId, [tenant.service.id]);
    await replaceRules(
      tx,
      tenant.owner.membershipId,
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        startMinute: 13 * 60,
        endMinute: 19 * 60,
      })),
    );
  });
  return tenant;
}

const slotsAny = async (tenant: TestTenant, date: string) =>
  (
    await t.app.inject({
      url: `/public/${tenant.slug}/slots?serviceId=${tenant.service.id}&staffId=any&date=${date}`,
    })
  ).json();

const at = (date: string, time: string) =>
  DateTime.fromISO(`${date}T${time}`, { zone: 'Asia/Kolkata' }).toUTC().toISO();

describe('slots for "anyone available"', () => {
  it('are the union of everyone’s open times', async () => {
    const tenant = await twoPersonTenant();
    const date = dateIn(4);
    const res = await slotsAny(tenant, date);
    // 09:00-17:00 (staff) ∪ 13:00-19:00 (owner) = 09:00-19:00 → 20 half-hour slots
    expect(res.slots).toHaveLength(20);
    const days = (
      await t.app.inject({
        url: `/public/${tenant.slug}/days?serviceId=${tenant.service.id}&staffId=any&from=${date}&days=3`,
      })
    ).json().days;
    expect(days[0]).toEqual({ date, openSlots: 20 });
  });

  it('a time stays open while at least one person is free', async () => {
    const tenant = await twoPersonTenant();
    const date = dateIn(4);
    await insertBookingDirect(t.db, tenant, {
      startAt: new Date(at(date, '14:00:00')!),
      status: 'CONFIRMED',
    }); // staff busy at 14:00
    const res = await slotsAny(tenant, date);
    expect(res.slots.map((s: { startAt: string }) => s.startAt)).toContain(
      new Date(at(date, '14:00:00')!).toISOString(),
    );
  });
});

describe('holding with "anyone available"', () => {
  it('gives the booking to the least busy person who is free', async () => {
    const tenant = await twoPersonTenant();
    const date = dateIn(5);
    // The staff member already has a booking that day; the owner has none.
    await insertBookingDirect(t.db, tenant, {
      startAt: new Date(at(date, '09:00:00')!),
      status: 'CONFIRMED',
    });
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const res = await c.post('/bookings/hold', {
      serviceId: tenant.service.id,
      staffId: 'any',
      startAt: at(date, '15:00:00'),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().staff.membershipId).toBe(tenant.owner.membershipId);
  });

  it('falls back to the other person when the first choice is taken', async () => {
    const tenant = await twoPersonTenant();
    const date = dateIn(5);
    const [a, b] = await addCustomers(t.db, tenant, 2);
    const ca = await loginAs(t.app, a!.email, tenant.slug);
    const cb = await loginAs(t.app, b!.email, tenant.slug);
    const first = await ca.post('/bookings/hold', {
      serviceId: tenant.service.id,
      staffId: 'any',
      startAt: at(date, '14:00:00'),
    });
    const second = await cb.post('/bookings/hold', {
      serviceId: tenant.service.id,
      staffId: 'any',
      startAt: at(date, '14:00:00'),
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().staff.membershipId).not.toBe(second.json().staff.membershipId);
  });

  it('only one person works at 10:00, so a second "any" request then gets 409', async () => {
    const tenant = await twoPersonTenant();
    const date = dateIn(5);
    const [a, b] = await addCustomers(t.db, tenant, 2);
    const ca = await loginAs(t.app, a!.email, tenant.slug);
    const cb = await loginAs(t.app, b!.email, tenant.slug);
    expect(
      (
        await ca.post('/bookings/hold', {
          serviceId: tenant.service.id,
          staffId: 'any',
          startAt: at(date, '10:00:00'),
        })
      ).statusCode,
    ).toBe(201);
    const res = await cb.post('/bookings/hold', {
      serviceId: tenant.service.id,
      staffId: 'any',
      startAt: at(date, '10:00:00'),
    });
    expect(res.statusCode).toBe(409);
  });

  it('CONCURRENCY: 12 customers ask for the same time at once → exactly 2 bookings, one per person', async () => {
    const tenant = await twoPersonTenant();
    const customers = await addCustomers(t.db, tenant, 12);
    const clients = await Promise.all(customers.map((c) => loginAs(t.app, c.email, tenant.slug)));
    for (let run = 0; run < 5; run++) {
      const date = dateIn(6 + run);
      const results = await Promise.all(
        clients.map((c) =>
          c.post('/bookings/hold', {
            serviceId: tenant.service.id,
            staffId: 'any',
            startAt: at(date, '15:30:00'),
          }),
        ),
      );
      const codes = results.map((r) => r.statusCode);
      expect(
        codes.filter((x) => x === 201),
        `run ${run}`,
      ).toHaveLength(2);
      expect(
        codes.filter((x) => x === 409),
        `run ${run}`,
      ).toHaveLength(10);
      const staff = results
        .filter((r) => r.statusCode === 201)
        .map((r) => r.json().staff.membershipId);
      expect(new Set(staff).size).toBe(2);
      // Free the winners' hold quota for the next run.
      for (const r of results.filter((x) => x.statusCode === 201)) {
        const winner = clients[results.indexOf(r)]!;
        await winner.post(`/bookings/${r.json().id}/cancel`);
      }
    }
  });

  it('a service nobody offers has no "anyone" slots', async () => {
    const tenant = await createTestTenant(t.db);
    await withTenant(t.db, tenant.tenantId, (tx) =>
      setStaffServices(tx, tenant.staff.membershipId, []),
    );
    const res = await t.app.inject({
      url: `/public/${tenant.slug}/slots?serviceId=${tenant.service.id}&staffId=any&date=${dateIn(3)}`,
    });
    expect(res.statusCode).toBe(404);
  });
});
