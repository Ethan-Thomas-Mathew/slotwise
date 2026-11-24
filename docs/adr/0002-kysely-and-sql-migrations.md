# 0002. Kysely and SQL migrations instead of an ORM

Status: accepted (November 2026)

## Context

The hardest parts of the system are PostgreSQL features: row-level security policies,
an exclusion constraint, `set_config()` per transaction, advisory locks, savepoints, and
reacting to specific error codes (`23P01`, `23503`). The original plan named Prisma.

## Decision

Kysely, a type-checked SQL query builder, on top of `pg`. Migrations are SQL written by
hand inside Kysely's migrator, each with an `up()` and a working `down()`. The TypeScript
table types in `src/db/schema.ts` are written by hand.

## Consequences

- Queries read like the SQL they produce, and column names and result types are checked.
- Every Postgres feature is available directly, with no escape hatches.
- No migrations generated from a schema file. The table types can drift from the real
  tables, so a test compares them with the database's own column list.

## Alternatives rejected

- **Prisma:** can't express RLS, exclusion constraints or savepoints; most of the important
  code would have been raw SQL inside an ORM. It also downloads native engines at install
  time, which the original build environment couldn't reach.
- **Drizzle:** closer to SQL than Prisma, but the same features still need raw SQL.
- **Plain `pg` with no builder:** no type checking of columns or results.
