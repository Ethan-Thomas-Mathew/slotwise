# 0004. Preventing double booking: exclusion constraint plus advisory locks

Status: accepted (November 2026)

## Context

Two customers can press "Book" for the same staff member and time within the same
millisecond. "Check the slot is free, then insert" has a gap between the check and the
insert, and both requests pass the check.

## Decision

- **The guarantee:** an exclusion constraint on `bookings`:
  no two `HELD` or `CONFIRMED` rows for the same staff member may have overlapping
  `tstzrange(start_at, end_at, '[)')`. The database rejects the second insert with
  `23P01`, which the API turns into `409 SLOT_TAKEN`.
- **No deadlocks:** before inserting or moving a booking, the transaction takes
  `pg_advisory_xact_lock` on that staff member's calendar. Concurrent inserts under an
  exclusion constraint can otherwise deadlock (each waits for the other's uncommitted
  row); the first version did, and losers got 500s after up to 20 seconds.
- **"Anyone available":** candidates are tried one at a time, each attempt inside a
  savepoint. A rejected attempt rolls back to the savepoint, which also releases that
  person's lock, so a request never holds one lock while waiting for another.
- **Per-customer limit:** a customer may hold 3 unpaid slots. A per-customer advisory lock,
  taken before the calendar lock, makes the count and the insert atomic. Without it, six
  simultaneous holds on different staff all saw the old count (found by a test).
- **Stale holds:** timed-out holds overlapping a new request are expired in the same
  transaction, so a late expiry job can never block a slot.

## Consequences

- 20 parallel requests for one slot: exactly one 201 and nineteen 409s, in every run.
- Writes for one staff member are serialised. Each takes milliseconds; measured cost
  against spreading writes over 10 staff is under 10% (see the README benchmark).

## Alternatives rejected

- **Check-then-insert in the application:** races.
- **`SERIALIZABLE` isolation:** correct, but every write path needs retry logic.
- **Retrying on deadlock:** still slow and noisy.
- **Locking every candidate up front for "anyone available":** more waiting, and two
  requests locking in different orders could deadlock.
