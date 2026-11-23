import { sql } from 'kysely';
import type { FastifyReply } from 'fastify';
import type { Database } from '../../db/database';
import type { MembershipRole } from '../../db/schema';
import { hashToken, newToken } from '../../lib/tokens';

/**
 * Server-side sessions.
 * - The browser holds a random token in an httpOnly cookie (JavaScript can't read it).
 * - The database holds only SHA-256(token), so a leaked DB can't be used to log in.
 * - Each session has its own CSRF token, which the frontend must echo in the
 *   `x-csrf-token` header for every state-changing request.
 */
export const SESSION_COOKIE = 'sid';

export interface AuthContext {
  sessionId: string;
  csrfToken: string;
  user: { id: string; name: string; email: string };
  activeTenantId: string | null;
  membership: { id: string; role: MembershipRole } | null;
}

export async function createSession(
  db: Database,
  userId: string,
  activeTenantId: string | null,
  ttlDays: number,
) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  await db
    .insertInto('sessions')
    .values({
      id: hashToken(token),
      user_id: userId,
      active_tenant_id: activeTenantId,
      csrf_token: newToken(),
      expires_at: expiresAt,
    })
    .execute();
  return { token, expiresAt };
}

/** Looks up the session for a cookie token, plus the membership for its active tenant. */
export async function loadAuthContext(db: Database, token: string): Promise<AuthContext | null> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .select([
        'sessions.id as sessionId',
        'sessions.csrf_token',
        'sessions.active_tenant_id',
        'users.id as userId',
        'users.name',
        'users.email',
      ])
      .where('sessions.id', '=', hashToken(token))
      .where('sessions.expires_at', '>', sql<Date>`now()`)
      .executeTakeFirst();
    if (!row) return null;

    let membership: AuthContext['membership'] = null;
    if (row.active_tenant_id) {
      // RLS: the own_memberships_read policy lets a user read their own memberships.
      await sql`SELECT set_config('app.user_id', ${row.userId}, true)`.execute(trx);
      const m = await trx
        .selectFrom('memberships')
        .select(['id', 'role'])
        .where('user_id', '=', row.userId)
        .where('tenant_id', '=', row.active_tenant_id)
        .executeTakeFirst();
      membership = m ? { id: m.id, role: m.role } : null;
    }
    return {
      sessionId: row.sessionId,
      csrfToken: row.csrf_token,
      user: { id: row.userId, name: row.name, email: row.email },
      activeTenantId: membership ? row.active_tenant_id : null,
      membership,
    };
  });
}

export async function setActiveTenant(db: Database, sessionId: string, tenantId: string) {
  await db
    .updateTable('sessions')
    .set({ active_tenant_id: tenantId })
    .where('id', '=', sessionId)
    .execute();
}

export async function deleteSession(db: Database, sessionId: string) {
  await db.deleteFrom('sessions').where('id', '=', sessionId).execute();
}

/** Used after a password reset: log the user out everywhere. */
export async function deleteAllSessionsForUser(db: Database, userId: string) {
  await db.deleteFrom('sessions').where('user_id', '=', userId).execute();
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  secure: boolean,
) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true, // not readable from JavaScript (protects against XSS stealing it)
    secure, // only sent over HTTPS in production
    sameSite: 'lax', // not sent on cross-site POSTs (first line of CSRF defence)
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
