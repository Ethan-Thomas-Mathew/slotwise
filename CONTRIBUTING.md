# Contributing

How work gets into Slotwise. Short version: **branch → small commits → pull request
→ CI green → review → squash-merge**.

## Setup

```bash
pnpm bootstrap   # install (also installs the git pre-commit hook), start Postgres,
                 # Redis and Mailpit on 127.0.0.1, create apps/api/.env, migrate, seed
pnpm dev         # API on :3000, worker, web on :5173
```

The pre-commit hook needs pnpm on your machine. If you only use Docker, it isn't
installed and nothing checks your commits locally; CI still runs every check.

## Workflow

1. Branch from `main`: `git switch -c fix/slot-picker-timezone`
   (prefixes: `feat/`, `fix/`, `docs/`, `chore/`).
2. Commit in small steps. Messages say what changed, in the imperative:
   "Reject holds that start in the past", not "fixed stuff".
3. The **pre-commit hook** lints and formats only the files you're committing.
   If it changes a file, look at the change and commit again.
4. Open a pull request. The template has a checklist; CI must pass:
   audit, lint, format, typecheck, unit + integration tests with coverage
   thresholds, E2E tests, Docker builds with a vulnerability scan, and the
   monitoring config checks.
5. Squash-merge, so `main` has one commit per change.
6. Add a line to `CHANGELOG.md` under **Unreleased**.

## Rules that keep the system safe

- **Tenant data:** every tenant-owned table has `tenant_id`, a row-level security
  policy, and a test in `tenant-isolation.db.test.ts`. Repository functions take a
  `TenantTx`, never the raw database.
- **Migrations:** add a new file; never edit one that has run. Every migration needs a
  working `down()` (`migrations.test.ts` rolls each one back and re-applies it).
- **Routes:** validate input with a Zod schema from `packages/shared`, add the route
  to `apps/api/src/openapi/spec.ts`, then run `pnpm --filter @slotwise/api openapi`.
  A test fails if a route is undocumented.
- **Side effects** (emails, jobs) go through the outbox or run after commit, never
  inside a transaction that might roll back.
- **Secrets and personal data** never go in the repo: not in code, tests, logs or
  commits. `.env` and `backups/` are git-ignored.
- **Local only:** every port in `docker-compose.yml` is bound to `127.0.0.1`
  (`local-only.test.ts` enforces it).

## Releases

Versions follow [Semantic Versioning](https://semver.org): breaking API change →
major, new feature → minor, fix → patch. To release: move **Unreleased** in
`CHANGELOG.md` under a new version heading, bump the `version` fields, commit, and tag:
`git tag -a v1.1.0 -m "v1.1.0"`.
