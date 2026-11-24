import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createTestApp, loginAs, type Client, type TestApp } from '../support/app';
import { createTestTenant, type TestTenant } from '../support/factory';
import { addCustomers, dateIn, slotsFor } from '../support/booking';
import { withTenant } from '../../src/db/tenant-tx';
import { mockWebhookBody } from '../../src/modules/payments/routes';
import { processRefund } from '../../src/modules/payments/service';

let t: TestApp;
let T: TestTenant;
let customer: Client;
const SECRET = 'test_webhook_secret';

beforeAll(async () => {
  t = await createTestApp();
  T = await createTestTenant(t.db);
  customer = await loginAs(t.app, T.customer.email, T.slug);
});
afterAll(() => t.close());

/** Sends a webhook exactly as Razorpay would: raw JSON body + HMAC signature header. */
async function sendWebhook(
  body: object,
  opts: { eventId?: string; signature?: string; secret?: string } = {},
) {
  const raw = JSON.stringify(body);
  return t.app.inject({
    method: 'POST',
    url: '/webhooks/razorpay',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature':
        opts.signature ??
        createHmac('sha256', opts.secret ?? SECRET)
          .update(raw)
          .digest('hex'),
      'x-razorpay-event-id': opts.eventId ?? `evt_${randomUUID()}`,
    },
    payload: raw,
  });
}

/** A new customer in tenant T (each customer may only hold 3 slots at once). */
async function freshCustomer(tenant: TestTenant = T) {
  const [c] = await addCustomers(t.db, tenant, 1);
  return loginAs(t.app, c!.email, tenant.slug);
}

/** Hold a slot and create its order. Returns booking id, order id and amount. */
async function holdAndOrder(c?: Client, tenant: TestTenant = T, slotIndex = 0, days = 5) {
  c ??= await freshCustomer(tenant);
  const slots = await slotsFor(t.app, tenant, dateIn(days));
  const hold = await c.post('/bookings/hold', {
    serviceId: tenant.service.id,
    staffId: tenant.staff.membershipId,
    startAt: slots[slotIndex],
  });
  expect(hold.statusCode).toBe(201);
  const order = await c.post('/payments/order', { bookingId: hold.json().id });
  expect(order.statusCode).toBe(200);
  return {
    bookingId: hold.json().id as string,
    orderId: order.json().orderId as string,
    amount: order.json().amountPaise as number,
    startAt: slots[slotIndex]!,
  };
}

const bookingStatus = (tenantId: string, id: string) =>
  withTenant(t.db, tenantId, (tx) =>
    tx.db.selectFrom('bookings').select('status').where('id', '=', id).executeTakeFirstOrThrow(),
  ).then((r) => r.status);
const paymentOf = (tenantId: string, bookingId: string) =>
  withTenant(t.db, tenantId, (tx) =>
    tx.db
      .selectFrom('payments')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .executeTakeFirstOrThrow(),
  );
const notificationsOf = (tenantId: string, bookingId: string) =>
  withTenant(t.db, tenantId, (tx) =>
    tx.db
      .selectFrom('notifications')
      .select(['type', 'status'])
      .where('booking_id', '=', bookingId)
      .execute(),
  );

describe('POST /payments/order', () => {
  it('uses the price from the database, ignoring anything the client sends', async () => {
    const slots = await slotsFor(t.app, T, dateIn(6));
    const hold = (
      await customer.post('/bookings/hold', {
        serviceId: T.service.id,
        staffId: T.staff.membershipId,
        startAt: slots[0],
      })
    ).json();
    const res = await customer.post('/payments/order', { bookingId: hold.id, amountPaise: 100 });
    expect(res.json()).toMatchObject({
      provider: 'mock',
      amountPaise: 50000,
      currency: 'INR',
      keyId: null,
    });
    expect(t.payments.orders.get(res.json().orderId)?.amountPaise).toBe(50000);
  });

  it('clicking Pay twice returns the same order (no second order)', async () => {
    const c = await freshCustomer();
    const { bookingId, orderId } = await holdAndOrder(c, T, 1, 6);
    const again = await c.post('/payments/order', { bookingId });
    expect(again.json().orderId).toBe(orderId);
  });

  it("refuses someone else's booking (404) and an expired hold (409)", async () => {
    const [other] = await addCustomers(t.db, T, 1);
    const c2 = await loginAs(t.app, other!.email, T.slug);
    const slots = await slotsFor(t.app, T, dateIn(7));
    const hold = (
      await customer.post('/bookings/hold', {
        serviceId: T.service.id,
        staffId: T.staff.membershipId,
        startAt: slots[0],
      })
    ).json();
    expect((await c2.post('/payments/order', { bookingId: hold.id })).statusCode).toBe(404);

    await withTenant(t.db, T.tenantId, (tx) =>
      tx.db
        .updateTable('bookings')
        .set({ hold_expires_at: sql`now() - interval '1 second'` })
        .where('id', '=', hold.id)
        .execute(),
    );
    const expired = await customer.post('/payments/order', { bookingId: hold.id });
    expect(expired.statusCode).toBe(409);
  });
});

describe('POST /webhooks/razorpay', () => {
  it('valid payment.captured → booking CONFIRMED, emails queued, reminder scheduled', async () => {
    const tenant = await createTestTenant(t.db);
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const { bookingId, orderId, amount, startAt } = await holdAndOrder(c, tenant);

    // The browser redirect alone does NOT confirm anything.
    expect(await bookingStatus(tenant.tenantId, bookingId)).toBe('HELD');

    const res = await sendWebhook(mockWebhookBody(orderId, amount, 'INR', 'capture'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'processed' });

    expect(await bookingStatus(tenant.tenantId, bookingId)).toBe('CONFIRMED');
    expect((await paymentOf(tenant.tenantId, bookingId)).status).toBe('CAPTURED');
    const notes = await notificationsOf(tenant.tenantId, bookingId);
    expect(notes).toEqual(
      expect.arrayContaining([
        { type: 'BOOKING_CONFIRMED', status: 'PENDING' },
        { type: 'BOOKING_REMINDER', status: 'PENDING' },
      ]),
    );
    const reminder = await withTenant(t.db, tenant.tenantId, (tx) =>
      tx.db
        .selectFrom('notifications')
        .select(['id', 'scheduled_for'])
        .where('booking_id', '=', bookingId)
        .where('type', '=', 'BOOKING_REMINDER')
        .executeTakeFirstOrThrow(),
    );
    expect(reminder.scheduled_for.getTime()).toBe(new Date(startAt).getTime() - 24 * 3600_000);
    expect(t.jobs.notifications.get(reminder.id)?.at.getTime()).toBe(
      reminder.scheduled_for.getTime(),
    );
  });

  it('the same event delivered twice is processed once', async () => {
    const { bookingId, orderId, amount } = await holdAndOrder(undefined, T, 0, 8);
    const body = mockWebhookBody(orderId, amount, 'INR', 'capture');
    const eventId = `evt_${randomUUID()}`;
    expect((await sendWebhook(body, { eventId })).json().status).toBe('processed');
    expect((await sendWebhook(body, { eventId })).json().status).toBe('duplicate');

    const events = await t.db
      .selectFrom('webhook_events')
      .select('id')
      .where('event_id', '=', eventId)
      .execute();
    expect(events).toHaveLength(1);
    const confirmations = (await notificationsOf(T.tenantId, bookingId)).filter(
      (n) => n.type === 'BOOKING_CONFIRMED',
    );
    expect(confirmations).toHaveLength(1);
  });

  it('5 copies of the same event arriving at the same moment are processed once', async () => {
    const { bookingId, orderId, amount } = await holdAndOrder(undefined, T, 1, 8);
    const body = mockWebhookBody(orderId, amount, 'INR', 'capture');
    const eventId = `evt_${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => sendWebhook(body, { eventId })),
    );
    const outcomes = results.map((r) => r.json().status).sort();
    expect(outcomes).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'processed']);
    const confirmations = (await notificationsOf(T.tenantId, bookingId)).filter(
      (n) => n.type === 'BOOKING_CONFIRMED',
    );
    expect(confirmations).toHaveLength(1);
  });

  it('a different event for an already-captured payment does not confirm twice', async () => {
    const { bookingId, orderId, amount } = await holdAndOrder(undefined, T, 2, 8);
    await sendWebhook(mockWebhookBody(orderId, amount, 'INR', 'capture'));
    await sendWebhook({
      ...mockWebhookBody(orderId, amount, 'INR', 'capture'),
      event: 'order.paid',
    });
    expect(
      (await notificationsOf(T.tenantId, bookingId)).filter((n) => n.type === 'BOOKING_CONFIRMED'),
    ).toHaveLength(1);
    expect((await paymentOf(T.tenantId, bookingId)).status).toBe('CAPTURED');
  });

  it('invalid signature → 400, nothing stored, nothing changed', async () => {
    const { bookingId, orderId, amount } = await holdAndOrder(undefined, T, 0, 9);
    const eventId = `evt_${randomUUID()}`;
    const forged = await sendWebhook(mockWebhookBody(orderId, amount, 'INR', 'capture'), {
      eventId,
      secret: 'not-the-secret',
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json().error.code).toBe('BAD_SIGNATURE');
    const missing = await sendWebhook(mockWebhookBody(orderId, amount, 'INR', 'capture'), {
      signature: '',
    });
    expect(missing.statusCode).toBe(400);
    expect(await bookingStatus(T.tenantId, bookingId)).toBe('HELD');
    expect(
      await t.db
        .selectFrom('webhook_events')
        .select('id')
        .where('event_id', '=', eventId)
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it('a tampered body (amount changed after signing) is rejected', async () => {
    const { orderId, amount } = await holdAndOrder(undefined, T, 1, 9);
    const body = mockWebhookBody(orderId, amount, 'INR', 'capture');
    const raw = JSON.stringify(body);
    const signature = createHmac('sha256', SECRET).update(raw).digest('hex');
    const res = await t.app.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature },
      payload: raw.replace(`"amount":${amount}`, '"amount":1'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('a correctly signed body that is not a valid event is a 400, not a server error', async () => {
    for (const raw of [
      '{not json',
      '{"event": 42}',
      '{"event":"payment.captured","payload":{"payment":{"entity":{"amount":"lots"}}}}',
    ]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/webhooks/razorpay',
        headers: {
          'content-type': 'application/json',
          'x-razorpay-signature': createHmac('sha256', SECRET).update(raw).digest('hex'),
        },
        payload: raw,
      });
      expect(res.statusCode, raw).toBe(400);
    }
  });

  it('payment.failed keeps the hold so the customer can retry, then success confirms', async () => {
    const c = await freshCustomer();
    const { bookingId, orderId, amount } = await holdAndOrder(c, T, 2, 9);
    await sendWebhook(mockWebhookBody(orderId, amount, 'INR', 'fail'));
    expect((await paymentOf(T.tenantId, bookingId)).status).toBe('FAILED');
    expect(await bookingStatus(T.tenantId, bookingId)).toBe('HELD');
    // Retrying "Pay" reuses the same order.
    expect((await c.post('/payments/order', { bookingId })).json().orderId).toBe(orderId);
    await sendWebhook(mockWebhookBody(orderId, amount, 'INR', 'capture'));
    expect(await bookingStatus(T.tenantId, bookingId)).toBe('CONFIRMED');
  });

  it('an unknown order is acknowledged (200) and ignored', async () => {
    const res = await sendWebhook(mockWebhookBody('order_does_not_exist', 100, 'INR', 'capture'));
    expect(res.json().status).toBe('ignored');
  });

  it('a capture for the wrong amount is acknowledged, not applied, and shown to the owner', async () => {
    const { bookingId, orderId, amount } = await holdAndOrder();
    const event = mockWebhookBody(orderId, amount - 100, 'INR', 'capture');
    const eventId = `evt_${randomUUID()}`;

    const res = await sendWebhook(event, { eventId });
    // 200 so the provider stops retrying an event that can never succeed.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'rejected' });
    expect(await bookingStatus(T.tenantId, bookingId)).toBe('HELD');
    expect((await paymentOf(T.tenantId, bookingId)).status).toBe('CREATED');

    const paymentId = (await paymentOf(T.tenantId, bookingId)).id;
    const audit = await withTenant(t.db, T.tenantId, (tx) =>
      tx.db
        .selectFrom('audit_logs')
        .select(['action', 'after'])
        .where('entity_id', '=', paymentId)
        .execute(),
    );
    expect(audit).toEqual([
      {
        action: 'payment.amount_mismatch',
        after: { orderId, expectedPaise: amount, capturedPaise: amount - 100 },
      },
    ]);
    // A retry of the same event is a duplicate, not a second audit entry.
    expect((await sendWebhook(event, { eventId })).json()).toEqual({ status: 'duplicate' });
  });
});

describe('late payment after the hold expired', () => {
  async function expire(tenantId: string, bookingId: string) {
    await withTenant(t.db, tenantId, (tx) =>
      tx.db
        .updateTable('bookings')
        .set({ status: 'EXPIRED', hold_expires_at: sql`now() - interval '1 minute'` })
        .where('id', '=', bookingId)
        .execute(),
    );
  }

  it('slot still free → the booking is re-confirmed', async () => {
    const tenant = await createTestTenant(t.db);
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const { bookingId, orderId, amount } = await holdAndOrder(c, tenant);
    await expire(tenant.tenantId, bookingId);
    await sendWebhook(mockWebhookBody(orderId, amount, 'INR', 'capture'));
    expect(await bookingStatus(tenant.tenantId, bookingId)).toBe('CONFIRMED');
    expect((await paymentOf(tenant.tenantId, bookingId)).status).toBe('CAPTURED');
  });

  it('slot taken by someone else → automatic full refund and an email', async () => {
    const tenant = await createTestTenant(t.db);
    const [other] = await addCustomers(t.db, tenant, 1);
    const c1 = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const c2 = await loginAs(t.app, other!.email, tenant.slug);
    const { bookingId, orderId, amount, startAt } = await holdAndOrder(c1, tenant);
    await expire(tenant.tenantId, bookingId);

    // Someone else grabs the freed slot.
    const taken = await c2.post('/bookings/hold', {
      serviceId: tenant.service.id,
      staffId: tenant.staff.membershipId,
      startAt,
    });
    expect(taken.statusCode).toBe(201);

    // Now the first customer's payment arrives.
    const res = await sendWebhook(mockWebhookBody(orderId, amount, 'INR', 'capture'));
    expect(res.statusCode).toBe(200);
    expect(await bookingStatus(tenant.tenantId, bookingId)).toBe('EXPIRED');
    const payment = await paymentOf(tenant.tenantId, bookingId);
    expect(payment).toMatchObject({
      status: 'REFUND_PENDING',
      refund_reason: expect.stringMatching(/someone else booked/),
    });
    expect(t.jobs.refunds).toContainEqual({ tenantId: tenant.tenantId, paymentId: payment.id });
    expect(await notificationsOf(tenant.tenantId, bookingId)).toEqual([
      { type: 'LATE_PAYMENT_REFUNDED', status: 'PENDING' },
    ]);
    // The other customer's hold is untouched.
    expect(await bookingStatus(tenant.tenantId, taken.json().id)).toBe('HELD');
  });

  it('paying for a hold the customer already cancelled → refund', async () => {
    const c = await freshCustomer();
    const { bookingId, orderId, amount } = await holdAndOrder(c, T, 0, 10);
    await c.post(`/bookings/${bookingId}/cancel`);
    await sendWebhook(mockWebhookBody(orderId, amount, 'INR', 'capture'));
    expect((await paymentOf(T.tenantId, bookingId)).status).toBe('REFUND_PENDING');
  });
});

describe('refunds', () => {
  it('refund on cancellation: the job refunds once, and re-running it is a no-op', async () => {
    const tenant = await createTestTenant(t.db);
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const { bookingId, orderId, amount } = await holdAndOrder(c, tenant, 0, 10);
    await sendWebhook(mockWebhookBody(orderId, amount, 'INR', 'capture'));

    const cancel = await c.post(`/bookings/${bookingId}/cancel`);
    expect(cancel.json().payment.status).toBe('REFUND_PENDING');
    const payment = await paymentOf(tenant.tenantId, bookingId);

    expect(await processRefund(t.deps, tenant.tenantId, payment.id)).toBe('refunded');
    const after = await paymentOf(tenant.tenantId, bookingId);
    expect(after.status).toBe('REFUNDED');
    expect(after.provider_refund_id).toMatch(/^rfnd_mock_/);
    expect(await processRefund(t.deps, tenant.tenantId, payment.id)).toBe('skipped');

    // The customer sees it.
    expect((await c.get(`/bookings/${bookingId}`)).json().payment.status).toBe('REFUNDED');
  });

  it('a failed refund call leaves it pending (the job retries later)', async () => {
    const tenant = await createTestTenant(t.db);
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const { bookingId, orderId, amount } = await holdAndOrder(c, tenant, 0, 10);
    await sendWebhook(mockWebhookBody(orderId, amount, 'INR', 'capture'));
    await c.post(`/bookings/${bookingId}/cancel`);
    const payment = await paymentOf(tenant.tenantId, bookingId);

    t.payments.failNextRefund = true;
    await expect(processRefund(t.deps, tenant.tenantId, payment.id)).rejects.toThrow(
      /refund failed/,
    );
    expect((await paymentOf(tenant.tenantId, bookingId)).status).toBe('REFUND_PENDING');
    expect(await processRefund(t.deps, tenant.tenantId, payment.id)).toBe('refunded');
  });

  it('if we crashed after refunding but before saving, the retry does not refund twice', async () => {
    const tenant = await createTestTenant(t.db);
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const { bookingId, orderId, amount } = await holdAndOrder(c, tenant, 0, 10);
    await sendWebhook(mockWebhookBody(orderId, amount, 'INR', 'capture'));
    await c.post(`/bookings/${bookingId}/cancel`);
    const payment = await paymentOf(tenant.tenantId, bookingId);

    // Simulate: the provider already refunded it, but our DB still says REFUND_PENDING.
    t.payments.refunds.set(payment.provider_payment_id!, 'rfnd_mock_existing');
    expect(await processRefund(t.deps, tenant.tenantId, payment.id)).toBe('refunded');
    expect((await paymentOf(tenant.tenantId, bookingId)).provider_refund_id).toBe(
      'rfnd_mock_existing',
    );
  });

  it('refund.processed webhook marks a pending refund as refunded', async () => {
    const tenant = await createTestTenant(t.db);
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const { bookingId, orderId, amount } = await holdAndOrder(c, tenant, 0, 10);
    await sendWebhook(mockWebhookBody(orderId, amount, 'INR', 'capture'));
    await c.post(`/bookings/${bookingId}/cancel`);
    const payment = await paymentOf(tenant.tenantId, bookingId);
    await sendWebhook({
      entity: 'event',
      event: 'refund.processed',
      payload: {
        refund: { entity: { id: 'rfnd_from_webhook', payment_id: payment.provider_payment_id } },
      },
    });
    expect(await paymentOf(tenant.tenantId, bookingId)).toMatchObject({
      status: 'REFUNDED',
      provider_refund_id: 'rfnd_from_webhook',
    });
  });
});

describe('dev mock payment flow (what the frontend uses locally)', () => {
  it('hold → order → simulate capture → confirmed', async () => {
    const tenant = await createTestTenant(t.db);
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const { bookingId, orderId } = await holdAndOrder(c, tenant, 0, 11);
    const res = await c.post(`/dev/mock-payments/${orderId}/capture`);
    expect(res.statusCode).toBe(200);
    expect((await c.get(`/bookings/${bookingId}`)).json().status).toBe('CONFIRMED');
  });

  it("can't simulate payment for another tenant's order", async () => {
    const tenant = await createTestTenant(t.db);
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const { orderId } = await holdAndOrder(c, tenant, 0, 11);
    expect((await customer.post(`/dev/mock-payments/${orderId}/capture`)).statusCode).toBe(404);
  });
});
