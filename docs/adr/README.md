# Architecture Decision Records

One file per significant decision: the situation, what was decided, what it costs,
and what was rejected. Smaller choices are explained in comments next to the code.

| ADR                                               | Decision                                                     |
| ------------------------------------------------- | ------------------------------------------------------------ |
| [0001](0001-monorepo-with-shared-schemas.md)      | One repository; the API and web app share Zod schemas        |
| [0002](0002-kysely-and-sql-migrations.md)         | Kysely and SQL migrations instead of an ORM                  |
| [0003](0003-tenant-isolation-with-rls.md)         | Tenant isolation with row-level security and two roles       |
| [0004](0004-preventing-double-booking.md)         | Exclusion constraint plus advisory locks                     |
| [0005](0005-booking-state-machine.md)             | One state machine and compare-and-set updates                |
| [0006](0006-sessions-csrf-and-rate-limits.md)     | Server-side sessions, CSRF tokens, rate limits               |
| [0007](0007-payments-confirmed-by-webhook.md)     | Only the signed webhook confirms a payment                   |
| [0008](0008-outbox-and-reconciler.md)             | Outbox, after-commit effects and a reconciler                |
| [0009](0009-time-in-utc-and-business-timezone.md) | UTC storage, business timezone at the edges, pure slot logic |
| [0010](0010-local-only.md)                        | Runs locally and offline; no cloud services                  |
| [0011](0011-metrics-and-alerts.md)                | Metrics on an internal port, tested alerts, a runbook        |
| [0012](0012-api-docs-from-validation-schemas.md)  | API docs generated from the validation schemas               |
| [0013](0013-backups-and-reversible-migrations.md) | Backups proven by restoring; migrations tested both ways     |
| [0014](0014-account-erasure-by-anonymisation.md)  | Account erasure anonymises instead of deleting               |
| [0015](0015-timeouts.md)                          | Timeouts on queries, transactions and requests               |
