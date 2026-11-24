# Walkthrough

A plain-language guide to how Slotwise was built and why, written for someone still
learning. Part 1 follows the original build, phase by phase. Part 2 records the later
upgrade: an audit, then fixes. Part 3 is the five questions an interviewer is most likely
to ask, with honest answers. Part 4 is three exercises that prove you own the code.

The reasoning behind each significant choice is in [`adr/`](adr/README.md).

## Part 1: How it was built

### Build phase 0: Foundation

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

### Build phase 1: Data model and tenant isolation

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

### Build phase 2: Auth and roles

**What was built:** owner signup (creates the business), customer registration, login/logout, "who am I" (`/auth/me`), switching between businesses, password reset by email, staff invites, role guards, CSRF protection and rate limiting.

**How a login works, step by step:**

1. `POST /auth/login` with email + password.
2. The server finds the user and checks the password with Argon2 (`src/credentials/passwords.ts`). Wrong email and wrong password get the **same** message.
3. It creates a random session token (`src/modules/auth/sessions.ts`), stores **SHA-256(token)** in `sessions`, and sends the raw token in an `httpOnly` cookie called `sid`.
4. On every later request, the `onRequest` hook in `src/http/auth.ts` hashes the cookie, finds the session, and attaches `req.auth` (user, active business, role).
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

### Build phase 3: Services, staff and availability

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

### Build phase 4: Booking and concurrency

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

### Build phase 5: Payments

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

### Build phase 6: Notifications and background jobs

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

### Build phase 7: Frontend and dashboards

**What was built:** the React app: landing page, sign up / log in / reset password / accept invite, the public booking page, checkout with a live hold countdown, customer "my bookings", the staff schedule (day/week), and owner pages (overview, bookings with filters, services, team and hours, time off, settings, activity log, email problems).

**How the frontend is organised (`apps/web/src`):**

- `api/client.ts`: the only place that calls `fetch`. It adds cookies and the CSRF header, and turns API errors into `ApiError` (with field-level messages for forms).
- `api/session.ts`: hooks like `useMe()`, `useLogin()`. After login/logout the whole query cache is cleared, so data from one account never shows in another.
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

### Build phase 8: Hardening and shipping

**What was built:** security headers and CORS, request-id logging, an OWASP Top 10:2025 review (`docs/SECURITY.md`), Playwright end-to-end tests with accessibility checks, Dockerfiles, a one-command Docker setup, CI jobs for E2E and image builds, Dependabot, a dependency audit and the README.

**Key ideas:**

- **Defence in depth:** several independent protections, so one mistake doesn't become a breach (RLS + app filters; SameSite + CSRF token + Origin check).
- **Security headers:** instructions to the browser, e.g. CSP ("only run scripts from these places") and `X-Content-Type-Options: nosniff`.
- **CORS:** the browser rule that stops other websites from reading your API's responses. We allow only our own frontend.
- **Structured logging + request ids:** every log line is JSON and carries the request's id, so one failing request can be traced through the logs.
- **Health vs readiness:** `/health` = the process is alive; `/ready` = it can reach Postgres and Redis. Load balancers use these.
- **E2E tests:** a real browser clicking through the app like a user. Slower, so only for the critical paths.
- **Docker multi-stage builds:** compile in one stage, copy only the result and production dependencies into a small final image that runs as a non-root user.
- **Supply-chain hygiene:** a lockfile, `pnpm audit` in CI (it found a vulnerable `nodemailer`, now upgraded), and Dependabot for updates.

### Build phase 9: Running it like a real service

**What was built:** Prometheus metrics and Grafana dashboards, alert rules with unit tests, generated API documentation, backups with a restore drill, a test that every migration can be undone, "download my data" and "delete my account", a runbook, a pre-commit hook, a pull request template, a changelog and container vulnerability scanning.

**Key ideas:**

- **Metrics vs logs:** logs tell you what happened to _one_ request; metrics are numbers over time (requests per second, error rate, slowest 5%) that show the health of _all_ of them. Prometheus collects the numbers every 15 seconds; Grafana draws them.
- **Labels and cardinality:** each different label value makes a new time series in memory. Label by route template (`/bookings/:id`), never by the real URL, or one person requesting random URLs could fill the memory.
- **p95 latency:** "95% of requests were faster than this". Averages hide the slow requests that users notice.
- **Alerts need a runbook:** an alert that wakes someone up must say what to do. Each rule links to a section of `docs/RUNBOOK.md`. The rules have their own tests, because a typo would mean an alert that never fires.
- **OpenAPI:** a standard, machine-readable description of an API. Generating it from the same schemas that validate requests means the docs can't fall out of date unnoticed.
- **Backups:** a backup you have never restored is only a hope. The drill restores into a scratch database and compares it with the live one.
- **Reversible migrations:** `down()` undoes `up()`. Testing it now means you can trust it during an incident.
- **Privacy law (India's DPDP Act, 2023):** people can ask for their data and ask for it to be erased. Businesses may keep what they legally need (bookings, payments), so we _anonymise_ the person instead of deleting the records.
- **Supply chain:** pin third-party code exactly (commit SHA, checksum), give CI jobs only the permissions they need, and scan images for known vulnerabilities.
- **Team workflow:** small branches, pull requests with a checklist, CI as the gate, a changelog, and version tags (Semantic Versioning: MAJOR.MINOR.PATCH).

**Try it:**

1. Start everything with monitoring (`docker compose --profile full --profile observability up -d --build`), book a few slots, and watch the Grafana dashboard move.
2. Stop the worker (`docker compose stop worker`) and watch `WorkerDown` go from "pending" to "firing" at http://localhost:9090/alerts. Then follow the runbook to fix it.
3. `pnpm db:backup` then `pnpm db:restore-drill`.
4. Open http://localhost:8080/api/docs and find the route that holds a slot. Which roles can call it?

## Part 2: The upgrade

### Upgrade phase 0: Audit

**What happened.** Before changing anything, the whole repository was re-read and
checked: tests, lint, type-check, a production build, a tool that finds unused code
(`knip`), and text searches for things the project's rules forbid. The result is
`docs/AUDIT.md`: what the system actually is, and a ranked list of problems, each
with a file and line, why it matters, a proposed fix and a rough size.

**Why audit first.** Changing code you haven't measured tends to fix the wrong
things. An audit also gives the later work a checklist: every finding ends up fixed,
or deferred with a written reason.

**What was found, in short.** The core design (tenant isolation, double-booking
prevention, payment webhooks) held up. The problems were around it: rate limiting
that treats every Docker user as one person, missing timeouts, a few places where
errors were hidden, cloud-only pieces in a project meant to run offline, a `lib/`
folder used as a junk drawer, performance numbers measured on the wrong machine,
and development setup that takes too many steps.

**Decisions taken with the owner.** Remove Sentry and the cloud deployment guide;
keep the Razorpay adapter but off by default; keep the API-docs list and strengthen
its test rather than rewrite every route file.

**Alternative considered.** Fixing things as they were spotted while reading. Rejected:
it mixes unrelated changes into one commit and makes it impossible to say afterwards
what changed and why.

### Upgrade phase 1: Baseline

The plan was to re-run the Docker setup on the Windows laptop, including the monitoring
profile, before changing anything, so every later problem could be told apart from one
that already existed. The audit itself ran in a Linux VM, where the tests, the production
build and the browser tests all passed; the laptop run is listed under known limitations
in the README until it's done.

### Upgrade phase 2: Correctness and security fixes

Each fix started with a test that failed for the right reason, then the smallest
change that made it pass. One fix per commit.

**Rate limiting behind a proxy (C1).** The limiter counts attempts per IP address.
In Docker every request reaches the API from nginx, so every user had the same
address. For the reset-password page, which has no email in the request, that meant
five attempts per 15 minutes for the whole site. Two changes: the API is told how many
proxies sit in front of it (`TRUST_PROXY_HOPS`) and then reads the real address from
the `X-Forwarded-For` header; and reset links are counted per link. The alternative,
"always trust X-Forwarded-For", would let anyone pick a fake address and dodge the
limit, which is why a hop count is used and a test checks the header is ignored when
no proxy is configured.

**Errors that were hidden (C2, C3).** The forgot-password page said "a link is on its
way" even when the request failed. Saving a staff member's services turned every
database error into "service not found". Both now pass real failures on. The general
rule: catch an error only when you know what it means and can do something useful;
otherwise let it reach the error handler, which logs it with the request id.

**A wrong payment amount (C4).** If the payment provider reports a captured amount
different from the order, the booking must not be confirmed. The code used to throw,
which made the provider retry for a day an event that could never succeed. Now the
event is stored, acknowledged as `rejected`, written to the owner's activity log, and
an alert fires. Refunding it stays a human decision.

**Race conditions (C5, C6).** The "3 unpaid holds per customer" rule counted first and
inserted later. Two requests at the same moment both saw "2" and both inserted. A test
with six simultaneous requests produced up to six holds. The fix is a lock per customer
(a Postgres advisory lock, the same tool already used per staff calendar), taken before
counting. Account deletion takes the same lock, and a hold re-checks that the account
still exists after taking it, so a request in flight during a deletion can't book.

**Malformed webhooks (C7).** A correctly signed body that wasn't valid JSON caused a 500. The body is now parsed with a Zod schema after the signature check, so bad input
is a 400. This applies the project's rule: validate everything that comes from outside.

**Timeouts (S1).** Nothing limited how long a query, an open transaction or a slow
client could hold a database connection. With 10 connections in the pool, ten stuck
requests would stop the whole API. Postgres now cancels statements after 10 seconds and
ends transactions left idle for 30; connecting gives up after 5; clients have 30 seconds
to send a request. All four are settings with defaults.

**Smaller fixes.** The hold length shown to customers comes from one constant
(`HOLD_MINUTES`, now in the shared package) instead of "10" written in four places
(C8). The Mailpit image is pinned to a version, and a test rejects unpinned images
(S3). A request id sent by the caller is kept only if it is short and plain, so it
can't flood or forge log lines (S4, found during this phase).

### Upgrade phase 3: Scope and dead code

**Removed: Sentry and the deployment guide (D1).** Sentry is a hosted error-tracking
service. The project's rule is "runs locally and offline", so code that talks to a
cloud service doesn't belong, even when it's switched off by default: it is still code
to read, packages to install and a setting to explain. Unhandled errors are still
logged with a request id and stack trace, which is what Sentry would have shown.
The deployment guide described hosting on cloud providers, for the same reason.

**Removed: dead code (D7).** A tool called `knip` lists files, exports and
dependencies that nothing uses. It found a few functions, constants and types, one
unused package (`pino-pretty`) and two `@types/...` packages for libraries that now
include their own types. Exports used only inside their own file became local, so
the public surface of each module is what other modules actually need.

**Errors no longer hidden (D5, D6).** Three places caught errors and carried on:

- `runEffects` (queueing jobs after a database commit) logged to `console` when no
  logger was passed. The logger is now required. Not rethrowing is still right here:
  the change is committed and the reconciler retries within a minute.
- Removing a scheduled email job swallowed every error. The library already returns
  0, without an error, when the job is missing or running, so only real failures
  (Redis down) were being hidden.
- Password checking turned any error into "wrong password". Erased accounts now store
  an explicit marker that never matches, and anything else must be a valid hash.

The question to ask of any `catch`: do I know what this error means, and can I do
something useful about it here? If not, let it travel up to the error handler.

### Upgrade phase 4: Structure

**`lib/` replaced by named modules (D3).** A folder called `lib` or `utils` says nothing
about what is inside, so it collects unrelated code. The API's `lib/` held HTTP errors,
validation, password hashing, tokens, the mailer, HTML escaping and metrics. They now
live in `http/`, `credentials/`, `mail/`, `jobs/effects.ts` and `metrics.ts`. The web
app's `lib/` became `api/` (the fetch client, query cache and session hooks) and
`time/`. Test helpers moved to `tests/support/`. A small script moved the files and
rewrote every import; nothing else changed in that commit, so it is easy to review.

**Time (D4).** The audit said time rules read the clock directly. On closer reading,
the rules themselves (cancellation policy, slot generation, reminder time) already take
`now` as a parameter, and only the code around them reads the clock. The missing piece
was tests at the edges of the reminder rule (exactly 24 hours before, one millisecond
earlier), which were added. No clock library was introduced, because nothing needed one.

**API docs checked against the routes (D2, option B).** Each route's access rule
(public, signed in, or specific roles) is written twice: on the route and in the API
docs list. The role guard now carries its roles, every route records the rule it
enforces as it is registered, and a test compares the two. It found one difference
straight away (`/auth/me`), which was fixed. The bigger alternative, one table per
module that both registers the routes and produces the docs, would remove the
duplication entirely, but meant rewriting all eleven route files; it is deferred.

### Upgrade phase 5: Developer experience

**One command to set up, one to run (X1, X2).** Setting up used to take five commands,
including copying a settings file by hand, and `pnpm dev` started the API and web but
not the background worker, so in development held slots never expired and emails
never went out. Now:

- `pnpm bootstrap` installs dependencies, starts Postgres, Redis and Mailpit and waits
  until they're healthy, creates `apps/api/.env` if it's missing, applies migrations and
  adds demo data. Every step is safe to repeat.
- `pnpm dev` starts the API, the worker and the web app together.

`bootstrap` is a small Node script with no dependencies rather than a shell script or a
Makefile, because it has to run on Windows too, where `make` and `bash` usually aren't
installed. pnpm can run every script whose name starts with `dev` in parallel, so the
worker got a `dev:worker` script instead of a new tool to run processes side by side.

The root `pnpm typecheck` also covers the end-to-end tests now; they weren't checked.

### Upgrade phase 6: User interface

**One typeface (U1, U2, U3).** Headings used a second font for character. A daily tool
reads more calmly with one family, so everything uses Onest. One-off text sizes
(`text-[15px]`) became a named step in the theme (`text-body`), so every size comes from
the same scale. The page background also uses the theme colours before React loads.

**No more suppressed lint rules (U5).** The booking page used an effect to put the only
available staff member into the URL, with the dependency warning switched off. Values
you can compute from other values shouldn't be stored and synchronised; they should just
be computed while rendering. That removed the effect, the suppression, and a re-render.
The signup form reads a field with `useWatch` instead of `watch`, which the React
Compiler can optimise. Lint now reports nothing.

## Part 3: Five questions an interviewer is most likely to ask

Answer in your own words; the notes below are what a good answer contains. Each points
to the code and the ADR, so you can open them while practising.

**1. "How do you stop one business from seeing another's data?"**

Three layers. In TypeScript, every data-access function needs a `TenantTx`, which only
`withTenant()` can create, so forgetting the tenant doesn't compile. In Postgres, every
tenant table has a row-level security policy, and the API connects as a role that owns no
tables, so the policy can't be skipped; with no tenant set, queries return nothing. And
composite foreign keys stop a row from pointing at another tenant's data. Tests try to
break each layer, including reusing a pooled connection. Another tenant's id gets a 404,
the same as an id that doesn't exist.
Code: `apps/api/src/db/tenant-tx.ts`, migration `0002`. ADR 0003.

**2. "How do you make sure a slot can't be booked twice?"**

The database decides: an exclusion constraint forbids overlapping held or confirmed
bookings for the same staff member, so the second insert fails and becomes a 409. A test
fires 20 requests at one slot at the same moment; exactly one succeeds. That test found a
real bug: concurrent inserts under an exclusion constraint can deadlock in Postgres, and
losers waited up to 20 seconds for a 500. The fix is a per-staff advisory lock so writers
take turns; the constraint is still the guarantee. Later, a second test found that the
3-unpaid-holds limit could be exceeded by parallel requests, fixed with a per-customer
lock. Code: `bookings/service.ts` (`holdSlot`). ADR 0004.

**3. "How do you know a payment is real? What if the webhook comes twice, late, or forged?"**

The browser never confirms anything; only Razorpay's webhook does. The signature is checked
over the raw bytes before anything is trusted. Storing the event id (unique) and applying the
event happen in one transaction, so a duplicate does nothing and a crash leaves nothing. A late
payment re-confirms inside a savepoint if the slot is still free, otherwise it is refunded
automatically. The amount always comes from the database, and a capture for the wrong amount
is recorded and flagged, never applied. Locally a mock provider signs fake webhooks and sends
them through the same route. Code: `payments/service.ts`. ADR 0007.

**4. "Did you use AI to build this? What do you actually understand?"**

Be direct: yes, it was built with AI assistance, and you directed it, reviewed it and can
explain and change any part. Then prove it rather than claim it: walk through one flow
without notes (holding a slot is a good one: validation, tenant transaction, advisory lock,
insert, 409 on conflict, after-commit job), or offer to make a small change live. The
exercises in Part 4 are practice for exactly this.

**5. "What are the weaknesses? What breaks first?"**

Be honest; it is a sign of understanding, not a confession.

- Everything runs on one Postgres. It is the right choice at this size, and the first limit.
- Writes for one staff member are serialised by the lock. Each takes milliseconds, so it
  only matters far beyond a small business's booking rate.
- Slot lookups are the hot path and aren't cached; the benchmark numbers come from one
  machine, with the load generator sharing the API's process.
- Authentication is our own code: no MFA or social login yet.
- The API docs list routes separately from where they are registered; tests catch missing
  routes and wrong access rules, but not a wrong request schema (ADR 0012).
- Emails are at-least-once: a rare duplicate is possible, a lost one is not.

What you'd do next: cache slot lookups and measure the difference, add MFA for owners,
and add WhatsApp reminders (what customers in India actually read).

**Before any of these, have the 60-second summary ready:** Slotwise is a booking platform
many small businesses share. Customers pick a service, a person and a time, and pay online.
Three things make it hard: businesses must never see each other's data (enforced in the
types and in Postgres), a slot must never be sold twice (the database decides, and a
concurrency test proves it), and payments must be trustworthy when webhooks arrive twice,
late, or forged.

## Part 4: Practise

Do these without looking at the original code. When you can, you can talk about any part
of this project with confidence.

### 1. Rewrite the slot generator (pure logic)

**Goal:** Delete the body of `generateSlots()` in `apps/api/src/modules/availability/slots.ts` (keep the types and the function signature) and write it again yourself.

**Check:** `pnpm --filter @slotwise/api exec vitest run tests/unit/slots.test.ts`: all 31 tests pass.

**Hints:** Start with the simplest test ("09:00-12:00, 30 min → 6"). Make tests pass one at a time. Read the daylight-saving tests last.

### 2. See RLS save you

**Goal:** In `apps/api/src/modules/services/repo.ts`, remove `.where('tenant_id', '=', tx.tenantId)` from `getService`. Run the tenant isolation tests. They still pass. Why? Write the answer in one sentence.

Then put it back, and instead add `ALTER TABLE services DISABLE ROW LEVEL SECURITY;` in a new migration. Now remove the `where` again. What fails?

**Check:** You can explain why there are two layers and what each one catches. Delete the migration afterwards.

### 3. Reproduce the deadlock

**Goal:** Comment out the `lockStaffCalendar(...)` line in `holdSlot` (`apps/api/src/modules/bookings/service.ts`). Run the concurrency test 5 times:

```bash
cd apps/api
for i in 1 2 3 4 5; do npx vitest run tests/integration/bookings.test.ts -t CONCURRENCY; done
```

Find the `deadlock detected` lines in the Postgres log (`docker compose logs postgres | grep -A5 deadlock`).

**Check:** You can explain why two inserts wait on each other, and why the lock fixes it. Then put the line back.
