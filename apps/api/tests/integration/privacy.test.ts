import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '../../src/db/tenant-tx';
import { insertMembership } from '../../src/modules/memberships/repo';
import { writeAudit } from '../../src/modules/audit/repo';
import { Client, createTestApp, loginAs, type TestApp } from '../support/app';
import {
  addCustomers,
  confirmDirect,
  dateIn,
  insertBookingDirect,
  slotsFor,
} from '../support/booking';
import { holdSlot } from '../../src/modules/bookings/service';
import { createTestTenant, TEST_PASSWORD, type TestTenant } from '../support/factory';

let t: TestApp;
let A: TestTenant;
let B: TestTenant;

const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000);
const DELETE_BODY = { password: TEST_PASSWORD, confirm: 'DELETE' };

beforeAll(async () => {
  t = await createTestApp();
  A = await createTestTenant(t.db);
  B = await createTestTenant(t.db);
});
afterAll(async () => {
  await t.close();
});

describe('download my data', () => {
  it('contains my profile, memberships in every business, and only MY bookings', async () => {
    // The customer of A is also a customer of B.
    await withTenant(t.db, B.tenantId, (tx) => insertMembership(tx, A.customer.userId, 'CUSTOMER'));
    const mine = await insertBookingDirect(t.db, A, { startAt: daysFromNow(-3), status: 'HELD' });
    await confirmDirect(t.db, A.tenantId, mine.id);
    const [other] = await addCustomers(t.db, A, 1);
    await insertBookingDirect(t.db, A, {
      startAt: daysFromNow(-2),
      status: 'COMPLETED',
      customerMembershipId: other!.membershipId,
    });

    const c = await loginAs(t.app, A.customer.email, A.slug);
    const res = await c.get('/account/data');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="slotwise-my-data-/);
    expect(res.headers['cache-control']).toBe('no-store');

    const data = res.json();
    expect(data.user.email).toBe(A.customer.email);
    expect(data.memberships.map((m: { bookingLink: string }) => m.bookingLink).sort()).toEqual(
      [`/b/${A.slug}`, `/b/${B.slug}`].sort(),
    );
    expect(data.bookings).toHaveLength(1);
    expect(data.bookings[0]).toMatchObject({
      id: mine.id,
      service: 'Haircut',
      status: 'CONFIRMED',
      payments: [{ amountPaise: 50000, status: 'CAPTURED', currency: 'INR' }],
    });
    expect(JSON.stringify(data)).not.toContain(other!.email);
    expect(JSON.stringify(data)).not.toContain('password');
  });

  it('needs a login', async () => {
    expect((await new Client(t.app).get('/account/data')).statusCode).toBe(401);
  });
});

describe('delete my account', () => {
  it('refuses a wrong password, a missing confirmation, and a missing CSRF token', async () => {
    const c = await loginAs(t.app, A.customer.email, A.slug);
    const wrong = await c.post('/account/delete', { password: 'not-it', confirm: 'DELETE' });
    expect(wrong.statusCode).toBe(403);
    const noConfirm = await c.post('/account/delete', { password: TEST_PASSWORD, confirm: 'yes' });
    expect(noConfirm.statusCode).toBe(400);
    const noCsrf = await t.app.inject({
      method: 'POST',
      url: '/account/delete',
      headers: { cookie: c.cookie! },
      payload: DELETE_BODY,
    });
    expect(noCsrf.statusCode).toBe(403);
    expect((await c.get('/auth/me')).statusCode).toBe(200); // still there
  });

  it('refuses owners and staff', async () => {
    const owner = await loginAs(t.app, A.owner.email, A.slug);
    const o = await owner.post('/account/delete', DELETE_BODY);
    expect(o.statusCode).toBe(409);
    expect(o.json().error.message).toMatch(/You own/);
    const staff = await loginAs(t.app, A.staff.email, A.slug);
    const s = await staff.post('/account/delete', DELETE_BODY);
    expect(s.statusCode).toBe(409);
    expect(s.json().error.message).toMatch(/remove you from the team/);
  });

  it('refuses while the customer has an upcoming booking', async () => {
    const [cust] = await addCustomers(t.db, A, 1);
    await insertBookingDirect(t.db, A, {
      startAt: daysFromNow(2),
      status: 'CONFIRMED',
      customerMembershipId: cust!.membershipId,
    });
    const c = await loginAs(t.app, cust!.email, A.slug);
    const res = await c.post('/account/delete', DELETE_BODY);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/upcoming booking/);
  });

  it('anonymises the account, keeps the business records, and logs everyone out', async () => {
    const [cust] = await addCustomers(t.db, A, 1);
    const past = await insertBookingDirect(t.db, A, {
      startAt: daysFromNow(-5),
      status: 'COMPLETED',
      customerMembershipId: cust!.membershipId,
    });
    // An older audit entry that mentions this person's email.
    await withTenant(t.db, A.tenantId, (tx) =>
      writeAudit(tx, { action: 'test.mention', entity: 'user', after: { email: cust!.email } }),
    );
    const c = await loginAs(t.app, cust!.email, A.slug);
    const otherDevice = await loginAs(t.app, cust!.email, A.slug);

    const res = await c.post('/account/delete', DELETE_BODY);
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((k) => k.name === 'sid')?.value).toBe('');

    // Every session is gone, and the old email + password no longer work.
    expect((await otherDevice.get('/auth/me')).statusCode).toBe(401);
    const login = await new Client(t.app).post('/auth/login', {
      email: cust!.email,
      password: TEST_PASSWORD,
    });
    expect(login.statusCode).toBe(401);

    // The booking stays for the business's records, but no longer names anyone.
    const owner = await loginAs(t.app, A.owner.email, A.slug);
    const booking = (await owner.get(`/bookings/${past.id}`)).json();
    expect(booking.customer.name).toBe('Deleted user');
    expect(booking.customer.email).toMatch(/@deleted\.invalid$/);

    // Nothing in the database still contains the email.
    const audit = await withTenant(t.db, A.tenantId, (tx) =>
      tx.db.selectFrom('audit_logs').selectAll().execute(),
    );
    expect(JSON.stringify(audit)).not.toContain(cust!.email);
    expect(audit.some((a) => a.action === 'customer.account_deleted')).toBe(true);
    const users = await withSystem(t.db, (tx) =>
      tx.db.selectFrom('users').select('email').where('email', '=', cust!.email).execute(),
    );
    expect(users).toEqual([]);
  });

  it('a hold request already in flight when the account is erased cannot create a booking', async () => {
    const [cust] = await addCustomers(t.db, A, 1);
    const { user_id: userId } = await withTenant(t.db, A.tenantId, (tx) =>
      tx.db
        .selectFrom('memberships')
        .select('user_id')
        .where('id', '=', cust!.membershipId)
        .executeTakeFirstOrThrow(),
    );
    const actor = { userId, membershipId: cust!.membershipId, role: 'CUSTOMER' as const };
    const [startAt] = await slotsFor(t.app, A, dateIn(7));
    const tryHold = () =>
      withTenant(t.db, A.tenantId, (tx) =>
        holdSlot(
          tx,
          actor,
          { serviceId: A.service.id, staffId: A.staff.membershipId, startAt: startAt! },
          [],
          { jobs: t.jobs },
        ),
      );
    // Sanity check: this actor can hold a slot before the erasure (then cancel it).
    const before = await tryHold();
    await withTenant(t.db, A.tenantId, (tx) =>
      tx.db
        .updateTable('bookings')
        .set({ status: 'CANCELLED' })
        .where('id', '=', before.id)
        .execute(),
    );

    const c = await loginAs(t.app, cust!.email, A.slug);
    expect((await c.post('/account/delete', DELETE_BODY)).statusCode).toBe(200);

    // The request passed its session check just before the erasure committed.
    const attempt = tryHold();
    await expect(attempt).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
