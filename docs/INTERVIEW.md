# Interview prep

Questions you're likely to get about Slotwise, with short answers in plain words and where the proof is. **Don't memorise these.** Read the code each answer points to until you could explain it without this page.

---

## The basics

**"Tell me about this project." (aim for 60–90 seconds)**

> Slotwise is a booking platform many small businesses share: salons, clinics. Each business gets a booking page; customers pick a service, a person and a time, and pay with Razorpay. Three things make it hard. Businesses must never see each other's data, so I enforced isolation in both the code and the database. A slot must never be sold twice, so the database decides with an exclusion constraint, and a concurrency test proves it. And payments must be trustworthy even when webhooks arrive twice, late, or forged. It has about 300 automated tests, CI, Docker, and a written log of every design decision.

**"Did you use AI to build this?"**
Be honest. A good answer:

> Yes. I used Claude for AI-assisted development, the same way I list it on my CV. I wrote the plan and the requirements. I've gone through every part, and I can explain and change any of it. For example… _(then walk through one piece, like the hold flow, without notes)._

Interviewers mostly care whether you **understand and own** the code. Prove it by being able to change it live (see `EXERCISES.md`).

**"Why these technologies?"** → `README.md` (tech stack table) and `docs/DECISIONS.md`. Know D3 (Kysely, not Prisma) and D10 (own sessions) best, because they're unusual choices.

---

## Tenant isolation

**"How do you stop one business seeing another's data?"**

> Two layers. In code, every data-access function takes a `TenantTx`, which you can only get from `withTenant()`, so forgetting the tenant is a compile error. In the database, Row-Level Security adds `tenant_id = current tenant` to every query on tenant tables, so even a query I wrote wrong can't leak.

- Code: `apps/api/src/db/tenant-tx.ts`, `apps/api/src/db/migrations/0002_row_level_security.ts`
- Tests: `apps/api/tests/integration/tenant-isolation.db.test.ts`

**"How does Postgres know which tenant it is?"**

> At the start of each transaction we run `set_config('app.tenant_id', <id>, true)`. The `true` makes it last only for that transaction, so a pooled connection can't carry it into the next request. The policy reads it with `current_setting`.

**"Why does the API use a different database user from the migrations?"**

> The owner of a table skips RLS. The app connects as a role that owns nothing, so RLS always applies. A test checks this.

**"Why `nullif(current_setting(...), '')`?"**

> After a transaction ends, the setting becomes an empty string on that connection, and `''::uuid` throws. With `nullif` it becomes NULL, which matches no rows. So if the tenant isn't set, you see nothing: it fails closed.

**"Why 404 and not 403 for another tenant's ID?"**

> 403 would confirm the ID exists somewhere. 404 reveals nothing.

---

## Double booking and concurrency

**"How do you prevent two people booking the same slot?"**

> An exclusion constraint on the bookings table: no two HELD or CONFIRMED rows for the same staff member can have overlapping time ranges. Postgres checks it during the INSERT, so even two requests in the same millisecond can't both succeed. The loser gets error `23P01`, which we turn into a 409.

- Code: `apps/api/src/db/migrations/0001_init.ts` (search for `no_overlapping_bookings`)

**"Why not just check if the slot is free, then insert?"**

> Because two requests can both check, both see "free", and both insert. That's a race condition. The check is still there for a nice error message, but the constraint is the real guarantee.

**"How do you know it works?"** _(this is your best story)_

> A test fires 20 requests for the same slot at the same moment, 10 times in a row, and expects exactly one 201 and nineteen 409s. The first version failed about 1 run in 4. Postgres was reporting deadlocks, because with exclusion constraints two inserts can each wait for the other's uncommitted row. Nobody was double-booked, but customers got errors after up to 20 seconds. I fixed it with a per-staff advisory lock so writers take turns. The test also proves ~120 of the 190 losers were stopped by the constraint itself.

- `docs/DECISIONS.md` D19, `apps/api/tests/integration/bookings.test.ts` (CONCURRENCY)

**"Doesn't that lock slow everything down?"**

> I measured it: only 5–8% slower than spreading writes over 10 staff (`docs/PERFORMANCE.md`). The bottleneck was CPU, not the lock.

**"How does 'Anyone available' stay safe?"**

> We try each free person in order, least busy first, each attempt inside a savepoint. If the constraint rejects one, we roll back just that attempt and try the next. A test with 12 simultaneous requests and 2 free staff always gives exactly 2 bookings, one per person. (D42)

**"What happens if someone holds a slot and never pays?"**

> Holds last 10 minutes. A background job expires them. If that job is late, the next person's hold clears it on the way in, and the slot list already ignores expired holds. A customer can hold at most 3 unpaid slots. (D21)

---

## Payments

**"When is a booking confirmed?"**

> Only when Razorpay's webhook says the payment was captured, never when the browser says so. The browser can be closed or faked. After paying, the page shows "Confirming…" and polls. (D24)

**"How do you know the webhook is really from Razorpay?"**

> It's signed with HMAC-SHA256 using a secret only we and Razorpay know. We check the signature on the **raw** body before parsing it. Re-serialising JSON could change the bytes and break the check.

- `apps/api/src/modules/payments/routes.ts`, `service.ts` (`handleWebhook`)

**"What if Razorpay sends the same webhook twice?"**

> Each event has an id. We insert it into a table with a UNIQUE constraint, in the **same transaction** as the booking change. A duplicate insert does nothing and we stop. If we crash halfway, nothing is committed and Razorpay's retry works normally. Tested with 5 identical webhooks at once.

**"What if the payment arrives after the hold expired?"**

> We try to re-confirm inside a savepoint. If someone else has taken the slot, the constraint refuses, we roll back just that step and refund automatically. (D25)

**"Can a customer change the price?"**

> No. The order amount comes from the database (the price copied onto the booking), never from the browser. (D26)

---

## Auth and security

**"How do logins work?"** → `docs/LEARNING.md` Phase 2 has the 5-step walkthrough. Key words: Argon2id, httpOnly cookie, only a hash of the token is stored, sessions can be revoked.

**"How do you protect against CSRF?"**

> SameSite=Lax cookies, an Origin check on every write, and a per-session CSRF token the frontend sends in a header.

**"What about brute-force logins?"**

> 5 attempts per 15 minutes per IP + email, counted in Redis so it works across servers. And the same error for "no such email" and "wrong password".

**"Walk me through OWASP Top 10."** → `docs/SECURITY.md` maps each one to code and tests. Know A01 (access control), A05 (injection: parameterised queries) and A08 (webhook integrity) best.

---

## Background jobs

**"Why a separate worker?"**

> Sending emails and calling Razorpay can be slow or fail. That shouldn't slow down or break web requests, and the worker can retry with backoff.

**"What if Redis goes down?"**

> The intent is saved in Postgres first, as notification rows and REFUND_PENDING payments in the same transaction as the booking change. That's the outbox pattern. A reconciler job runs every minute and re-queues anything overdue. (D22, D31)

**"Can a reminder be sent for a cancelled booking?"**

> No. The worker re-reads the row before sending. If it's not PENDING, not due, or the booking isn't confirmed any more, it skips it. That's also what makes duplicate jobs harmless. (D30)

---

## Testing and engineering

**"How did you test it?"**

> Three levels. Unit tests for pure logic: the slot generator, the state machine, the cancellation policy. Integration tests that send real HTTP requests into the app against a real Postgres and Redis. Browser tests with Playwright for the critical paths, plus automated accessibility checks. About 90% line coverage, and CI fails below 85%.

**"What's a pure function and why did you use one for slots?"**

> Same input, same output, no database or clock. That makes it trivial to test every edge case: daylight saving, day boundaries, partial time off. It has 31 tests.

**"What would you do differently / next?"** Pick 2–3 from README → "What I'd build next", and be honest about the limitations listed there.

**"What was the hardest bug?"** The deadlock (above). Know it cold.

## Running it in production

**"How would you know if it broke at 2 a.m.?"**
Prometheus scrapes metrics from the API and the worker; alert rules fire on the API or worker being down, more than 5% server errors, slow requests, failing jobs, a growing queue and bursts of fake webhooks. Each alert links to a runbook section. The rules have unit tests (`ops/prometheus/alerts.test.yml`). → `apps/api/src/lib/metrics.ts`, `ops/prometheus/`, `docs/RUNBOOK.md`

**"Why not label metrics by URL?"**
Cardinality: every distinct label value is a new time series held in memory, and URLs contain ids, so a scanner requesting random URLs could exhaust memory. We label by route template and put unknown URLs under `unmatched`; a test checks ids never appear in the metrics.

**"How do you keep API docs accurate?"**
They're generated from the Zod schemas that validate requests. A test fails if a route is missing from the docs or the committed `docs/openapi.json` is stale. → `apps/api/src/openapi/spec.ts`, `tests/integration/openapi.test.ts`

**"How do you know your backups work?"**
`pnpm db:restore-drill` restores the newest backup into a scratch database and compares tables, migrations and RLS policies with the live one; a test runs backup and restore for real, and also checks a corrupted file is caught by its checksum. → `apps/api/scripts/ops/`

**"A user asks you to delete their data. What happens?"**
Customers can do it themselves. We anonymise rather than delete, because the business must keep booking and payment records: name, email and password are replaced, sessions and tokens deleted, their email is scrubbed from the audit log, all in one transaction. It's refused for owners, staff and anyone with upcoming bookings (refunds first). → `apps/api/src/modules/privacy/service.ts`, DECISIONS D49
