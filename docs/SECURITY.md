# Security review (OWASP Top 10:2025)

A self-review of Slotwise against the [OWASP Top 10:2025](https://owasp.org/Top10/2025/). For each risk: what it is in plain words, and what this app does about it, with the code or test that proves it.

---

## A01 Broken Access Control

**The risk:** users doing things they shouldn't, like reading another business's bookings or calling an owner-only endpoint as a customer.

**What Slotwise does:**

- **Tenant isolation in two layers.** Repository functions only accept a `TenantTx` (`src/db/tenant-tx.ts`) and filter by `tenant_id`. Postgres Row-Level Security filters again, so a forgotten `WHERE` still can't leak data. The API's database role owns no tables, so RLS always applies. Tests: `tenant-isolation.db.test.ts`, `catalog.test.ts`, `bookings.test.ts`.
- **Role guards** (`requireRole`) on every protected route, plus per-record checks (a customer sees only their own bookings, staff only theirs). A role × route matrix test checks every combination (`roles.test.ts`).
- **404, not 403,** for ids that belong to another tenant, so ids can't be probed.
- **Composite foreign keys** `(id, tenant_id)`: the database refuses to link records across tenants.
- **No SSRF surface:** the server only calls fixed URLs (Razorpay API, SMTP host from config), never a URL from user input.

## A02 Security Misconfiguration

**The risk:** unsafe defaults, verbose errors, open CORS, missing headers.

**What Slotwise does:**

- Config is validated at startup (`src/config.ts`). The app won't start with missing secrets, and refuses the mock payment provider in production unless explicitly allowed for a demo site.
- Security headers via `@fastify/helmet` on the API (`default-src 'none'`), and a strict CSP plus security headers in the nginx config for the frontend.
- CORS allows only the configured frontend origin, with credentials. Request bodies are capped at 100 KB. Tests: `security.test.ts`.
- Unexpected errors return a generic message. Details go to the logs (with the request id), never to the client (tested).

## A03 Software Supply Chain Failures

**The risk:** a compromised or vulnerable dependency, or an unverified build.

**What Slotwise does:**

- `pnpm-lock.yaml` is committed, and CI installs with `--frozen-lockfile`.
- pnpm 10 blocks dependency install scripts by default. Only the packages listed in `onlyBuiltDependencies` may run them.
- CI runs `pnpm audit --prod --audit-level high` (a high-severity `nodemailer` advisory was found and fixed this way). Dependabot opens weekly update PRs.
- Docker images are built in CI from the same lockfile and run as a non-root user.

## A04 Cryptographic Failures

**The risk:** weak password storage, secrets in plain text, data sent unencrypted.

**What Slotwise does:**

- Passwords: **Argon2id** via the maintained `@node-rs/argon2` (no hand-written crypto).
- Session tokens and one-time tokens (password reset, invites) are 32 random bytes from the OS; only their **SHA-256 hashes** are stored.
- Secrets live in environment variables (`.env` is git-ignored; `.env.example` has placeholders only).
- In production cookies are `Secure` and HSTS is on, so sessions only travel over HTTPS.

## A05 Injection

**The risk:** user input changing the meaning of a SQL query (or HTML, or a shell command).

**What Slotwise does:**

- All SQL goes through Kysely, which sends values as **bound parameters**. Even raw `sql\`…\``templates parameterize`${values}`.
- Every request body, query and route parameter is validated with Zod before use. Malformed ids are rejected before reaching the database.
- Email templates HTML-escape every user-provided value (tested: a `<script>` name renders as text). React escapes everything it renders.

## A06 Insecure Design

**The risk:** flaws in the design itself, not just bugs in the code.

**What Slotwise does:**

- **Double booking is impossible by design:** a Postgres exclusion constraint, not an `if`. A 20-way concurrency test proves it, and its deadlock finding is documented in [ADR 0004](adr/0004-preventing-double-booking.md).
- **Payment amount always comes from the database**, never the browser. One open order per booking (unique index).
- **The browser never confirms a payment;** only the signed webhook does.
- Holds expire, and one customer can hold at most 3 unpaid slots, so nobody can block a whole calendar.
- Every state change goes through one tested state machine.

## A07 Authentication Failures

**The risk:** password guessing, session theft, account enumeration.

**What Slotwise does:**

- Rate limiting: 5 attempts per 15 minutes per IP + email on login, signup, register, password reset and invite acceptance, stored in Redis (tested).
- The same error for "no such email" and "wrong password", with similar timing. Forgot-password always answers the same way (tested).
- Sessions: httpOnly, SameSite=Lax cookies, server-side and revocable. A password reset logs the user out everywhere (tested).
- CSRF: a per-session token is required on every write, plus an Origin check (tested).
- Reset links expire in 1 hour and invites in 7 days; both are single-use (tested).

## A08 Software or Data Integrity Failures

**The risk:** trusting data or updates without checking where they came from.

**What Slotwise does:**

- Payment webhooks are verified with **HMAC-SHA256 over the raw body** using Razorpay's SDK helper. A tampered body or wrong signature is rejected and nothing is stored (tested).
- Webhooks are **idempotent:** the unique `event_id` and the state change commit together, so replaying a webhook does nothing (tested with 5 simultaneous copies).
- The audit log is append-only for the app role (`UPDATE`/`DELETE` revoked, tested).

## A09 Security Logging & Alerting Failures

**The risk:** attacks or failures go unnoticed.

**What Slotwise does:**

- Structured JSON logs (pino) with a **request id** on every line, returned as the `x-request-id` header. Cookies, auth and CSRF headers are redacted.
- Rejected webhook signatures are logged as warnings. Unexpected errors are logged at error level with the request id and stack trace.
- An **audit log** records who changed what (before/after) for every owner action, cancellation and payment decision, viewable by the owner.
- Failed customer emails become visible to the owner after all retries.
- **Alerting:** Prometheus alert rules (unit-tested) fire on API/worker down, error rate, latency, failing jobs, queue backlog and bursts of invalid webhook signatures; each links to a runbook section (`docs/RUNBOOK.md`).

## A10 Mishandling of Exceptional Conditions

**The risk:** errors that leave the system in a broken or insecure state, or that "fail open".

**What Slotwise does:**

- **RLS fails closed:** with no tenant set, queries see zero rows (tested, including connection-pool reuse).
- Every multi-step change runs in **one transaction**. Side effects (jobs) run only after commit, and the outbox plus the every-minute reconciler recover anything lost if Redis is down.
- External calls (Razorpay, SMTP) are retried with exponential backoff. A refund retry first checks whether the refund already happened.
- Late payments (after a hold expired) are handled explicitly: re-confirm if free, otherwise automatic refund, using a savepoint.
- One consistent error shape; a bug in our own response validation is a 500, never blamed on the client.

---

## Known gaps (honest list)

- No multi-factor authentication or "log out other sessions" button yet.
- Rate limiting is per IP + email. A distributed attack on one account from many IPs would need an additional per-account limit.
- No automated dependency licence check or SBOM generation.
- No penetration test has been done; this is a self-review.

## Reporting a vulnerability

Please don't open a public issue. Email the maintainer (see the GitHub profile)
with the steps to reproduce; you'll get a reply within a few days. This is a
portfolio project that isn't hosted publicly, so no real user data is at risk.
