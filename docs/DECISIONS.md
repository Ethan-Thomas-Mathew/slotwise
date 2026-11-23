# Design decisions

Each entry: **Decision → Alternatives considered → Why this one → Trade-off**.

---

## D1. pnpm workspaces monorepo

- **Decision:** One repository with `apps/api`, `apps/web` and `packages/shared`, managed by pnpm workspaces.
- **Alternatives:** Separate repos for frontend and backend; Turborepo/Nx on top of workspaces.
- **Why:** The frontend and backend share Zod schemas. In one repo a schema change and every place it's used change in the same commit. pnpm is fast and strict about dependencies (a package can only import what it declares).
- **Trade-off:** One CI pipeline builds everything. At this size that's fine; a build tool like Turborepo only pays off with many more packages.

## D2. Shared package is consumed as TypeScript source

- **Decision:** `@slotwise/shared` points `main` straight at `src/index.ts`. Vite (web) and tsx/tsup (api) compile it as part of their own build.
- **Alternatives:** Build the shared package to `dist/` first.
- **Why:** No extra build step, no stale `dist/` folder, instant changes in dev.
- **Trade-off:** Every consumer must be able to compile TypeScript. Both of ours can.

## D3. Kysely + plain SQL migrations instead of Prisma

- **Decision:** Use Kysely (a type-safe SQL query builder) with `pg`, and write migrations as SQL inside Kysely's migrator.
- **Alternatives:** Prisma (the original plan), Drizzle, raw `pg` with no query builder.
- **Why:** The project's hardest parts are pure PostgreSQL: Row-Level Security policies, an exclusion constraint, `set_config()` per transaction, catching error code `23P01`, and savepoints. Prisma can't express most of these and would need raw SQL anyway. Kysely keeps the SQL visible and still type-checks column names and result types. (Also, practically: Prisma downloads native engine binaries during install, which the original build environment could not reach.)
- **Trade-off:** No auto-generated migrations from a schema file. We write the `CREATE TABLE` SQL ourselves and keep the TypeScript table types (`src/db/schema.ts`) in sync by hand. A test checks the two match.

## D4. Two database roles instead of FORCE ROW LEVEL SECURITY

- **Decision:** Migrations run as `slotwise_owner` (owns every table). The API connects as `slotwise_app`, which owns nothing and has no `BYPASSRLS`.
- **Alternatives:** One role plus `FORCE ROW LEVEL SECURITY` on every table.
- **Why:** Postgres skips RLS for a table's owner. A separate non-owner role makes RLS apply without exceptions. It also lets the few cross-tenant jobs use narrow `SECURITY DEFINER` functions owned by the owner role (FORCE would block those too). A test asserts the app role owns no tables and can't bypass RLS.
- **Trade-off:** Two connection strings to manage (`DATABASE_URL`, `MIGRATION_DATABASE_URL`), and production needs both roles created once.

## D5. `nullif(current_setting('app.tenant_id', true), '')::uuid` in policies

- **Decision:** Policies call `app_current_tenant()`, which wraps the setting in `nullif(..., '')`.
- **Alternatives:** `current_setting('app.tenant_id')::uuid` (as in the original plan).
- **Why:** With `missing_ok = false` an unset value throws. And once a pooled connection has used `set_config(..., true)`, the value becomes an empty string, and `''::uuid` throws. With `nullif`, "no tenant" becomes NULL, and `tenant_id = NULL` matches nothing, so it fails closed. A test reuses a single pooled connection to prove this.
- **Trade-off:** None worth noting; it's strictly safer.

## D6. Narrow SECURITY DEFINER functions for cross-tenant needs

- **Decision:** Webhooks and background safety-net jobs that must look across tenants call one-purpose functions (`app_tenant_for_payment_order`, `app_expire_stale_holds`, `app_due_notifications`, `app_pending_refunds`).
- **Alternatives:** A "system mode" flag that disables RLS for the app; a third superuser-like connection.
- **Why:** Each function can only do one thing, so a bug elsewhere can't turn into "read everything". They pin `search_path` so nobody can trick them by creating a same-named object in another schema.
- **Trade-off:** Adding a new cross-tenant operation needs a migration.

## D7. Composite foreign keys `(id, tenant_id)`

- **Decision:** Tables reference memberships/services/bookings with `(id, tenant_id)` instead of just `id`.
- **Alternatives:** Plain `id` foreign keys plus app-level checks.
- **Why:** The database itself guarantees a booking can only point at a service and staff member **from the same tenant**. A test tries to link tenant A's service to tenant B's staff and is rejected.
- **Trade-off:** Slightly more verbose schema; every tenant table carries `tenant_id` (it needs it for RLS anyway).

## D8. Working hours stored as minutes after midnight

- **Decision:** `availability_rules.start_minute` / `end_minute` (e.g. 540 = 09:00) in the tenant's local time, with CHECK constraints.
- **Alternatives:** Postgres `time` columns; `"09:00"` strings.
- **Why:** Integers are trivial to compare and do maths on in the slot generator, and the CHECK `end_minute > start_minute` is easy to read.
- **Trade-off:** Must convert to/from `"HH:MM"` at the API boundary (done in the shared Zod schemas).

## D9. Booking price is copied onto the booking

- **Decision:** `bookings.price_paise` is set from the service at hold time; the payment amount comes from the booking.
- **Alternatives:** Always read the price from `services`.
- **Why:** If the owner changes a price, existing bookings and refunds must still use the price the customer agreed to.
- **Trade-off:** Duplicated data, but it's intentional history, not a cache.

## D10. Database-backed sessions + Argon2id, not Better Auth

- **Decision:** Opaque session tokens in an httpOnly cookie, stored as SHA-256 hashes in a `sessions` table. Passwords hashed with Argon2id via the maintained `@node-rs/argon2` library.
- **Alternatives:** Better Auth (named in the plan), JWTs in cookies, Passport.
- **Why:** Signup has to create a tenant, a user and a membership in **one** transaction under RLS, and staff invites have custom rules. Doing that inside a third-party auth framework's hooks is awkward and hard to explain. The session code here is ~100 lines that you can explain line by line. No cryptography is hand-written: random tokens come from the OS (`crypto.randomBytes`), hashing comes from vetted libraries. Server-side sessions (unlike JWTs) can be revoked instantly, e.g. "log out everywhere" after a password reset. (Better Auth also defaults to scrypt, not argon2.)
- **Trade-off:** We own the session code: expiry, cleanup and future features like OAuth login would be ours to build.

## D11. CSRF: per-session token + Origin check + SameSite=Lax

- **Decision:** Every session has its own random CSRF token. The frontend gets it from `/auth/me` and sends it as `x-csrf-token` on every write, and the server compares in constant time. All writes also reject a foreign `Origin` header. Cookies are `SameSite=Lax`.
- **Alternatives:** SameSite alone; double-submit cookie.
- **Why:** Defence in depth. SameSite blocks most cross-site requests; the Origin check covers login/signup (before a session exists); the token covers anything else.
- **Trade-off:** The frontend must remember to send the header (done once, in the API client).

## D12. Rate limiting keyed by IP + email, stored in Redis, at preHandler

- **Decision:** Login, signup, register, forgot/reset password and accept-invite allow 5 attempts per 15 minutes per (route, IP, email).
- **Why:** Stops password guessing against one account without locking out a whole office that shares an IP. Redis means the limit holds across several API servers. It runs at `preHandler` so the parsed body (email) is available.
- **Trade-off:** An attacker rotating IPs against one email isn't stopped by this alone; a production system would add a per-email limit and alerting.

## D13. Auth endpoints don't reveal which emails exist

- **Decision:** Login returns the same error for unknown email and wrong password (and burns the same hashing time). Forgot-password always returns 200.
- **Why:** Otherwise attackers can build lists of registered users.
- **Trade-off:** Slightly less helpful messages for real users.

## D14. Invites: validate before consuming the token

- **Decision:** Accept-invite checks the password first and only then marks the token as used (`UPDATE … WHERE used_at IS NULL RETURNING`, which is atomic).
- **Why:** A typo in the password shouldn't destroy the invite, and two simultaneous accepts can't both succeed.

## D15. Slot generation is a pure function on a fixed grid

- **Decision:** `generateSlots()` takes plain data (rules, time off, busy ranges, now, timezone) and returns slots. Slot start times follow a grid that starts at each working window's start and moves in steps of the service duration (configurable).
- **Alternatives:** Generate slots in SQL; start new slots right after each booking ends.
- **Why:** A pure function needs no database or clock to test, so 30+ edge cases (DST, day boundaries, partial time off) run in milliseconds. A fixed grid gives customers tidy times (10:00, 10:30) instead of odd ones (10:17).
- **Trade-off:** A fixed grid can leave small gaps unused (e.g. a 20-minute gap after an odd-length booking). Owners can lower the step later if that matters.

## D16. Times stored in UTC; the tenant's timezone is used only at the edges

- **Decision:** Every instant is `timestamptz` (UTC). Working hours are local wall-clock minutes. The slot generator converts with Luxon using the tenant's IANA timezone, and the API returns ISO strings with `Z`.
- **Why:** UTC instants never become ambiguous; wall-clock hours are what owners actually think in. Stepping through slots in absolute milliseconds means DST changes can't create impossible or duplicate slots (tested for New York spring-forward and fall-back).
- **Trade-off:** The frontend must format times in the **business's** timezone, not the viewer's.

## D17. Unknown, malformed and other-tenant ids all return 404

- **Decision:** A route id that isn't a UUID, doesn't exist, or belongs to another tenant gets the same 404.
- **Why:** Returning 403 for "exists but not yours" would confirm the id exists in some other tenant. Validating UUIDs before querying also avoids a Postgres cast error (a 500).

## D18. Services with bookings can't be deleted, only deactivated

- **Why:** Old bookings and payments reference the service. Deleting it would break history and reports. Deactivating hides it from the booking page.
- **Same idea for staff:** removing a staff member downgrades them to customer and removes their hours, so their past bookings still point at a real membership. Removal is refused while they have upcoming bookings.

## D19. Per-staff advisory lock in front of the exclusion constraint

- **Decision:** Before inserting or moving a booking, the transaction takes `pg_advisory_xact_lock(hash('staff-calendar:' + staffId))`.
- **What we found:** The first version relied on the exclusion constraint alone. The 20-parallel-requests test then failed about 1 run in 4. With exclusion constraints, two transactions inserting overlapping rows at the same moment can each wait on the other's uncommitted row. Postgres then reports **`deadlock detected`** after `deadlock_timeout` (1 s), one victim at a time. There was never a double booking, but losers got 500 errors after up to 20 seconds.
- **Alternatives:** Retry on deadlock (still slow and noisy); `SERIALIZABLE` isolation (needs retries everywhere); `SELECT … FOR UPDATE` on a staff row (similar effect, but needs a row to lock).
- **Why:** The lock makes writers for the **same** staff member take turns, so there's no deadlock: the first wins, the rest get an instant, clean `23P01` → 409. Writers for different staff never wait for each other. The exclusion constraint is still the real guarantee; the lock just avoids the deadlock. The test also asserts that some losers were stopped by the constraint itself (≈ 120 of 190), proving the race really happens.
- **Trade-off:** Booking writes for one staff member are serialized. Each takes milliseconds, so this only matters at a scale far beyond small businesses.

## D20. Booking changes go through one state machine and "compare-and-set" updates

- **Decision:** `transitionBooking(from, to)` holds the only list of legal moves (unit-tested for all 36 pairs). Updates are written as `UPDATE … WHERE id = ? AND status = <expected>`, and the row is locked with `SELECT … FOR UPDATE` first.
- **Why:** Two concurrent actions (a customer cancelling while the payment webhook confirms) can't both apply; the second sees the row changed and gets a 409.

## D21. Hold limits and stale-hold sweeping

- **Decision:** A customer can hold at most 3 unpaid slots at once. Before inserting a hold, any timed-out holds overlapping the slot are marked EXPIRED in the same transaction. Slot listing already ignores timed-out holds.
- **Why:** Stops one person from blocking a whole day, and means a late or lost expiry job can never keep a slot blocked.

## D22. Side effects run after commit (with an outbox safety net)

- **Decision:** Services push "enqueue job X" closures into an `effects` list, which runs only after the transaction commits. Emails are rows in `notifications` (an outbox) written in the same transaction as the booking change.
- **Why:** Queueing inside a transaction that later rolls back would act on changes that never happened. If enqueueing fails after commit, the data is still in the database and the reconciler job (Phase 6) picks it up.
- **Trade-off:** Slight delay possible before the safety net notices (about a minute).

## D23. Cancellation policy

- **Decision:** Customers may cancel their own upcoming booking at any time. They get a **full refund** if they cancel at least `cancellation_window_hours` before the start (the boundary counts as on time), otherwise no refund. They may reschedule only inside that same free window. Owners can always cancel or reschedule, and owner cancellations are always refunded. Staff can't cancel or reschedule.
- **Why:** Matches how salons and clinics usually work, and keeps the rule in one pure, unit-tested function (`bookingPolicy`) that the API also uses to tell the UI whether to show the buttons.

## D24. The webhook (not the browser redirect) confirms bookings

- **Decision:** After paying, the browser only shows "Processing…" and polls the booking. The booking becomes CONFIRMED only when Razorpay's signed webhook says the payment was captured.
- **Why:** The browser can be closed, lose network, or be faked by a user. The provider's server-to-server message, verified with HMAC, is the only trustworthy source.
- **How the webhook is made safe:**
  1. **Signature on the raw body:** the webhook route keeps the body as a raw string (its own Fastify scope), and Razorpay's SDK helper checks `HMAC-SHA256(rawBody, webhookSecret)`. A tampered body or wrong secret → 400 and nothing stored.
  2. **Idempotency:** `webhook_events.event_id` is UNIQUE. Recording the event and applying it happen in **one** transaction. A duplicate → 200 and nothing happens; a crash midway → nothing committed, so Razorpay's retry processes it cleanly. Tested with 5 identical webhooks fired at once.
  3. **State-level idempotency too:** a _different_ event for the same payment (e.g. `order.paid` after `payment.captured`) finds the payment already CAPTURED and does nothing.
  4. **Amount check:** a captured amount that differs from our order rolls back and logs an error.

## D25. Payment arriving after the hold expired: re-confirm if free, else refund

- **Decision:** If the booking is EXPIRED when the money arrives, we try `EXPIRED → CONFIRMED` inside a **savepoint**. If the exclusion constraint says someone else now has the slot, we roll back just that step, mark the payment REFUND_PENDING, queue a refund and email the customer. If the appointment time already passed, we refund straight away.
- **Alternatives:** Always refund (simpler, but loses a sale when the slot is still free); always confirm (impossible: could double-book).
- **Why:** Best outcome for both the customer and the business, and the database still guarantees no double booking.

## D26. One open order per booking; amount always from the database

- **Decision:** A partial unique index allows only one CREATED/FAILED payment per booking. Clicking "Pay" again (or retrying after a failed attempt) reuses the same order. The amount sent to Razorpay is `bookings.price_paise`; the request body only contains `bookingId`.
- **Why:** Prevents a customer from accidentally (or deliberately) paying twice, and prevents price tampering from the browser.
- **Also:** no database transaction is held open while calling Razorpay's API (check → call → record, each step short).

## D27. Refunds are a background job that is safe to repeat

- **Decision:** Deciding to refund marks the payment `REFUND_PENDING` (in the same transaction as the cancellation) and queues a job. The job first asks Razorpay whether a refund already exists, and only refunds if not. Then it marks `REFUNDED`.
- **Why:** If the API call fails, the job retries with backoff and the reconciler re-queues anything stuck. If we crashed after Razorpay refunded but before we saved it, the retry finds the existing refund instead of refunding twice.
- **Trade-off:** The refund job holds a row lock while calling Razorpay (a second or two); acceptable for a rare operation.

## D28. A mock provider that runs the real webhook code

- **Decision:** With `PAYMENTS_PROVIDER=mock`, orders are fake and a dev-only route (`/dev/mock-payments/:orderId/capture`, disabled in production) builds a Razorpay-shaped webhook, signs it with the webhook secret and sends it to the **real** webhook endpoint.
- **Why:** Anyone can run the full flow locally and in E2E tests without Razorpay keys, and the code path being tested is the production one.

## D29. Separate worker process, BullMQ queues per job type

- **Decision:** `src/worker.ts` runs BullMQ workers for five queues: `emails`, `holds`, `notifications`, `refunds`, `maintenance`. Job ids are deterministic (`hold-<bookingId>`, `notification-<id>`, `refund-<paymentId>`).
- **Why:** Slow or failing work (SMTP, Razorpay) never slows down HTTP requests, and the API and workers scale separately. Deterministic ids mean the same work is never queued twice, and a rescheduled reminder can find and replace its old job.
- **Retries:** 6 attempts, exponential backoff starting at 5 s. A notification that fails every attempt becomes `FAILED` in the database, so owners see it on the dashboard and can retry it with one click.
- **Gotcha we handle:** BullMQ ignores `add()` for an id that still exists, and failed jobs are kept for a week. So `enqueueRefund` revives a failed job with `retry()` instead of silently doing nothing (tested).

## D30. Workers re-check the database before acting

- **Decision:** Every job reads the current row (with `FOR UPDATE`) and decides whether it still applies. Examples: the reminder is still PENDING and due; the booking is still CONFIRMED; the hold is still HELD and past its expiry; the payment is still REFUND_PENDING.
- **Why:** Jobs can be stale (the booking was rescheduled), duplicated (at-least-once delivery) or early. Treating the database as the truth makes every job idempotent, which is what makes retries and the reconciler safe.

## D31. A reconciler instead of trusting the queue

- **Decision:** A repeatable `reconcile` job runs every minute. It expires stale holds, re-queues due notifications that never got a job, and re-queues refunds stuck in REFUND_PENDING.
- **Why:** Jobs are queued after commit. If Redis is down at that moment, the work is still recorded in Postgres (outbox), and the reconciler catches up within a minute. Redis can be lost without losing emails or refunds.

## D32. Email delivery is at-least-once

- **Decision:** The worker sends the email, then marks the row SENT in the same transaction.
- **Trade-off:** If the process dies after the SMTP server accepted the email but before the commit, the retry sends it again. A rare duplicate email is better than a lost confirmation. (Exactly-once email would need provider-side idempotency keys.)

## D33. Frontend: server state in TanStack Query, selection state in the URL

- **Decision:** Everything that comes from the API is fetched and cached with TanStack Query (no global store). The booking page keeps the customer's choice (service, person, date, time) in the URL query string.
- **Why:** Query handles loading/error states, retries and refetching, so components stay small. Putting the selection in the URL means it survives the "log in to book" detour and the page can be shared or refreshed without losing the choice.
- **Trade-off:** More query keys to invalidate after changes (handled in one helper, `useInvalidateBookings`).

## D34. The browser never decides a booking is paid

- **Decision:** After payment the checkout page shows "Confirming your payment" and polls the booking every 1.5 s until the webhook has confirmed it, giving up politely after a minute.
- **Why:** Matches the backend rule (D24): the payment provider's webhook is the source of truth.

## D35. All times shown in the business's timezone

- **Decision:** The frontend formats every time with the tenant's timezone (`lib/time.ts`), never the browser's.
- **Why:** A customer travelling abroad must still see "10:00" for a 10:00 appointment in Bengaluru.

## D36. Design system: few tokens, one loud element

- **Decision:** Mineral paper background, deep slate ink, peacock teal for actions, and **marigold only for time-sensitive things** (the held slot, the countdown). Bricolage Grotesque for headings, Onest for text, both self-hosted (no third-party font requests). The booking timeline (an hour rail like a page of an appointment book) is the one distinctive element; everything else is quiet.
- **Why:** Small businesses in India are the audience. A calm, readable UI with one clear signal for "this is held for you, act now" helps customers more than decoration.
- **Accessibility floor:** labelled fields with errors linked by `aria-describedby`, radio groups for choices, native `<dialog>` for modals (focus handling and Escape built in), visible focus rings, `prefers-reduced-motion` respected, skip link, `aria-live` toasts.

## D37. nginx serves the frontend and proxies `/api` (same origin)

- **Decision:** In production the web container serves the built files and forwards `/api/*` to the API. The browser only ever talks to one origin.
- **Alternatives:** Frontend and API on different domains with CORS and `SameSite=None` cookies.
- **Why:** Same-origin means `SameSite=Lax` cookies just work, CORS isn't on the critical path, and CSP can be strict (`default-src 'self'`). CORS is still configured (locked to `WEB_ORIGIN`) for setups that split them.

## D38. One image for API and worker; migrations as a release step

- **Decision:** `apps/api/Dockerfile` builds a single image. The API runs `node dist/index.js`, the worker `node dist/worker.js`, migrations `node dist/migrate.js` (run before the new version starts). The image is pruned with `pnpm deploy --prod` and runs as the non-root `node` user.
- **Why:** The API and worker always run the same version of the code, and there's one thing to build, scan and ship.

## D39. E2E tests drive the real stack, including the worker

- **Decision:** Playwright starts the API, the worker and Vite itself. The booking test pays with the mock provider, which sends a real signed webhook, and waits for the worker to process the refund.
- **Why:** The most valuable test is the one that proves the pieces work together the way a customer uses them. axe checks for serious accessibility problems on the main pages in the same run.

## D40. Security headers repeated in each nginx `location` (found by rehearsal)

- **What we found:** Rehearsing the Docker build by hand (real nginx, the built app, the production bundle), the app's pages came back **without** the Content-Security-Policy. nginx inherits `add_header` lines from the `server` block only into a `location` that has **no** `add_header` of its own, and `location /` sets `Cache-Control`.
- **Decision:** The headers live in `apps/web/nginx/security-headers.conf`, included in every location that serves the app. The `/api/` location includes nothing, so API responses carry only the API's own (stricter) headers.
- **Also:** missing files under `/assets/` now return 404 instead of `index.html`.
- **Verified:** the full booking-and-payment flow runs in Chrome through nginx with the strict CSP and zero console errors.

## D41. Code splitting: customers don't download the dashboards

- **Decision:** Dashboard pages load with `React.lazy` when first opened. Libraries go into separate `react`, `data` and `luxon` files, and Sentry loads only if it's configured.
- **Why:** The booking page is opened by customers, often on phones and mobile data. Our own code is now a ~15 KB (gzipped) file; the library files stay cached in the browser across our deploys because they rarely change.
- **Trade-off:** A short loading state the first time an owner opens each dashboard page.

## D42. "Anyone available": try people in a fair order, each attempt in a savepoint

- **Decision:** With `staffId: "any"`, the API lists everyone who offers the service and is free at that time, least busy that day first (tie broken by id). It then tries them one by one. Each attempt (lock that person's calendar → clear stale holds → INSERT) runs inside a `SAVEPOINT`. If the exclusion constraint rejects it, we roll back just that attempt and try the next person.
- **Alternatives:** Pick one person at random and return 409 if they're taken (wrong: someone else may still be free); lock every candidate's calendar up front (more waiting, and deadlock-prone if two requests lock in different orders).
- **Why:** Customers get a booking whenever **anyone** is free, and work is spread across the team. Rolling back to a savepoint also releases that attempt's advisory lock, so a request never holds one person's lock while waiting for another's, and deadlocks can't form.
- **Tested:** 12 customers ask for the same time at once, 5 runs in a row: always exactly 2 bookings (one per free person) and 10 × 409, with no deadlocks in the Postgres log.
