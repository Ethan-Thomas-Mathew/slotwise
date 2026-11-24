# 0003. Tenant isolation with row-level security and two database roles

Status: accepted (November 2026)

## Context

Many businesses (tenants) share one database. A single forgotten `WHERE tenant_id = ?`
would show one business another's customers. Code review alone can't make that
impossible.

## Decision

Isolation is enforced in three layers:

1. **Application:** every repository function takes a `TenantTx`, which only
   `withTenant(db, tenantId, fn)` can create. Forgetting the tenant is a type error.
2. **Database:** every tenant-owned table has a row-level security policy
   `tenant_id = app_current_tenant()`. `withTenant` sets `app.tenant_id` with
   `set_config(..., true)`, so the value lasts only for that transaction.
   `app_current_tenant()` uses `nullif(..., '')`, so a connection with no tenant set sees
   zero rows instead of failing or seeing everything.
3. **References:** foreign keys are composite, `(id, tenant_id)`, so a booking can't point
   at another tenant's service even through a bug.

The API connects as `slotwise_app`, which owns no tables and can't bypass RLS (Postgres
skips RLS for a table's owner). Migrations run as `slotwise_owner`. The few operations that
must look across tenants (a webhook finding its tenant from an order id, the reconciler)
call narrow `SECURITY DEFINER` functions that each do one thing.

An id that is malformed, missing, or another tenant's gets the same 404, so ids can't be
probed.

## Consequences

- A missing filter returns no rows rather than leaking; tests prove it over HTTP, in raw
  SQL, and on a reused pooled connection.
- Two connection strings to manage.
- Each new cross-tenant need is a migration with a new function.

## Alternatives rejected

- **One role with `FORCE ROW LEVEL SECURITY`:** works, but also blocks the narrow
  owner-run functions.
- **A database or schema per tenant:** strong isolation, but migrations, connections and
  reporting multiply with every tenant.
- **Application filtering only:** one forgotten `WHERE` is a data leak.
