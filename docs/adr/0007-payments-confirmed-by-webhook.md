# 0007. Only the signed webhook confirms a payment

Status: accepted (November 2026)

## Context

After paying, the browser is redirected back, but browsers close, lose network, or are
faked. Razorpay also sends the same webhook more than once, and payments can arrive after
the 10-minute hold has expired.

## Decision

- The amount always comes from the database; the request only names the booking. A
  partial unique index allows one open order per booking.
- The booking becomes `CONFIRMED` only when the webhook says so. The browser shows
  "Confirming your payment" and polls.
- The webhook route keeps the body as raw text and checks the HMAC-SHA256 signature over
  those exact bytes before reading anything. The body is then parsed with a Zod schema;
  anything malformed is a 400.
- Recording the event id (unique) and applying the event happen in one transaction: a
  duplicate does nothing, and a crash halfway leaves nothing, so the provider's retry
  works.
- A payment after the hold expired is re-confirmed inside a savepoint if the slot is still
  free; otherwise it is refunded automatically and the customer is emailed.
- A capture for a different amount than the order is stored, acknowledged as `rejected`,
  never applied, written to the owner's activity log and alerted on. Throwing instead made
  the provider retry an event that could never succeed.
- Refunds run as a background job that first asks the provider whether the refund already
  exists, so retrying after a crash never refunds twice.
- `PAYMENTS_PROVIDER=mock` (the default) signs fake webhooks and sends them through the
  real webhook route, so the full flow runs without keys or internet.

## Consequences

- Duplicate, late, forged and tampered webhooks are each covered by a test.
- Confirmation depends on webhook delivery; locally that is instant, in production
  seconds.

## Alternatives rejected

- **Confirm on the browser redirect:** trivially forged.
- **Always refund late payments:** loses bookings when the slot is still free.
