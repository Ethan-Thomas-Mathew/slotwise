import { sql, type Kysely } from 'kysely';

/**
 * 0004 — Payments.
 * - At most ONE open (unpaid) order per booking. If the customer clicks "Pay"
 *   twice, or a payment attempt fails and they retry, they reuse the same
 *   Razorpay order instead of creating a second one that could also be paid.
 * - Refund webhooks identify the payment (not the order), so they need their
 *   own narrow tenant lookup.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE UNIQUE INDEX payments_one_open_order_per_booking
      ON payments (booking_id) WHERE status IN ('CREATED', 'FAILED');
    CREATE INDEX payments_provider_payment_idx ON payments (provider_payment_id);

    CREATE FUNCTION app_tenant_for_provider_payment(p_payment_id text) RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
      AS $$ SELECT tenant_id FROM payments WHERE provider_payment_id = p_payment_id LIMIT 1 $$;
    REVOKE ALL ON FUNCTION app_tenant_for_provider_payment(text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app_tenant_for_provider_payment(text) TO slotwise_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP FUNCTION IF EXISTS app_tenant_for_provider_payment(text);
    DROP INDEX IF EXISTS payments_provider_payment_idx;
    DROP INDEX IF EXISTS payments_one_open_order_per_booking;
  `.execute(db);
}
