import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Client } from './app';
import type { TestTenant } from './factory';
import { dateIn, slotsFor } from './booking';
import { mockWebhookBody } from '../../src/modules/payments/routes';

export const WEBHOOK_SECRET = 'test_webhook_secret';

export async function sendWebhook(
  app: FastifyInstance,
  body: object,
  eventId = `evt_${randomUUID()}`,
) {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/webhooks/razorpay',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'),
      'x-razorpay-event-id': eventId,
    },
    payload: raw,
  });
}

/** Full happy path through the real endpoints: hold → order → signed webhook. */
export async function bookAndPay(
  app: FastifyInstance,
  c: Client,
  tenant: TestTenant,
  opts: { days?: number; slot?: number } = {},
) {
  const slots = await slotsFor(app, tenant, dateIn(opts.days ?? 5));
  const startAt = slots[opts.slot ?? 0]!;
  const hold = await c.post('/bookings/hold', {
    serviceId: tenant.service.id,
    staffId: tenant.staff.membershipId,
    startAt,
  });
  if (hold.statusCode !== 201) throw new Error(`hold failed: ${hold.body}`);
  const order = (await c.post('/payments/order', { bookingId: hold.json().id })).json();
  await sendWebhook(app, mockWebhookBody(order.orderId, order.amountPaise, 'INR', 'capture'));
  return { bookingId: hold.json().id as string, startAt };
}
