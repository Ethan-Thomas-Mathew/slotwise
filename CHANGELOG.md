# Changelog

All notable changes to Slotwise. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

Upgrade after an audit (`docs/AUDIT.md`); every change is explained in `docs/WALKTHROUGH.md`.

### Fixed

- Rate limiting treated every user behind the Docker proxy as one client.
- The forgot-password page claimed success when the request failed.
- Database failures while saving staff services were reported as "service not found".
- A capture for the wrong amount failed the webhook, so the provider retried it forever;
  it is now recorded, flagged to the owner and alerted on.
- Parallel holds could exceed the 3-unpaid-holds limit.
- A hold racing an account erasure could book for the erased account.
- A signed but malformed webhook body caused a server error.

### Added

- Timeouts for queries, idle transactions, database connections and requests.
- `pnpm bootstrap`; `pnpm dev` also starts the worker.
- A test that the API docs state each route's access rule; the benchmark records its hardware.
- Architecture Decision Records (`docs/adr/`) and a restructured walkthrough.

### Changed

- `lib/` folders replaced by modules named for what they do.
- One typeface and one type scale in the web app.
- A caller's request id is kept only if it is short and plain; Mailpit is pinned.

### Removed

- Sentry and the cloud deployment guide (the project runs locally only).
- Dead code, `pino-pretty`, and `@types` packages for libraries that ship their own types.
- `DECISIONS`, `LEARNING`, `INTERVIEW`, `EXERCISES`, `PERFORMANCE` and `ARCHITECTURE` docs,
  replaced by the ADRs, the walkthrough and the README.

## 1.0.0 - 2026-11-24

First complete version.

### Added

- **Booking:** public booking page per business, "anyone available" staff choice,
  10-minute slot holds, a booking state machine, cancel and reschedule with a
  per-business cancellation policy, automatic refunds.
- **Correctness under concurrency:** a Postgres exclusion constraint makes double
  booking impossible; per-staff advisory locks prevent deadlocks.
- **Multi-tenancy:** row-level security on every tenant-owned table, with two
  database roles (the app can't bypass the policies).
- **Payments:** Razorpay orders, signed and idempotent webhooks, late-payment
  handling, a mock provider for local demos that drives the real webhook code.
- **Accounts:** owner signup, customer registration, staff invites, password
  reset, sessions with CSRF protection, rate-limited auth.
- **Background work:** BullMQ worker for emails, hold expiry and refunds, with an
  outbox and a reconciler that repairs anything missed.
- **Owner tools:** dashboard, bookings, services, team and working hours, settings,
  activity (audit) log, failed-email retry.
- **Monitoring:** Prometheus metrics on an internal port, alert rules with unit
  tests, a provisioned Grafana dashboard (optional Docker profile).
- **API documentation:** OpenAPI 3.1 generated from the validation schemas,
  interactive docs at `/api/docs` (off by default in production).
- **Operations:** checksummed backups and a restore drill, a runbook with one
  section per alert, reversible migrations (tested).
- **Privacy (DPDP Act):** customers can download their data and erase their account.
- **Quality:** 330+ API tests, E2E and accessibility tests, coverage thresholds,
  CI with dependency audit, container vulnerability scanning and SHA-pinned actions,
  a pre-commit hook, Dependabot.
- **Docs:** architecture, written design decisions, security (OWASP Top 10),
  performance measurements, deployment, interview prep and exercises.
