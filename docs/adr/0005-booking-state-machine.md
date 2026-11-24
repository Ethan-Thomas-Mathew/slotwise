# 0005. One state machine and compare-and-set updates for bookings

Status: accepted (November 2026)

## Context

A booking can be changed by the customer (cancel, reschedule), the owner, staff
(complete, no-show), the payment webhook (confirm) and background jobs (expire), sometimes
at the same moment.

## Decision

- `transitionBooking(from, to)` in `bookings/state-machine.ts` is the only list of legal
  moves (`HELD → CONFIRMED | EXPIRED | CANCELLED`, `EXPIRED → CONFIRMED`,
  `CONFIRMED → CANCELLED | COMPLETED | NO_SHOW`). All 36 pairs are unit-tested.
- Every change locks the row (`SELECT ... FOR UPDATE`) and writes with
  `UPDATE ... WHERE id = ? AND status = <expected>`. If someone else changed it first,
  nothing is updated and the caller gets a 409.
- Who may cancel or reschedule, and whether a cancellation is refunded, is one pure
  function, `bookingPolicy(booking, tenant, actor, now)`. The API also returns its answer so
  the UI only shows buttons that will work.
- The price is copied onto the booking when it is held, so a later price change never
  affects an existing booking or its refund.

## Consequences

- A cancel racing a payment confirmation can't apply both; one sees the changed status.
- Adding a state means editing one table and its tests.

## Alternatives rejected

- **Status checks scattered through each service function:** they drift apart.
- **A state-machine library:** ten lines of data don't need one.
