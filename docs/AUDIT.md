# Audit

Date: 24 November 2026. Commit audited: `66137f5` (tag `v1.0.0`).

This is a read-only review against the upgrade brief. No code was changed to
produce it.

## What was run

| Check                                                   | Result                                            |
| ------------------------------------------------------- | ------------------------------------------------- |
| Fresh clone, `pnpm install --frozen-lockfile`           | OK                                                |
| `pnpm lint`, `pnpm format:check`, `pnpm typecheck`      | OK (1 lint warning, see U5)                       |
| `pnpm audit --prod`                                     | 0 known vulnerabilities                           |
| API tests (`vitest`, real Postgres 16 and Redis 7)      | 327 passed, 1 skipped (needs Mailpit)             |
| Web and shared tests                                    | 9 + 1 passed                                      |
| E2E (`playwright`, CI mode, servers started by the run) | 14 passed                                         |
| Production build, then `node dist/index.js`             | starts; `/health`, `/docs/`, metrics port respond |
| `knip` (unused files, exports, dependencies)            | findings in D7                                    |
| Text searches for the anti-slop rules                   | findings in X1 to X4                              |

Where this ran: a Linux VM (2 vCPU). **Not run here:** the Docker setup with the
monitoring profile (no Docker in this environment), and a fully offline start. The
Docker setup was last confirmed working on the Windows laptop before the monitoring,
API-docs and privacy changes. Phase 1 starts by re-checking it there.

## Architecture as it exists

```
browser ──> web (React SPA; Vite in dev, nginx in Docker) ──/api──> api (Fastify)
                                                                     │   │
                                    Postgres 16 <── Kysely ──────────┘   └── Redis 7 (rate limits, BullMQ)
                                         ^                                     │
                                         └──────────── worker (BullMQ) <───────┘── SMTP (Mailpit)
```

- **Monorepo** (pnpm workspaces): `apps/api` (6.7k lines), `apps/web` (4.1k),
  `packages/shared` (Zod schemas used by both), `e2e`, `ops` (Prometheus, Grafana).
  Tests: 4.4k lines.
- **API**: one Fastify app built by `buildApp(deps)` so tests can inject fakes.
  48 operations in 11 route modules. Each module is `routes.ts` (HTTP, validation)
  → `service.ts` (rules, transactions) → `repo.ts` (SQL via Kysely). Pure logic lives
  in `availability/slots.ts` and `bookings/state-machine.ts`; most other rules sit in
  `service.ts` files next to the SQL calls.
- **Tenancy**: 14 tables. The 9 tenant-owned ones and `tenants` itself have row-level
  security; `users`, `sessions`, `auth_tokens` and `webhook_events` are global. The app
  connects as a role that cannot bypass RLS; `withTenant()` sets the tenant for one
  transaction. Narrow `SECURITY DEFINER` functions cover the few cross-tenant reads.
- **Bookings**: an exclusion constraint forbids overlaps per staff member; a per-staff
  advisory lock serialises writers to avoid deadlocks; holds expire after 10 minutes.
- **Payments**: a provider interface with two implementations (Razorpay, and a mock
  that signs fake webhooks and sends them through the real webhook route). Webhooks
  are HMAC-verified on the raw body and de-duplicated by event id in the same
  transaction as their effect.
- **Background work**: rows in `notifications` act as an outbox; jobs are queued after
  commit; a reconciler runs every minute and re-queues anything missed.
- **Operations**: Prometheus metrics on internal ports, alert rules, Grafana (opt-in
  compose profile), OpenAPI document and Swagger UI, backup and restore-drill scripts,
  data export and account erasure.
- **Runs today**: `docker compose --profile full up --build` (app at :8080), or for
  development `docker compose up -d`, then `pnpm db:migrate && pnpm db:seed`,
  `pnpm dev`, and the worker in a second terminal.

## Findings

Severity: **High** = wrong behaviour users can hit, or a brief requirement not met.
**Medium** = a real defect with limited reach, or a design problem that will cause
bugs. **Low** = clean-up. Effort: S (under an hour), M (a few hours), L (a day or more).

### Correctness

| #   | Sev    | Where                                                             | Problem and why it matters                                                                                                                                                                                                                                                                                 | Fix                                                                                                                                                       | Effort |
| --- | ------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| C1  | High   | `apps/api/src/app.ts:70`, `modules/auth/routes.ts:42`             | Rate-limit keys use `req.ip`, but `trustProxy` is off unless `NODE_ENV=production`. In the Docker setup every request comes from the nginx container, so all users share one IP. `reset-password` and `accept-invite` have no email in the body, so the whole site gets 5 attempts per 15 minutes on each. | Make proxy trust an explicit setting (`TRUST_PROXY_HOPS`, 1 in compose). Key token-based routes by a hash of the token. Regression test with two clients. | S      |
| C2  | Medium | `apps/web/src/features/auth/pages.tsx:263`                        | "Forgot password" ignores every error and always says the link is on its way, including when the server is down or the request was rate-limited.                                                                                                                                                           | Show network and 429 errors; keep the identical message for "no such account" (that part is deliberate).                                                  | S      |
| C3  | Medium | `apps/api/src/modules/staff/routes.ts:55`                         | Any error while saving a staff member's services becomes "404 Service not found", including a lost database connection or a deadlock. Real failures are hidden.                                                                                                                                            | Map only foreign-key violations (`23503`) to 404; let everything else reach the error handler.                                                            | S      |
| C4  | Medium | `apps/api/src/modules/payments/service.ts:247`                    | A captured amount that doesn't match the order throws, which rolls back the event record and returns 500. Razorpay then retries for a day, the money sits captured with no booking, and the only signal is a log line.                                                                                     | Record the event as `rejected` with the reason, return 200, alert on it, and show it to the owner. Test it.                                               | M      |
| C5  | Low    | `apps/api/src/modules/bookings/service.ts:190`                    | The 3-holds-per-customer cap is counted before the per-staff lock, so parallel holds on different staff members can exceed it. It is an abuse guard, not a money rule.                                                                                                                                     | Take a per-customer advisory lock before counting. Add a parallel test.                                                                                   | S      |
| C6  | Low    | `apps/api/src/modules/privacy/service.ts:174`                     | A hold started in the same moment as an account erasure can survive it (the check and the hold don't share a lock). The hold expires in 10 minutes and can't be paid, since all sessions are gone.                                                                                                         | Reuse the per-customer lock from C5. Document the rest.                                                                                                   | S      |
| C7  | Low    | `apps/api/src/modules/payments/service.ts:153`                    | A webhook with a valid signature but malformed JSON causes a 500 instead of a 400.                                                                                                                                                                                                                         | Parse with Zod after the signature check; reject with 400.                                                                                                | S      |
| C8  | Low    | `modules/notifications/templates.ts:89`, `payments/service.ts:51` | "10-minute" is written into two user-facing messages; `HOLD_MINUTES` is the real value. Changing one makes the text wrong.                                                                                                                                                                                 | Build the text from the constant.                                                                                                                         | S      |

### Security

| #   | Sev    | Where                                         | Problem and why it matters                                                                                                                                                                                                                      | Fix                                                                                                                                                                              | Effort |
| --- | ------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| S1  | Medium | `apps/api/src/app.ts:54`, `db/database.ts:12` | No timeouts anywhere. Fastify has no request timeout; the pg pool has no connect timeout; Postgres has no `statement_timeout` or `idle_in_transaction_session_timeout`. One stuck query or slow client holds a connection (of 10) indefinitely. | Request and connection timeouts on Fastify; `connectionTimeoutMillis` on the pool; `statement_timeout` and idle-in-transaction timeout for the app role. Settings with defaults. | S      |
| S2  | Low    | `apps/api/src/app.ts:70`                      | In production `trustProxy: true` trusts any `X-Forwarded-For`, so a client that can reach the API directly could pick its own IP for rate limiting. Fixed by C1's hop count.                                                                    | Covered by C1.                                                                                                                                                                   | -      |
| S3  | Low    | `docker-compose.yml:36`, CI                   | `axllent/mailpit:latest` is unpinned: builds are not reproducible and a compromised tag would be pulled silently. The other images are pinned by version, none by digest.                                                                       | Pin Mailpit to a version.                                                                                                                                                        | S      |
| S4  | Low    | `apps/api/src/app.ts:66`                      | Found during phase 2: a caller's `x-request-id` header was copied into every log line and the response at any length and with any characters.                                                                                                   | Keep it only if it is 1-64 plain characters; otherwise generate one.                                                                                                             | S      |

No injection, access-control or secret-handling problems were found. The RLS,
CSRF, session and webhook designs hold up on re-reading.

### Design

| #   | Sev    | Where                                                                    | Problem and why it matters                                                                                                                                                                                                                                                                             | Fix                                                                                                                                                                                                                                                  | Effort     |
| --- | ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| D1  | High   | Sentry (`lib/sentry.ts`, web `main.tsx`, two packages), `docs/DEPLOY.md` | The brief says local and offline, no cloud services. Sentry is a cloud service (off by default, but shipped and documented), and DEPLOY.md is a guide to hosting on cloud providers.                                                                                                                   | Remove Sentry and DEPLOY.md. Uncaught errors are already logged with request ids.                                                                                                                                                                    | S          |
| D2  | Medium | `apps/api/src/openapi/spec.ts` (649 lines)                               | Every route is described twice: once where it is registered, once in the docs list. A test catches a missing or extra route, but not a wrong schema or wrong roles in the docs.                                                                                                                        | Option A: one route table per module (method, path, roles, schemas) used both to register the route and to build the docs. Option B: keep, and extend the test to compare roles. Needs your decision.                                                | A: L, B: S |
| D3  | Medium | `apps/api/src/lib/` (10 files), `apps/web/src/lib/`, `tests/helpers/`    | `lib/` is the dumping ground the brief rules out: HTTP errors, validation, ISO date helpers (in `validate.ts`), password hashing, tokens, HTML escaping, the mailer, metrics and Sentry share one folder.                                                                                              | Group by what they are for: `http/` (errors, validation, params, error handler), `auth/` crypto beside sessions, `mail/` (mailer, html), `observability/metrics.ts`. Web: `api/`, `auth/`, `time/`. Tests: `tests/support/`. Pure moves, one commit. | M          |
| D4  | Medium | services (e.g. `bookings/service.ts`)                                    | Time is read from the clock in 30 places; some functions take `now`, others call `new Date()` or SQL `now()`. Time rules (cancellation window, reminders, hold expiry) can only be tested by choosing dates far enough away, not at their edges.                                                       | Pass `now` into the time rules that matter (cancellation policy, reminder time, hold expiry) and test their boundaries. No clock framework.                                                                                                          | M          |
| D5  | Low    | `apps/api/src/lib/effects.ts:18`                                         | Falls back to `console` when no logger is passed, outside the structured logger.                                                                                                                                                                                                                       | Make the logger required.                                                                                                                                                                                                                            | S          |
| D6  | Low    | `apps/api/src/jobs/bull-jobs.ts:36`                                      | `.catch(() => 0)` swallows every error from removing a job, including Redis being down. The comment justifies only the "job is running" case.                                                                                                                                                          | Ignore only that case.                                                                                                                                                                                                                               | S          |
| D7  | Low    | see list                                                                 | Dead code: `findUserById` (`users/repo.ts:13`), `getMembershipById` (`memberships/repo.ts:21`), `fmtDay` (web `lib/time.ts:10`), `sendWebhook` and `WEBHOOK_SECRET` (`tests/helpers/payments.ts`). Unused dependency: `pino-pretty`. 12 exports and 17 types exported but only used inside their file. | Delete the dead code and dependency; un-export what is file-local.                                                                                                                                                                                   | S          |
| D8  | Low    | many files                                                               | Some comments restate the code ("check every 1.5 seconds") and there are decorative `// -----` dividers.                                                                                                                                                                                               | One pass: keep comments that say why, delete the rest.                                                                                                                                                                                               | M          |

### Performance

| #   | Sev    | Where                         | Problem and why it matters                                                                                                                                                                            | Fix                                                                                                  | Effort         |
| --- | ------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------- |
| P1  | High   | `docs/PERFORMANCE.md`, README | Every number was measured on a cloud VM, not on the machine this project is presented from. The brief says no number that wasn't measured here. The page also extrapolates ("over 400,000 per hour"). | Re-measure on the laptop; the script records the hardware itself. Remove extrapolations.             | S (+ your run) |
| P2  | Medium | `apps/api/scripts/bench.ts`   | The benchmark doesn't record hardware, Node and Postgres versions, or memory, so results can't be compared or checked. Its settings use `VAR=value pnpm …`, which doesn't work in PowerShell.         | Print CPU, RAM, OS and versions; sample API memory (RSS) during the run; take settings as arguments. | S              |

No measured bottleneck needs fixing. Reads (`/slots`) are the hot path; leave
caching alone until a measurement on the real machine says otherwise.

### Developer experience

| #   | Sev    | Where                | Problem and why it matters                                                                                                                                                                                | Fix                                                                                                                                               | Effort |
| --- | ------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| X1  | High   | `package.json:10`    | `pnpm dev` starts the API and web but not the worker, so in development holds never expire and emails never send unless you remember a second terminal.                                                   | `pnpm dev` runs API, worker and web.                                                                                                              | S      |
| X2  | Medium | README "Run locally" | Setup for development is five commands, including copying `.env`. The brief asks for one to set up and one to run. `make` isn't available on Windows by default, so pnpm scripts are the portable choice. | `pnpm bootstrap` (start containers, write `.env` if missing, migrate, seed) and `pnpm dev`. Test on a clean clone, Windows included.              | S      |
| X3  | Medium | `docs/`              | Ten documents with overlap: `DECISIONS.md` (51 entries, many small), `LEARNING.md`, `INTERVIEW.md` and `EXERCISES.md` cover similar ground. The brief asks for `docs/adr/` and `docs/WALKTHROUGH.md`.     | ADRs for the significant decisions only (about 12); fold the rest into code comments or drop them. Merge LEARNING and INTERVIEW into WALKTHROUGH. | M      |
| X4  | Low    | `.husky/pre-commit`  | The hook needs pnpm on the machine; with Docker-only use it silently doesn't install. CI still checks everything.                                                                                         | Document it in CONTRIBUTING.                                                                                                                      | S      |

### UI and UX

| #   | Sev    | Where                                            | Problem and why it matters                                                                                             | Fix                                                                              | Effort |
| --- | ------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| U1  | Medium | `apps/web/src/index.css:2-3,25-26`               | Two typefaces (Bricolage Grotesque for headings, Onest for text). The brief asks for one family.                       | Keep Onest; drop Bricolage and its package.                                      | S      |
| U2  | Low    | across `apps/web/src`                            | The type scale mixes Tailwind steps with one-off sizes (`text-[15px]` 14 times, `text-[11px]` once).                   | Define the scale once in the theme and use only it.                              | S      |
| U3  | Low    | `apps/web/index.html:8`                          | The body uses Tailwind's default slate colours, outside the app's own palette (visible as a flash before React loads). | Use the theme tokens.                                                            | S      |
| U4  | Low    | README                                           | No screenshot.                                                                                                         | Add one taken from the running app.                                              | S      |
| U5  | Low    | `features/auth/pages.tsx`, `booking-page.tsx:67` | One lint warning (React Compiler can't optimise `useForm().watch`) and one `exhaustive-deps` suppression.              | Replace `watch` with `useWatch`; restructure the effect so the suppression goes. | S      |

Loading, empty and error states exist on every data view checked. Keyboard focus is
visible, and axe finds no serious issues on the main pages.

### Anti-slop rules

| #   | Where                 | Finding                                                                                                                        |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A1  | `README.md:5`         | "built … to industry standards": marketing.                                                                                    |
| A2  | `README.md:13`        | "Video: walkthrough to be recorded": a placeholder.                                                                            |
| A3  | `docs/PERFORMANCE.md` | Extrapolated figure (see P1).                                                                                                  |
| A4  | names                 | `result`/`data` in four places (`bookings/routes.ts:33`, `public/routes.ts:65`, `privacy/routes.ts:18`, `jobs/workers.ts:62`). |

No emojis, no TODO/FIXME, no commented-out code, no `any`, no `@ts-ignore`. TypeScript
runs with `strict` and `noUncheckedIndexedAccess`. All input is validated with Zod at
the boundary.

## What is already in good shape

Kept as is unless a finding above says otherwise: the RLS design and its tests, the
exclusion constraint and the concurrency tests, webhook verification and idempotency,
the outbox and reconciler, migrations (all reversible, tested), structured logging with
request ids, graceful shutdown, the lockfile, CI, and the local-only guard test on
`docker-compose.yml`.

## Plan

One logical change per commit; refactors and behaviour changes never share a commit;
every commit leaves the app runnable and the tests green. After each phase,
`docs/WALKTHROUGH.md` gets a plain-language section.

| Phase | Content                                                                                                                                                                                    | Findings          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| 1     | **Baseline on the laptop.** Re-run the Docker setup there, including the monitoring profile, before changing anything.                                                                     | -                 |
| 2     | **Correctness and security.** Each fix starts with a failing test.                                                                                                                         | C1-C8, S1, S3     |
| 3     | **Scope and dead code.** Remove Sentry and DEPLOY.md, dead code, the unused dependency; narrow exports; tighten error handling.                                                            | D1, D5-D7         |
| 4     | **Structure.** Replace `lib/` with named modules; pass `now` into time rules; route table if you choose option A.                                                                          | D2-D4, A4         |
| 5     | **Developer experience.** `pnpm bootstrap` and `pnpm dev` (with the worker), checked on a clean clone on Windows.                                                                          | X1, X2, X4        |
| 6     | **UI.** One typeface, one type scale, theme colours in `index.html`, lint warning.                                                                                                         | U1-U3, U5         |
| 7     | **Benchmarks.** Script records hardware and memory; you run it on the laptop; numbers go into the README.                                                                                  | P1, P2            |
| 8     | **Documentation.** README in the brief's structure with a screenshot; `docs/adr/`; WALKTHROUGH with the five interview questions; comment pass; final anti-slop search; clean-clone check. | X3, D8, U4, A1-A3 |

### Decisions (24 November 2026)

- D1: remove Sentry and DEPLOY.md.
- Razorpay adapter: kept, off by default (the mock provider is the default and needs no keys).
- D2: option B. The route table (option A) is **deferred**: the coverage test already
  catches a missing or extra route, and extending it to compare roles covers the next
  most likely mistake for far less churn than rewriting 11 route modules.
