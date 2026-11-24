import { sql, type Kysely } from 'kysely';

/**
 * 0005 — Privacy (India's DPDP Act: people can get a copy of their data and ask
 * for it to be erased).
 * - users.deleted_at: set when a customer deletes their account. The row stays
 *   (bookings and payments must be kept for the business's accounts) but the
 *   name, email and password are replaced, so it no longer identifies anyone.
 * - app_redact_email_in_audit(): the audit log is append-only for the app, so
 *   this one narrow function (running as the table owner) removes a deleted
 *   person's name and email from old audit entries, in every business.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE users ADD COLUMN deleted_at timestamptz;

    CREATE FUNCTION app_redact_email_in_audit(p_email text) RETURNS integer
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
      AS $$
      DECLARE n integer;
      BEGIN
        UPDATE audit_logs SET
          before = CASE WHEN before->>'email' = p_email
                   THEN before || '{"email": "[deleted]", "name": "[deleted]"}'::jsonb ELSE before END,
          after  = CASE WHEN after->>'email' = p_email
                   THEN after || '{"email": "[deleted]", "name": "[deleted]"}'::jsonb ELSE after END
        WHERE before->>'email' = p_email OR after->>'email' = p_email;
        GET DIAGNOSTICS n = ROW_COUNT;
        RETURN n;
      END $$;
    REVOKE ALL ON FUNCTION app_redact_email_in_audit(text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION app_redact_email_in_audit(text) TO slotwise_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP FUNCTION IF EXISTS app_redact_email_in_audit(text);
    ALTER TABLE users DROP COLUMN IF EXISTS deleted_at;
  `.execute(db);
}
