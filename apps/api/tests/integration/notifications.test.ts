import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestApp, loginAs, type TestApp } from '../helpers/app';
import { createTestTenant } from '../helpers/factory';
import { bookAndPay } from '../helpers/payments';
import { RecordingMailer } from '../helpers/recording-mailer';
import { withTenant } from '../../src/db/tenant-tx';
import { processNotification, reconcile } from '../../src/modules/notifications/service';
import { createNotification } from '../../src/modules/notifications/repo';
import { formatWhen, renderBookingEmail } from '../../src/modules/notifications/templates';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

/** A confirmed, paid booking plus handles to its notifications. */
async function confirmedBooking(opts: { days?: number } = {}) {
  const tenant = await createTestTenant(t.db);
  const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
  const { bookingId, startAt } = await bookAndPay(t.app, c, tenant, { days: opts.days });
  const notes = await withTenant(t.db, tenant.tenantId, (tx) =>
    tx.db.selectFrom('notifications').selectAll().where('booking_id', '=', bookingId).execute(),
  );
  const byType = (type: string) => notes.find((n) => n.type === type)!;
  return { tenant, c, bookingId, startAt, byType };
}

const status = (tenantId: string, id: string) =>
  withTenant(t.db, tenantId, (tx) =>
    tx.db
      .selectFrom('notifications')
      .select(['status', 'attempts', 'last_error'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow(),
  );

describe('processNotification', () => {
  it('sends the confirmation once, with the time in the business timezone', async () => {
    const { tenant, startAt, byType } = await confirmedBooking();
    const mailer = new RecordingMailer();
    const deps = { db: t.db, mailer, webOrigin: 'http://localhost:5173' };
    const confirmation = byType('BOOKING_CONFIRMED');

    expect(await processNotification(deps, tenant.tenantId, confirmation.id)).toBe('sent');
    expect(mailer.sent).toHaveLength(1);
    const email = mailer.sent[0]!;
    expect(email.to).toBe(tenant.customer.email);
    expect(email.subject).toContain('Confirmed: Haircut');
    expect(email.text).toContain(formatWhen(new Date(startAt), 'Asia/Kolkata'));
    expect(email.text).toContain('₹500.00');
    expect((await status(tenant.tenantId, confirmation.id)).status).toBe('SENT');

    // A second delivery of the same job does nothing.
    expect(await processNotification(deps, tenant.tenantId, confirmation.id)).toBe('skipped');
    expect(mailer.sent).toHaveLength(1);
  });

  it('does not send a reminder before it is due', async () => {
    const { tenant, byType } = await confirmedBooking({ days: 5 });
    const mailer = new RecordingMailer();
    const outcome = await processNotification(
      { db: t.db, mailer, webOrigin: '' },
      tenant.tenantId,
      byType('BOOKING_REMINDER').id,
    );
    expect(outcome).toBe('not_due');
    expect(mailer.sent).toEqual([]);
  });

  it('a reminder for a booking that was cancelled is cancelled, not sent', async () => {
    const { tenant, c, bookingId } = await confirmedBooking();
    // Create a due reminder, then cancel the booking.
    const due = await withTenant(t.db, tenant.tenantId, (tx) =>
      createNotification(tx, bookingId, 'BOOKING_REMINDER', new Date()),
    );
    await withTenant(t.db, tenant.tenantId, (tx) =>
      tx.db
        .updateTable('bookings')
        .set({ status: 'CANCELLED' })
        .where('id', '=', bookingId)
        .execute(),
    );
    const mailer = new RecordingMailer();
    expect(
      await processNotification({ db: t.db, mailer, webOrigin: '' }, tenant.tenantId, due.id),
    ).toBe('cancelled');
    expect(mailer.sent).toEqual([]);
    expect(c).toBeTruthy();
  });

  it('cancelling a booking stops its reminder and sends a cancellation email with refund info', async () => {
    const { tenant, c, bookingId, byType } = await confirmedBooking({ days: 5 });
    await c.post(`/bookings/${bookingId}/cancel`);
    expect((await status(tenant.tenantId, byType('BOOKING_REMINDER').id)).status).toBe('CANCELLED');
    expect(t.jobs.cancelledNotifications).toContain(byType('BOOKING_REMINDER').id);

    const cancelled = await withTenant(t.db, tenant.tenantId, (tx) =>
      tx.db
        .selectFrom('notifications')
        .select('id')
        .where('booking_id', '=', bookingId)
        .where('type', '=', 'BOOKING_CANCELLED')
        .executeTakeFirstOrThrow(),
    );
    const mailer = new RecordingMailer();
    await processNotification({ db: t.db, mailer, webOrigin: '' }, tenant.tenantId, cancelled.id);
    expect(mailer.sent[0]!.text).toMatch(/full refund of ₹500.00/);
  });

  it('retries on SMTP failure, becomes FAILED after the last attempt, and the owner can retry it', async () => {
    const { tenant, byType } = await confirmedBooking();
    const n = byType('BOOKING_CONFIRMED');
    const mailer = new RecordingMailer();
    const deps = { db: t.db, mailer, webOrigin: '' };

    mailer.failures = 2;
    await expect(
      processNotification(deps, tenant.tenantId, n.id, { number: 1, max: 2 }),
    ).rejects.toThrow(/SMTP/);
    expect(await status(tenant.tenantId, n.id)).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      last_error: 'SMTP connection refused',
    });
    await expect(
      processNotification(deps, tenant.tenantId, n.id, { number: 2, max: 2 }),
    ).rejects.toThrow(/SMTP/);
    expect(await status(tenant.tenantId, n.id)).toMatchObject({ status: 'FAILED', attempts: 2 });

    // The owner sees it on the dashboard and in the failed list.
    const owner = await loginAs(t.app, tenant.owner.email, tenant.slug);
    expect((await owner.get('/dashboard/summary')).json().failedNotifications).toBe(1);
    const failed = (await owner.get('/notifications?status=FAILED')).json().notifications;
    expect(failed).toEqual([
      expect.objectContaining({ id: n.id, status: 'FAILED', lastError: 'SMTP connection refused' }),
    ]);

    // Retry puts it back in the queue; this time it sends.
    expect((await owner.post(`/notifications/${n.id}/retry`)).statusCode).toBe(200);
    expect(t.jobs.notifications.has(n.id)).toBe(true);
    expect(await processNotification(deps, tenant.tenantId, n.id)).toBe('sent');
    expect((await owner.get('/dashboard/summary')).json().failedNotifications).toBe(0);
  });
});

describe('reconcile (the every-minute safety net)', () => {
  it('re-queues due emails that never got a job, expires stale holds and re-queues stuck refunds', async () => {
    const { tenant, c, bookingId, byType } = await confirmedBooking();
    const confirmation = byType('BOOKING_CONFIRMED');
    // Pretend the job was lost two minutes ago.
    await withTenant(t.db, tenant.tenantId, (tx) =>
      tx.db
        .updateTable('notifications')
        .set({ scheduled_for: sql`now() - interval '2 minutes'` })
        .where('id', '=', confirmation.id)
        .execute(),
    );
    // A stale hold that nobody expired.
    const hold = await (async () => {
      const slots = (
        await t.app.inject({
          url: `/public/${tenant.slug}/slots?serviceId=${tenant.service.id}&staffId=${tenant.staff.membershipId}&date=${new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10)}`,
        })
      ).json().slots;
      return (
        await c.post('/bookings/hold', {
          serviceId: tenant.service.id,
          staffId: tenant.staff.membershipId,
          startAt: slots[0].startAt,
        })
      ).json();
    })();
    await withTenant(t.db, tenant.tenantId, (tx) =>
      tx.db
        .updateTable('bookings')
        .set({ hold_expires_at: sql`now() - interval '1 minute'` })
        .where('id', '=', hold.id)
        .execute(),
    );
    // A refund stuck in REFUND_PENDING.
    await c.post(`/bookings/${bookingId}/cancel`);
    await withTenant(t.db, tenant.tenantId, (tx) =>
      tx.db
        .updateTable('payments')
        .set({ updated_at: sql`now() - interval '5 minutes'` })
        .where('booking_id', '=', bookingId)
        .execute(),
    );

    t.jobs.notifications.clear();
    t.jobs.refunds.length = 0;
    const result = await reconcile(t.db, t.jobs);

    expect(result.expiredHolds).toBeGreaterThanOrEqual(1);
    expect(t.jobs.notifications.has(confirmation.id)).toBe(true);
    expect(t.jobs.refunds.some((r) => r.tenantId === tenant.tenantId)).toBe(true);
    expect((await c.get(`/bookings/${hold.id}`)).json().status).toBe('EXPIRED');
  });
});

describe('email templates', () => {
  const data = {
    businessName: 'Glow <b>Salon</b>',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    customerName: '<script>alert(1)</script>',
    customerEmail: 'x@test.local',
    serviceName: 'Cut',
    staffName: 'Asha',
    startAt: new Date('2026-12-01T03:30:00Z'),
    pricePaise: 80000,
    refundReason: null,
    manageUrl: 'http://localhost:5173/app/bookings',
  };

  it('escapes names in HTML so they cannot inject markup', () => {
    const email = renderBookingEmail('BOOKING_CONFIRMED', data);
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
  });

  it('shows the appointment in the business timezone', () => {
    expect(formatWhen(data.startAt, 'Asia/Kolkata')).toBe('Tue 1 Dec 2026, 9:00 AM GMT+5:30');
  });
});
