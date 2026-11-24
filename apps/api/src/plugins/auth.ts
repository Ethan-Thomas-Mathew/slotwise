import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../db/database';
import type { MembershipRole } from '../db/schema';
import { withTenant, type TenantTx } from '../db/tenant-tx';
import { AppError } from '../lib/errors';
import { safeEqual } from '../lib/tokens';
import { loadAuthContext, SESSION_COOKIE, type AuthContext } from '../modules/auth/sessions';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Runs on every request:
 * 1. Origin check: a state-changing request from a browser on another site is refused.
 * 2. Reads the session cookie (if any) and attaches `req.auth`.
 */
export function registerAuth(app: FastifyInstance, db: Database, webOrigin: string) {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req) => {
    if (UNSAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      // Browsers always send Origin on cross-site POSTs. Server-to-server calls
      // (e.g. payment webhooks) send none and are authenticated another way.
      if (origin && origin !== webOrigin) {
        throw new AppError('CSRF_FAILED', 'Cross-origin request refused');
      }
    }
    const token = req.cookies[SESSION_COOKIE];
    req.auth = token ? await loadAuthContext(db, token) : null;
  });
}

function checkCsrf(req: FastifyRequest, auth: AuthContext) {
  if (!UNSAFE_METHODS.has(req.method)) return;
  const header = req.headers['x-csrf-token'];
  if (typeof header !== 'string' || !safeEqual(header, auth.csrfToken)) {
    throw new AppError('CSRF_FAILED', 'Missing or invalid CSRF token');
  }
}

/** Route guard: must be logged in (and send a valid CSRF token on writes). */
export async function requireUser(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Please log in');
  checkCsrf(req, req.auth);
}

/** Route guard: must be logged in AND have one of these roles in the active tenant. */
export function requireRole(...roles: MembershipRole[]) {
  return async function roleGuard(req: FastifyRequest, reply: FastifyReply) {
    await requireUser(req, reply);
    const m = req.auth!.membership;
    if (!m) throw new AppError('FORBIDDEN', 'Choose a business first');
    if (!roles.includes(m.role)) {
      throw new AppError('FORBIDDEN', 'You do not have permission to do that');
    }
  };
}

interface TenantContext {
  tenantId: string;
  userId: string;
  membershipId: string;
  role: MembershipRole;
}

/** The current tenant/role. Only call after requireRole() has run. */
export function tenantContext(req: FastifyRequest): TenantContext {
  const a = req.auth;
  if (!a?.membership || !a.activeTenantId)
    throw new AppError('FORBIDDEN', 'Choose a business first');
  return {
    tenantId: a.activeTenantId,
    userId: a.user.id,
    membershipId: a.membership.id,
    role: a.membership.role,
  };
}

/** Runs `fn` in a transaction scoped (and RLS-locked) to the request's tenant. */
export function inTenant<T>(db: Database, req: FastifyRequest, fn: (tx: TenantTx) => Promise<T>) {
  const ctx = tenantContext(req);
  return withTenant(db, ctx.tenantId, fn, { userId: ctx.userId });
}
