import { sql, type Kysely } from 'kysely';

/**
 * 0002 — Row-Level Security (RLS): the database-level tenant wall.
 *
 * How it works:
 * 1. Each request runs inside a transaction that first calls
 *      SELECT set_config('app.tenant_id', '<uuid>', true)
 *    (`true` = "only for this transaction", so pooled connections never leak it).
 * 2. Every tenant-owned table has a policy: a row is visible/writable only if
 *    its tenant_id equals that setting.
 * 3. If the setting is missing, app_current_tenant() returns NULL, `tenant_id = NULL`
 *    is never true, and the query sees ZERO rows. It fails closed.
 *
 * RLS does not apply to a table's owner or to superusers. That's why the API
 * connects as `slotwise_app`, which owns nothing (see docker/postgres/init.sql).
 */

const TENANT_TABLES = [
  'services',
  'staff_services',
  'availability_rules',
  'time_off',
  'bookings',
  'payments',
  'notifications',
  'audit_logs',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  // nullif(..., '') matters: after a transaction that used set_config(..., true)
  // ends, the setting on that pooled connection becomes '' (not NULL), and
  // ''::uuid would throw an error instead of matching nothing.
  await sql`
    CREATE FUNCTION app_current_tenant() RETURNS uuid
      LANGUAGE sql STABLE
      AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

    CREATE FUNCTION app_current_user() RETURNS uuid
      LANGUAGE sql STABLE
      AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
  `.execute(db);

  for (const table of TENANT_TABLES) {
    await sql`
      ALTER TABLE ${sql.table(table)} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON ${sql.table(table)}
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant());
    `.execute(db);
  }

  await sql`
    -- memberships: tenant-scoped, PLUS a user may always read their own memberships
    -- (needed at login, before any tenant is chosen).
    ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON memberships
      USING (tenant_id = app_current_tenant())
      WITH CHECK (tenant_id = app_current_tenant());
    CREATE POLICY own_memberships_read ON memberships FOR SELECT
      USING (user_id = app_current_user());

    -- tenants: anyone may read (name, slug, timezone are shown on the public
    -- booking page) but only the current tenant may be created or changed.
    ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenants_read ON tenants FOR SELECT USING (true);
    CREATE POLICY tenants_insert ON tenants FOR INSERT WITH CHECK (id = app_current_tenant());
    CREATE POLICY tenants_update ON tenants FOR UPDATE
      USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());
  `.execute(db);

  // Grants for the app role (also covered by default privileges in init.sql;
  // repeated here so the migration is self-contained).
  await sql`
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO slotwise_app;
    -- The audit log is append-only for the app.
    REVOKE UPDATE, DELETE ON audit_logs FROM slotwise_app;
    -- The app has no business reading or changing migration history.
    REVOKE ALL ON kysely_migration, kysely_migration_lock FROM slotwise_app;
  `.execute(db);

  /*
   * A few background tasks genuinely need to look across tenants (e.g. a payment
   * webhook arrives and we don't yet know which tenant it belongs to).
   * Instead of a general "bypass RLS" switch, each need gets ONE narrow
   * SECURITY DEFINER function. It runs with the owner's rights (so RLS doesn't
   * apply), but it can only do the one thing it was written for.
   */
  await sql`
    CREATE FUNCTION app_tenant_for_payment_order(p_order_id text) RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
      AS $$ SELECT tenant_id FROM payments WHERE provider_order_id = p_order_id $$;

    -- Safety net for holds whose expiry job was lost (e.g. Redis was down).
    CREATE FUNCTION app_expire_stale_holds() RETURNS integer
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
      AS $$
      DECLARE n integer;
      BEGIN
        UPDATE bookings SET status = 'EXPIRED', updated_at = now()
          WHERE status = 'HELD' AND hold_expires_at <= now();
        GET DIAGNOSTICS n = ROW_COUNT;
        RETURN n;
      END $$;

    -- Emails that are due but were never sent (outbox safety net).
    CREATE FUNCTION app_due_notifications(p_limit integer)
      RETURNS TABLE (id uuid, tenant_id uuid)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
      AS $$
        SELECT n.id, n.tenant_id FROM notifications n
        WHERE n.status = 'PENDING' AND n.scheduled_for <= now() - interval '1 minute'
        ORDER BY n.scheduled_for LIMIT p_limit
      $$;

    -- Refunds we decided to make but haven't confirmed with the provider yet.
    CREATE FUNCTION app_pending_refunds(p_limit integer)
      RETURNS TABLE (id uuid, tenant_id uuid)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
      AS $$
        SELECT p.id, p.tenant_id FROM payments p
        WHERE p.status = 'REFUND_PENDING' AND p.updated_at <= now() - interval '1 minute'
        ORDER BY p.updated_at LIMIT p_limit
      $$;

    REVOKE ALL ON FUNCTION app_tenant_for_payment_order(text), app_expire_stale_holds(),
      app_due_notifications(integer), app_pending_refunds(integer) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app_tenant_for_payment_order(text), app_expire_stale_holds(),
      app_due_notifications(integer), app_pending_refunds(integer) TO slotwise_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP FUNCTION IF EXISTS app_tenant_for_payment_order(text), app_expire_stale_holds(),
      app_due_notifications(integer), app_pending_refunds(integer);
    DROP POLICY IF EXISTS tenants_read ON tenants;
    DROP POLICY IF EXISTS tenants_insert ON tenants;
    DROP POLICY IF EXISTS tenants_update ON tenants;
    ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON memberships;
    DROP POLICY IF EXISTS own_memberships_read ON memberships;
    ALTER TABLE memberships DISABLE ROW LEVEL SECURITY;
  `.execute(db);
  for (const table of TENANT_TABLES) {
    await sql`
      DROP POLICY IF EXISTS tenant_isolation ON ${sql.table(table)};
      ALTER TABLE ${sql.table(table)} DISABLE ROW LEVEL SECURITY;
    `.execute(db);
  }
  await sql`DROP FUNCTION IF EXISTS app_current_tenant(), app_current_user();`.execute(db);
}
