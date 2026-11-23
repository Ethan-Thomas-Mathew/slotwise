import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { appDb } from '../helpers/db';
import { createTestTenant, type TestTenant } from '../helpers/factory';
import { withSystem, withTenant } from '../../src/db/tenant-tx';
import * as services from '../../src/modules/services/repo';
import * as bookings from '../../src/modules/bookings/repo';
import * as staff from '../../src/modules/staff/repo';

/**
 * Tenant isolation, tested at two layers:
 *  1. Repository layer: functions scoped to tenant B can't see/change tenant A's rows.
 *  2. Database layer (RLS) on its own: even a hand-written query with NO
 *     tenant filter returns nothing from another tenant.
 * HTTP-level tests (404s for cross-tenant IDs) live in tenant-isolation.http.test.ts.
 */
const db = appDb();
let A: TestTenant;
let B: TestTenant;
let bookingA: string;

beforeAll(async () => {
  A = await createTestTenant(db);
  B = await createTestTenant(db);
  const start = DateTime.utc().plus({ days: 2 }).startOf('hour').toJSDate();
  bookingA = await withTenant(db, A.tenantId, async (tx) => {
    const b = await bookings.insertHeldBooking(tx, {
      serviceId: A.service.id,
      staffMembershipId: A.staff.membershipId,
      customerMembershipId: A.customer.membershipId,
      startAt: start,
      endAt: new Date(start.getTime() + 30 * 60_000),
      pricePaise: 50000,
      holdExpiresAt: new Date(Date.now() + 10 * 60_000),
    });
    return b.id;
  });
});
afterAll(() => db.destroy());

describe('repository layer', () => {
  it("tenant B cannot read tenant A's service, booking or staff by id", async () => {
    await withTenant(db, B.tenantId, async (tx) => {
      expect(await services.getService(tx, A.service.id)).toBeUndefined();
      expect(await bookings.getBookingView(tx, bookingA)).toBeUndefined();
      expect(await staff.getStaffMember(tx, A.staff.membershipId)).toBeUndefined();
    });
  });

  it("tenant B cannot update or delete tenant A's service", async () => {
    await withTenant(db, B.tenantId, async (tx) => {
      expect(await services.updateService(tx, A.service.id, { name: 'hacked' })).toBeUndefined();
      expect(await services.deleteService(tx, A.service.id)).toBe(false);
    });
    const still = await withTenant(db, A.tenantId, (tx) => services.getService(tx, A.service.id));
    expect(still?.name).toBe('Haircut');
  });

  it("tenant B cannot change tenant A's booking status", async () => {
    const res = await withTenant(db, B.tenantId, (tx) =>
      bookings.setBookingStatus(tx, bookingA, 'HELD', 'CANCELLED'),
    );
    expect(res).toBeUndefined();
  });

  it("tenant B cannot attach tenant A's service to its own staff (composite FK)", async () => {
    await expect(
      withTenant(db, B.tenantId, (tx) =>
        staff.setStaffServices(tx, B.staff.membershipId, [A.service.id]),
      ),
    ).rejects.toThrow();
  });
});

describe('database layer (RLS on its own)', () => {
  it('a query with NO tenant filter only sees the current tenant', async () => {
    const rows = await withTenant(db, B.tenantId, async (tx) => {
      const { rows } = await sql<{ tenant_id: string }>`SELECT tenant_id FROM services`.execute(
        tx.db,
      );
      return rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenant_id === B.tenantId)).toBe(true);
  });

  it('a raw query with the wrong app.tenant_id returns zero rows', async () => {
    const count = await withTenant(db, B.tenantId, async (tx) => {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*) AS n FROM bookings WHERE id = ${bookingA}`.execute(tx.db);
      return rows[0]!.n;
    });
    expect(count).toBe(0);
  });

  it('with no tenant set at all, tenant tables are empty (fails closed)', async () => {
    const counts = await withSystem(db, async (tx) => {
      const { rows } = await sql<{ s: number; b: number; m: number }>`
        SELECT (SELECT count(*) FROM services) AS s,
               (SELECT count(*) FROM bookings) AS b,
               (SELECT count(*) FROM memberships) AS m`.execute(tx.db);
      return rows[0]!;
    });
    expect(counts).toEqual({ s: 0, b: 0, m: 0 });
  });

  it('a pooled connection does not leak the previous transaction’s tenant', async () => {
    // Use a 1-connection pool so the second query reuses the same connection.
    const { createDatabase } = await import('../../src/db/database');
    const single = createDatabase(process.env.DATABASE_URL!, { max: 1 });
    await withTenant(single, A.tenantId, async () => undefined);
    const { rows } = await sql<{ n: number }>`SELECT count(*) AS n FROM services`.execute(single);
    expect(rows[0]!.n).toBe(0);
    await single.destroy();
  });

  it('writing a row for another tenant is rejected by WITH CHECK', async () => {
    await expect(
      withTenant(db, B.tenantId, (tx) =>
        tx.db
          .insertInto('services')
          .values({
            tenant_id: A.tenantId,
            name: 'sneaky',
            duration_minutes: 30,
            price_paise: 1000,
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("tenant B cannot rename tenant A's tenants row", async () => {
    await withTenant(db, B.tenantId, (tx) =>
      tx.db.updateTable('tenants').set({ name: 'pwned' }).where('id', '=', A.tenantId).execute(),
    );
    const a = await db
      .selectFrom('tenants')
      .select('name')
      .where('id', '=', A.tenantId)
      .executeTakeFirst();
    expect(a?.name).not.toBe('pwned');
  });

  it('the audit log is append-only for the app role', async () => {
    await withTenant(db, A.tenantId, (tx) =>
      tx.db
        .insertInto('audit_logs')
        .values({ tenant_id: A.tenantId, action: 'test', entity: 'test' })
        .execute(),
    );
    await expect(
      withTenant(db, A.tenantId, (tx) => tx.db.deleteFrom('audit_logs').execute()),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('double-booking constraint', () => {
  it('rejects an overlapping HELD booking for the same staff member', async () => {
    const existing = await withTenant(db, A.tenantId, (tx) =>
      bookings.getBookingView(tx, bookingA),
    );
    await expect(
      withTenant(db, A.tenantId, (tx) =>
        bookings.insertHeldBooking(tx, {
          serviceId: A.service.id,
          staffMembershipId: A.staff.membershipId,
          customerMembershipId: A.customer.membershipId,
          startAt: new Date(existing!.start_at.getTime() + 15 * 60_000), // overlaps by 15 min
          endAt: new Date(existing!.end_at.getTime() + 15 * 60_000),
          pricePaise: 50000,
          holdExpiresAt: new Date(Date.now() + 600_000),
        }),
      ),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('allows back-to-back bookings ([) ranges do not overlap)', async () => {
    const existing = await withTenant(db, A.tenantId, (tx) =>
      bookings.getBookingView(tx, bookingA),
    );
    const b = await withTenant(db, A.tenantId, (tx) =>
      bookings.insertHeldBooking(tx, {
        serviceId: A.service.id,
        staffMembershipId: A.staff.membershipId,
        customerMembershipId: A.customer.membershipId,
        startAt: existing!.end_at,
        endAt: new Date(existing!.end_at.getTime() + 30 * 60_000),
        pricePaise: 50000,
        holdExpiresAt: new Date(Date.now() + 600_000),
      }),
    );
    expect(b.status).toBe('HELD');
  });
});
