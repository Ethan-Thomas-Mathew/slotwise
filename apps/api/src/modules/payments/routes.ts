import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { CreateOrderRequest, CreateOrderResponse } from '@slotwise/shared';
import { z } from 'zod';
import type { AppDeps } from '../../app';
import { notFound } from '../../http/errors';
import { webhooks } from '../../metrics';
import { parse, respond } from '../../http/validation';
import { inTenant, requireRole, tenantContext } from '../../http/auth';
import { createOrderForBooking, handleWebhook } from './service';

export async function paymentRoutes(app: FastifyInstance, deps: AppDeps) {
  app.post('/payments/order', { preHandler: requireRole('CUSTOMER') }, async (req) => {
    const body = parse(CreateOrderRequest, req.body);
    const order = await createOrderForBooking(
      { ...deps, log: req.log },
      tenantContext(req),
      body.bookingId,
    );
    return respond(CreateOrderResponse, order);
  });

  /**
   * Razorpay → us. Registered in its own scope so that ONLY this route keeps
   * the body as a raw string: the signature is computed over the exact bytes
   * Razorpay sent, and re-serialising parsed JSON could change them.
   */
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
      done(null, body),
    );
    scope.post('/webhooks/razorpay', async (req, reply) => {
      const outcome = await handleWebhook(
        { ...deps, log: req.log },
        {
          rawBody: req.body as string,
          signature: req.headers['x-razorpay-signature'] as string | undefined,
          eventId: req.headers['x-razorpay-event-id'] as string | undefined,
        },
      );
      webhooks.inc({ outcome });
      // 200 for duplicates/ignored too, so the provider stops retrying.
      return reply.status(200).send({ status: outcome });
    });
  });

  // Mock provider only (never in production): simulate what Razorpay would do
  // after the customer pays. It builds a webhook exactly like Razorpay's, signs
  // it with the webhook secret and sends it to our real webhook route.
  if (
    deps.payments.name === 'mock' &&
    (deps.config.NODE_ENV !== 'production' || deps.config.ALLOW_MOCK_PAYMENTS === 'true')
  ) {
    app.post(
      '/dev/mock-payments/:orderId/:outcome',
      { preHandler: requireRole('CUSTOMER') },
      async (req, reply) => {
        const { orderId, outcome } = z
          .object({ orderId: z.string().max(100), outcome: z.enum(['capture', 'fail']) })
          .parse(req.params);
        const payment = await inTenant(deps.db, req, (tx) =>
          tx.db
            .selectFrom('payments')
            .selectAll()
            .where('provider_order_id', '=', orderId)
            .executeTakeFirst(),
        );
        if (!payment) throw notFound('Order');
        const body = JSON.stringify(
          mockWebhookBody(orderId, payment.amount_paise, payment.currency, outcome),
        );
        const res = await app.inject({
          method: 'POST',
          url: '/webhooks/razorpay',
          headers: {
            'content-type': 'application/json',
            'x-razorpay-signature': createHmac('sha256', deps.config.RAZORPAY_WEBHOOK_SECRET)
              .update(body)
              .digest('hex'),
            'x-razorpay-event-id': `evt_mock_${randomUUID()}`,
          },
          payload: body,
        });
        return reply.status(res.statusCode).send(res.json());
      },
    );
  }
}

/** The shape of a Razorpay payment.captured / payment.failed webhook (trimmed). */
export function mockWebhookBody(
  orderId: string,
  amountPaise: number,
  currency: string,
  outcome: 'capture' | 'fail',
) {
  return {
    entity: 'event',
    account_id: 'acc_mock',
    event: outcome === 'capture' ? 'payment.captured' : 'payment.failed',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: `pay_mock_${randomUUID().replaceAll('-', '').slice(0, 14)}`,
          entity: 'payment',
          amount: amountPaise,
          currency,
          status: outcome === 'capture' ? 'captured' : 'failed',
          order_id: orderId,
          method: 'upi',
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  };
}
