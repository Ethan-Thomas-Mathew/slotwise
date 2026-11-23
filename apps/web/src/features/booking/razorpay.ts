import type { CreateOrderResponse } from '@slotwise/shared';

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open(): void };
  }
}

let loading: Promise<void> | null = null;
function loadScript(): Promise<void> {
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error('Could not load the payment window. Check your connection.'));
    };
    document.body.appendChild(s);
  });
  return loading;
}

/**
 * Opens Razorpay Checkout. `onPaid` only means "the customer finished in the
 * popup"; the booking is confirmed by the server-side webhook, not here.
 */
export async function openRazorpayCheckout(order: CreateOrderResponse, onPaid: () => void) {
  await loadScript();
  if (!window.Razorpay) throw new Error('Payment window unavailable');
  new window.Razorpay({
    key: order.keyId,
    order_id: order.orderId,
    amount: order.amountPaise,
    currency: order.currency,
    name: order.businessName,
    prefill: { name: order.customer.name, email: order.customer.email },
    theme: { color: '#0e6b68' },
    handler: onPaid,
  }).open();
}
