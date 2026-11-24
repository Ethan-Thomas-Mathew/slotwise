import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { ownerDb } from '../helpers/db';

/**
 * Guards against the TypeScript table types (src/db/schema.ts) drifting away
 * from the real database created by the migrations.
 */
const EXPECTED: Record<string, string[]> = {
  tenants: [
    'id',
    'name',
    'slug',
    'timezone',
    'currency',
    'cancellation_window_hours',
    'booking_horizon_days',
    'created_at',
  ],
  users: ['id', 'email', 'name', 'password_hash', 'created_at', 'deleted_at'],
  memberships: ['id', 'tenant_id', 'user_id', 'role', 'created_at'],
  services: ['id', 'tenant_id', 'name', 'duration_minutes', 'price_paise', 'active', 'created_at'],
  staff_services: ['tenant_id', 'staff_membership_id', 'service_id'],
  availability_rules: [
    'id',
    'tenant_id',
    'staff_membership_id',
    'weekday',
    'start_minute',
    'end_minute',
  ],
  time_off: ['id', 'tenant_id', 'staff_membership_id', 'start_at', 'end_at', 'reason'],
  bookings: [
    'id',
    'tenant_id',
    'service_id',
    'staff_membership_id',
    'customer_membership_id',
    'start_at',
    'end_at',
    'status',
    'price_paise',
    'hold_expires_at',
    'cancelled_at',
    'created_at',
    'updated_at',
  ],
  payments: [
    'id',
    'tenant_id',
    'booking_id',
    'provider',
    'provider_order_id',
    'provider_payment_id',
    'provider_refund_id',
    'amount_paise',
    'currency',
    'status',
    'refund_reason',
    'created_at',
    'updated_at',
  ],
  webhook_events: ['id', 'provider', 'event_id', 'type', 'payload', 'received_at', 'processed_at'],
  notifications: [
    'id',
    'tenant_id',
    'booking_id',
    'type',
    'status',
    'scheduled_for',
    'attempts',
    'last_error',
    'sent_at',
    'created_at',
  ],
  audit_logs: [
    'id',
    'tenant_id',
    'actor_user_id',
    'action',
    'entity',
    'entity_id',
    'before',
    'after',
    'created_at',
  ],
  sessions: ['id', 'user_id', 'active_tenant_id', 'csrf_token', 'expires_at', 'created_at'],
  auth_tokens: [
    'id',
    'type',
    'token_hash',
    'email',
    'user_id',
    'tenant_id',
    'expires_at',
    'used_at',
    'created_at',
  ],
};

const db = ownerDb();
afterAll(() => db.destroy());

describe('database schema', () => {
  it('matches the TypeScript table definitions', async () => {
    const { rows } = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name NOT LIKE 'kysely_%'
    `.execute(db);
    const actual: Record<string, string[]> = {};
    for (const r of rows) (actual[r.table_name] ??= []).push(r.column_name);
    expect(Object.keys(actual).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [table, cols] of Object.entries(EXPECTED)) {
      expect(actual[table]?.sort(), table).toEqual([...cols].sort());
    }
  });

  it('the app role owns no tables and cannot bypass RLS', async () => {
    const { rows: owned } = await sql<{ n: number }>`
      SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'slotwise_app'
    `.execute(db);
    expect(owned[0]!.n).toBe(0);
    const { rows: role } = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`
      SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'slotwise_app'
    `.execute(db);
    expect(role[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  it('every table with a tenant_id has RLS enabled', async () => {
    const { rows } = await sql<{ table_name: string; rls: boolean }>`
      SELECT c.table_name, t.relrowsecurity AS rls
      FROM information_schema.columns c
      JOIN pg_class t ON t.relname = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
        AND c.table_name NOT IN ('auth_tokens')
    `.execute(db);
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) expect(r.rls, r.table_name).toBe(true);
  });
});
