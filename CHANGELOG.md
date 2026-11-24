# Changelog

All notable changes to Slotwise. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

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
- **Docs:** architecture, 40+ written design decisions, security (OWASP Top 10),
  performance measurements, deployment, interview prep and exercises.
