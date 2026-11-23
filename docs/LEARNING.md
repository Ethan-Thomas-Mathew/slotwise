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
