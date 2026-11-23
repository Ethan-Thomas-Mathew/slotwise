# Learning notes

Plain-language notes, one section per phase: what was built, why, and the concepts to understand.

---

## Phase 0: Foundation

**What was built:** the empty "skeleton" of the project. Nothing a user can see yet, but everything later phases rely on: the folder layout, TypeScript settings, linting, formatting, tests, local databases and CI.

**Why it matters:** Setting up tooling first means every line written later is type-checked, linted and tested automatically. In interviews, "a fresh clone runs with one command and CI is green" signals you work like a professional team.

**How the pieces fit:**

- `pnpm-workspace.yaml` tells pnpm that `apps/*` and `packages/*` are separate packages in one repo. `apps/api` can depend on `@slotwise/shared` with `"workspace:*"`.
- `tsconfig.base.json` holds TypeScript settings every package shares. `strict: true` turns on all the safety checks. `noUncheckedIndexedAccess` means `array[0]` has type `T | undefined`, which forces you to handle "it might not be there".
- `eslint.config.js` catches likely bugs (unused variables, `console.log` left in code). Prettier only formats.
- `docker-compose.yml` runs Postgres, Redis and Mailpit locally so nobody has to install them by hand.
- `apps/api/src/config.ts` reads environment variables **once**, validates them with Zod and crashes at startup if something is wrong.
- `apps/api/src/app.ts` builds the Fastify app **without** starting it. Tests use `app.inject()` to send fake requests straight into the app. That's fast and needs no open port.
- `.github/workflows/ci.yml` runs install → lint → format check → type-check → tests → build on every push.

**Concepts:**

- **Monorepo:** several related projects in one Git repository.
- **Strict TypeScript:** the compiler refuses code where a value could be `null`/`undefined` and you didn't handle it.
- **Linter vs formatter:** a linter finds suspicious code; a formatter only changes spacing and layout.
- **Environment variables:** settings that live outside the code (passwords, URLs) so the same code runs in dev, test and production.
- **CI (Continuous Integration):** a server that automatically checks every change.
- **Docker Compose:** a file describing several containers (database, cache…) that start together.

---

## Phase 1: Data model and tenant isolation

**What was built:** all the database tables, the "no double booking" rule, the tenant wall (Row-Level Security), the code that talks to the database, a seed script with two demo businesses, and tests that try to break the tenant wall.

**Why it was built this way:**

- **Migrations** (`apps/api/src/db/migrations/`) are numbered files that change the database step by step. Every developer and every server runs the same steps in the same order, so all databases end up identical. They run as the `slotwise_owner` role.
- **The tenant wall has two layers.**
  1. _Application layer:_ data-access functions (in each module's `repo.ts`) take a `TenantTx`. You can only get a `TenantTx` from `withTenant(db, tenantId, …)`. So forgetting the tenant is a **compile error**, not a data leak. Every query also says `.where('tenant_id', '=', tx.tenantId)`.
  2. _Database layer (RLS):_ even if someone writes a query without that `where`, Postgres adds it. `withTenant` runs `set_config('app.tenant_id', …, true)` at the start of the transaction, and every tenant table has the policy `tenant_id = app_current_tenant()`.
- **Why two roles:** the API logs in as `slotwise_app`, which owns no tables. Table owners skip RLS, so this is what makes RLS actually apply.
- **The double-booking rule** lives in the `bookings` table as an _exclusion constraint_: "no two HELD/CONFIRMED rows for the same staff member may have overlapping time ranges". Postgres checks it inside the database, so two simultaneous requests can't both win. That's impossible to guarantee with an `if` in app code.
- **Composite foreign keys** `(id, tenant_id)` mean a booking can't reference a service from a different tenant. The database refuses.
- **Tests** in `tests/integration/tenant-isolation.db.test.ts` try to read, update and delete across tenants, write rows for the wrong tenant, and reuse a pooled connection. All of it must fail.

**Concepts:**

- **Multi-tenant:** one app and one database serving many separate customers (tenants).
- **Row-Level Security (RLS):** Postgres rules that filter which rows a query can see or change.
- **`set_config(name, value, true)`:** sets a variable for the current transaction only.
- **Transaction:** a group of database changes that all succeed or all fail together.
- **Connection pool:** a set of open database connections reused between requests (opening one is slow). That's why a setting must never "stick" to a connection.
- **Exclusion constraint:** like UNIQUE, but for "these must not overlap" (uses a GiST index).
- **`tstzrange(start, end, '[)')`:** a time range including the start and excluding the end, so 10:00–10:30 and 10:30–11:00 don't overlap.
- **`SECURITY DEFINER` function:** runs with the rights of the role that created it, not the caller. Used here as a narrow, controlled exception to RLS.
- **Seed script:** fills an empty database with realistic demo data.

---

## Phase 2: Auth and roles

**What was built:** owner signup (creates the business), customer registration, login/logout, "who am I" (`/auth/me`), switching between businesses, password reset by email, staff invites, role guards, CSRF protection and rate limiting.

**How a login works, step by step:**

1. `POST /auth/login` with email + password.
2. The server finds the user and checks the password with Argon2 (`src/lib/passwords.ts`). Wrong email and wrong password get the **same** message.
3. It creates a random session token (`src/modules/auth/sessions.ts`), stores **SHA-256(token)** in `sessions`, and sends the raw token in an `httpOnly` cookie called `sid`.
4. On every later request, the `onRequest` hook in `src/plugins/auth.ts` hashes the cookie, finds the session, and attaches `req.auth` (user, active business, role).
5. Route guards like `requireRole('OWNER')` run before the handler and return 401/403 if needed.

**Why each protection exists:**

- **httpOnly cookie:** JavaScript can't read it, so an XSS bug can't steal the session.
- **Hashing the token in the DB:** a database leak doesn't hand out logins.
- **CSRF token:** a malicious website can make your browser send a request to Slotwise _with your cookie_. It can't read your CSRF token, so its request is refused.
- **Origin check:** a second CSRF defence that also covers login.
- **Rate limit:** stops someone trying thousands of passwords.
- **One-time, expiring tokens** for password reset (1 hour) and invites (7 days), stored hashed.
- **Password reset logs you out everywhere** (deletes all sessions).

**Concepts:**

- **Authentication vs authorization:** _who are you_ (login) vs _what may you do_ (roles).
- **Session vs JWT:** a session is a pointer to server-side state and can be revoked; a JWT carries its own data and is hard to revoke before it expires.
- **Argon2id:** a password hashing algorithm designed to be slow and memory-hungry, so guessing is expensive.
- **CSRF (Cross-Site Request Forgery):** tricking a logged-in browser into sending a request.
- **Rate limiting:** capping how often something can be done.
- **User enumeration:** finding out which emails have accounts from differing error messages.
- **Constant-time comparison:** comparing secrets without leaking, through timing, how many characters matched.

---

## Phase 3: Services, staff and availability

**What was built:** owner screens' API for services, team members, working hours and time off (every change written to the audit log), the public booking page API (`/public/{slug}` and `/public/{slug}/slots`), and the **slot generator**.

**How available slots are calculated** (`src/modules/availability/slots.ts`):

1. Turn the requested date (e.g. `2026-12-01`) into that day in the **business's** timezone.
2. Pick the staff member's working windows for that weekday (e.g. 09:00–12:00 and 14:00–17:00).
3. Walk each window in steps of the service length: 09:00, 09:30, 10:00…
4. Throw away any slot that overlaps time off or an existing booking, starts in the past, or is further ahead than the booking horizon (60 days by default).

It's a **pure function**: it gets everything it needs as arguments and doesn't touch the database or the clock. `availability/service.ts` loads the data from the database and calls it. That split is why the function has 31 fast unit tests.

**Why daylight saving matters even for an Indian business:** India has no DST, but the code supports any timezone. On the day New York's clocks jump forward, "01:00–04:00" is only two real hours. The tests prove no fake 02:00 slot appears.

**Audit log:** every owner change records _who_, _what_, _before_ and _after_, inside the same transaction as the change. The app role can't UPDATE or DELETE audit rows (enforced in the database).

**Concepts:**

- **Pure function:** output depends only on inputs; no side effects.
- **IANA timezone:** names like `Asia/Kolkata`; they include all historical and DST rules.
- **Half-open interval `[start, end)`:** includes the start, excludes the end. Two intervals overlap when `a.start < b.end && b.start < a.end`.
- **Audit log:** an append-only history of who changed what.
- **Soft delete / deactivate:** hide something instead of deleting it, to preserve history.
- **HTTP 404 vs 403:** 404 hides whether something exists; 403 says it exists but you can't have it.

---

## Phase 4: Booking and concurrency

**What was built:** holding a slot, the booking state machine, cancelling, rescheduling, marking completed/no-show, listing bookings for each role, the hold-expiry job logic, and the big **concurrency test**.

**The hold flow** (`src/modules/bookings/service.ts → holdSlot`):

1. Check the requested time is a real available slot (reuses the slot generator).
2. Check the customer doesn't already hold 3 unpaid slots.
3. Take an advisory lock for that staff member's calendar.
4. Mark any timed-out holds in the way as EXPIRED.
5. INSERT the booking as HELD for 10 minutes. If Postgres says `23P01` (exclusion violation), return **409 "Someone just took that slot"**.
6. After commit, schedule a job to expire the hold.

**The concurrency story (great interview material):**

- A naive app does "SELECT: is it free? → INSERT". Two requests can both see "free" and both insert. That's a **race condition**.
- We let the **database** decide with an exclusion constraint. Only one overlapping row can exist.
- Our test fires 20 requests at once, ten times. At first it failed about 1 run in 4: Postgres reported **deadlocks**, because two inserts were each waiting for the other. Nothing was double-booked, but some customers got a 500 after waiting seconds.
- Fix: a per-staff **advisory lock** so writers take turns. Now it's always exactly 1 × 201 and 19 × 409, fast, and the test proves ~120 of the 190 losers were stopped by the constraint itself.

**Rescheduling is one UPDATE** of the same row, so there's never a moment where the customer has both slots or neither.

**Concepts:**

- **Race condition:** the result depends on the timing of concurrent operations.
- **Deadlock:** two transactions each waiting for a lock the other holds. The database kills one.
- **Advisory lock:** a lock on an arbitrary number that your app chooses; `pg_advisory_xact_lock` releases automatically at commit or rollback.
- **`SELECT … FOR UPDATE`:** read a row and lock it so no one else changes it until you commit.
- **Compare-and-set:** "update only if it's still in the state I expect".
- **State machine:** a fixed set of states and allowed moves between them.
- **Idempotent:** doing it twice has the same effect as doing it once (e.g. the expiry job).
- **Outbox pattern:** write "messages to send" into the database in the same transaction as the change; a separate process sends them.

---

## Phase 5: Payments

**What was built:** creating a payment order, the Razorpay webhook (signature check, idempotency, confirming bookings), automatic refunds (cancellations and late payments), and a mock provider so everything works without Razorpay keys.

**The payment flow:**

```
Customer clicks Pay
  → POST /payments/order          amount read from OUR database, one open order per booking
  → Razorpay Checkout (browser)   customer pays by UPI/card
  → browser shows "Processing…"   does NOT confirm anything
  → Razorpay → POST /webhooks/razorpay
        1. check HMAC signature of the raw body   (fake? → 400)
        2. find the tenant for this order          (narrow SECURITY DEFINER function)
        3. one transaction:
             insert event_id (UNIQUE)              (seen before? → stop)
             payment → CAPTURED, booking → CONFIRMED
             queue confirmation + 24h reminder emails
```

**Why each piece exists:**

- **HMAC signature:** Razorpay and we share a secret. Razorpay sends `HMAC(secret, body)`. Only someone with the secret can produce it, so we know the message is genuine and unmodified.
- **Raw body:** the signature is over the exact bytes. If we parsed and re-stringified the JSON, spacing could change and the check would fail. Only the webhook route keeps the raw string.
- **Idempotency:** providers deliver webhooks **at least once**, so duplicates are normal. The unique `event_id` plus doing everything in one transaction means "processed exactly once".
- **Savepoint:** a checkpoint inside a transaction. We try to re-confirm a late payment; if Postgres refuses (slot taken), we roll back to the checkpoint and refund instead, without throwing away the rest of the work.
- **Refund job:** talking to an external API can fail. Marking `REFUND_PENDING` first and retrying in the background means a refund is never forgotten, and checking for an existing refund first means it's never done twice.

**Concepts:**

- **Webhook:** a server calling your server when something happens.
- **HMAC:** a signature made from a shared secret and the message.
- **At-least-once delivery:** you may get the same message more than once; your handler must be idempotent.
- **Idempotency key:** a unique id that lets you detect repeats (here `event_id`).
- **Source of truth:** the system whose answer wins when two disagree (Razorpay, not the browser).
- **Savepoint:** a partial-rollback point inside a transaction.

---

## Phase 6: Notifications and background jobs

**What was built:** the worker process (`pnpm worker`), email templates, confirmation / 24-hour reminder / cancellation / late-payment-refund emails, retries with backoff, a failed-email list owners can retry, and an every-minute "reconciler" safety net.

**How an email gets sent:**

1. Inside the same transaction that confirms a booking, we insert rows into `notifications` (status PENDING): one "confirmed" for now, one "reminder" for 24 hours before the start.
2. After the commit, we add BullMQ jobs: `notification-<id>`, delayed until its time.
3. The worker picks the job up, locks the row, checks it still makes sense (still PENDING? booking still confirmed?), renders the email and sends it over SMTP.
4. Success → SENT. Failure → `attempts + 1`, BullMQ retries after 5 s, 10 s, 20 s… After the last try → FAILED, visible to the owner.

**What happens when things change:**

- _Cancel:_ the reminder row becomes CANCELLED and its job is removed; a cancellation email is created.
- _Reschedule:_ the old reminder is cancelled, a new one is created for the new time.
- _A job arrives anyway (stale):_ the worker sees the row isn't PENDING or isn't due, and skips it.

**Why a reconciler:** queues can lose jobs (Redis restart, a crash right after commit). Because the _intent_ is stored in Postgres, a job that runs every minute finds anything overdue and re-queues it. That's the outbox pattern paying off.

**Concepts:**

- **Message queue / job queue:** a list of work for background workers. BullMQ stores it in Redis.
- **Delayed job:** a job that becomes runnable at a future time.
- **Exponential backoff:** waiting longer after each failure (5 s, 10 s, 20 s…) so a struggling service can recover.
- **At-least-once vs exactly-once:** queues guarantee a job runs _at least_ once; your code makes repeats harmless.
- **Reconciliation:** periodically comparing "what should have happened" with "what did" and fixing the gap.
- **SMTP:** the protocol for sending email. Mailpit is a fake SMTP server with a web UI for development.

---

## Phase 7: Frontend and dashboards

**What was built:** the React app: landing page, sign up / log in / reset password / accept invite, the public booking page, checkout with a live hold countdown, customer "my bookings", the staff schedule (day/week), and owner pages (overview, bookings with filters, services, team and hours, time off, settings, activity log, email problems).

**How the frontend is organised (`apps/web/src`):**

- `lib/api.ts`: the only place that calls `fetch`. It adds cookies and the CSRF header, and turns API errors into `ApiError` (with field-level messages for forms).
- `lib/auth.ts`: hooks like `useMe()`, `useLogin()`. After login/logout the whole query cache is cleared, so data from one account never shows in another.
- `features/…`: one folder per area (booking, owner, staff, customer, auth).
- `components/ui.tsx`: buttons, fields, dialog, alerts, loading/empty/error states, so every screen handles those three states the same way.

**Data fetching with TanStack Query:** `useQuery({ queryKey, queryFn })` gives you `isPending`, `isError`, `data` and caching. After a change (`useMutation`) we _invalidate_ related keys so lists refresh.

**Forms:** React Hook Form + the **same Zod schemas the API uses** (`@slotwise/shared`). The browser shows mistakes instantly, and if the server still rejects something, `applyServerErrors` puts its message next to the right field.

**Why the booking choice lives in the URL:** `/b/glow-salon?service=…&staff=…&date=…&time=…`. If the customer has to log in first, they come back to exactly the same choice.

**Concepts:**

- **Server state vs client state:** data owned by the server (bookings) vs data that only lives in the browser (is the menu open?).
- **Cache invalidation:** telling the cache some data is stale so it refetches.
- **Controlled form / schema validation:** form values checked against a schema before sending.
- **Polling:** asking the server repeatedly until something changes (checkout waiting for the webhook).
- **Accessibility (a11y):** labels, focus, keyboard use and screen-reader announcements so everyone can use the app.
