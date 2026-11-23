import { sql, type Kysely } from 'kysely';

/**
 * 0003 — Sessions and one-time auth tokens (password reset, staff invites).
 *
 * These are "system" tables: they're looked up before any tenant is known
 * (e.g. reading the session cookie), so they don't have RLS. Only the auth
 * module touches them.
 *
 * We store a SHA-256 HASH of each secret token, never the token itself. If the
 * database leaked, the hashes couldn't be used to log in or reset a password.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TYPE auth_token_type AS ENUM ('PASSWORD_RESET', 'STAFF_INVITE');

    CREATE TABLE sessions (
      id text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      active_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
      csrf_token text NOT NULL,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX sessions_user_idx ON sessions (user_id);

    CREATE TABLE auth_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type auth_token_type NOT NULL,
      token_hash text NOT NULL UNIQUE,
      email text NOT NULL,
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    GRANT SELECT, INSERT, UPDATE, DELETE ON sessions, auth_tokens TO slotwise_app;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS auth_tokens, sessions;
    DROP TYPE IF EXISTS auth_token_type;
  `.execute(db);
}
