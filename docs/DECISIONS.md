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
