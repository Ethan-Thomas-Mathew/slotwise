# 0008. Outbox, after-commit effects and a reconciler

Status: accepted (November 2026)

## Context

Booking changes trigger work outside the database: emails, hold expiry, refunds. Queueing
a job inside a transaction that later rolls back acts on something that never happened.
Queueing after commit can fail if Redis is down at that moment.

## Decision

- Emails are rows in `notifications`, written in the same transaction as the booking
  change (an outbox).
- Services collect "queue this job" functions in an `effects` list that runs only after
  commit. If one fails, it is logged as a warning and the request still succeeds, because
  the change is committed and recorded.
- A separate worker process (BullMQ on Redis) runs the jobs. Job ids are deterministic
  (`notification-<id>`, `refund-<paymentId>`), so the same work is never queued twice.
- Every job re-reads its row and checks it still applies (the reminder is still due, the
  booking still confirmed) before acting.
- A reconciler runs every minute: it expires stale holds and re-queues due notifications
  and pending refunds that have no job.

## Consequences

- Redis can be lost without losing an email or a refund; the reconciler catches up
  within a minute.
- Email is at-least-once: a crash between the SMTP server accepting a message and the
  commit sends it again on retry. A rare duplicate is preferred to a lost confirmation.

## Alternatives rejected

- **Queue inside the transaction:** acts on rolled-back changes.
- **Send email in the request:** slow, and a mail server outage fails bookings.
- **Trust the queue alone:** one Redis hiccup loses work silently.
