import { randomUUID } from 'node:crypto';
import Razorpay from 'razorpay';
import { validateWebhookSignature } from 'razorpay/dist/utils/razorpay-utils.js';
import type { Config } from '../../config';

/**
 * What the app needs from a payment provider. Code depends on this interface,
 * so tests and local development can use the mock without real keys.
 */
export interface PaymentProvider {
  readonly name: 'mock' | 'razorpay';
  /** Public key for Razorpay Checkout in the browser (null for mock). */
  readonly publicKeyId: string | null;
  createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<{ orderId: string }>;
  refund(input: {
    paymentId: string;
    amountPaise: number;
    notes: Record<string, string>;
  }): Promise<{ refundId: string }>;
  /** An existing refund for this payment, if any (makes refund retries safe). */
  findRefund(paymentId: string): Promise<{ refundId: string } | null>;
  /** HMAC-SHA256 check of the raw webhook body, done by Razorpay's own SDK helper. */
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
}

function verify(rawBody: string, signature: string, secret: string): boolean {
  try {
    return validateWebhookSignature(rawBody, signature, secret);
  } catch {
    return false;
  }
}

export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;
  private readonly client: Razorpay;

  constructor(
    readonly publicKeyId: string,
    keySecret: string,
    private readonly webhookSecret: string,
  ) {
    this.client = new Razorpay({ key_id: publicKeyId, key_secret: keySecret });
  }

  async createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }) {
    const order = await this.client.orders.create({
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes,
    });
    return { orderId: order.id };
  }

  async refund(input: { paymentId: string; amountPaise: number; notes: Record<string, string> }) {
    const r = await this.client.payments.refund(input.paymentId, {
      amount: input.amountPaise,
      notes: input.notes,
    });
    return { refundId: r.id };
  }

  async findRefund(paymentId: string) {
    const list = await this.client.payments.fetchMultipleRefund(paymentId);
    const first = list.items[0];
    return first ? { refundId: first.id } : null;
  }

  verifyWebhookSignature(rawBody: string, signature: string) {
    return verify(rawBody, signature, this.webhookSecret);
  }
}

/**
 * Local/test stand-in for Razorpay. Orders and refunds are just remembered in
 * memory. Webhooks are simulated by the dev-only route in dev-routes.ts, which
 * signs them with the same webhook secret, so the REAL webhook code runs.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock' as const;
  readonly publicKeyId = null;
  readonly orders = new Map<string, { amountPaise: number; currency: string }>();
  readonly refunds = new Map<string, string>(); // paymentId -> refundId
  /** Tests can set this to make the next refund call fail. */
  failNextRefund = false;

  constructor(private readonly webhookSecret: string) {}

  async createOrder(input: { amountPaise: number; currency: string }) {
    const orderId = `order_mock_${randomUUID().replaceAll('-', '').slice(0, 14)}`;
    this.orders.set(orderId, { amountPaise: input.amountPaise, currency: input.currency });
    return { orderId };
  }

  async refund(input: { paymentId: string }) {
    if (this.failNextRefund) {
      this.failNextRefund = false;
      throw new Error('Mock provider: refund failed');
    }
    if (this.refunds.has(input.paymentId))
      throw new Error('Mock provider: payment already refunded');
    const refundId = `rfnd_mock_${randomUUID().replaceAll('-', '').slice(0, 14)}`;
    this.refunds.set(input.paymentId, refundId);
    return { refundId };
  }

  async findRefund(paymentId: string) {
    const refundId = this.refunds.get(paymentId);
    return refundId ? { refundId } : null;
  }

  verifyWebhookSignature(rawBody: string, signature: string) {
    return verify(rawBody, signature, this.webhookSecret);
  }
}

export function createPaymentProvider(config: Config): PaymentProvider {
  if (config.PAYMENTS_PROVIDER === 'razorpay') {
    return new RazorpayProvider(
      config.RAZORPAY_KEY_ID!,
      config.RAZORPAY_KEY_SECRET!,
      config.RAZORPAY_WEBHOOK_SECRET,
    );
  }
  return new MockPaymentProvider(config.RAZORPAY_WEBHOOK_SECRET);
}
