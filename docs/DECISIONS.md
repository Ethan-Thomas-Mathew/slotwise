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
