import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AcceptInviteRequest,
  ForgotPasswordRequest,
  InvitePreviewResponse,
  InviteStaffRequest,
  InviteStaffResponse,
  LoginRequest,
  MeResponse,
  OkResponse,
  RegisterRequest,
  ResetPasswordRequest,
  SignupOwnerRequest,
  SwitchTenantRequest,
} from '@slotwise/shared';
import type { AppDeps } from '../../app';
import { AppError } from '../../lib/errors';
import { hashToken } from '../../lib/tokens';
import { parse, respond } from '../../lib/validate';
import { requireRole, requireUser, tenantContext } from '../../plugins/auth';
import * as auth from './service';
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  loadAuthContext,
  setActiveTenant,
  setSessionCookie,
} from './sessions';

export async function authRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config, jobs } = deps;
  const secureCookies = config.NODE_ENV === 'production';

  /**
   * Brute-force protection: at most 5 attempts per 15 minutes for the same
   * client IP and target (the email, or the one-time token for routes that have
   * no email). Without the target, everyone behind one NAT or proxy would share a
   * single budget. Runs as a preHandler so the body is already parsed.
   * Counters live in Redis, so the limit holds across several API instances.
   */
  const strictLimit = app.rateLimit({
    max: 5,
    timeWindow: '15 minutes',
    keyGenerator: (req: FastifyRequest) => {
      const body = req.body as { email?: unknown; token?: unknown } | undefined;
      const target =
        typeof body?.email === 'string'
          ? body.email.toLowerCase()
          : typeof body?.token === 'string'
            ? `token:${hashToken(body.token)}`
            : '-';
      return `${req.routeOptions.url}:${req.ip}:${target}`;
    },
  });

  /** Creates a session, sets the cookie and returns the /me payload. */
  async function startSession(
    reply: Parameters<typeof setSessionCookie>[0],
    userId: string,
    tenantId: string | null,
  ) {
    const { token, expiresAt } = await createSession(db, userId, tenantId, config.SESSION_TTL_DAYS);
    setSessionCookie(reply, token, expiresAt, secureCookies);
    const ctx = await loadAuthContext(db, token);
    return respond(MeResponse, await auth.buildMe(db, ctx!));
  }

  app.post('/auth/signup', { preHandler: strictLimit }, async (req, reply) => {
    const body = parse(SignupOwnerRequest, req.body);
    const { userId, tenantId } = await auth.signupOwner(db, body);
    reply.status(201);
    return startSession(reply, userId, tenantId);
  });

  app.post('/auth/register', { preHandler: strictLimit }, async (req, reply) => {
    const body = parse(RegisterRequest, req.body);
    const { userId, tenantId } = await auth.registerCustomer(db, body);
    reply.status(201);
    return startSession(reply, userId, tenantId);
  });

  app.post('/auth/login', { preHandler: strictLimit }, async (req, reply) => {
    const body = parse(LoginRequest, req.body);
    const user = await auth.login(db, body.email, body.password);
    const tenantId = body.tenantSlug
      ? await auth.joinTenant(db, user.id, body.tenantSlug, { joinAsCustomer: true })
      : await auth.defaultTenantFor(db, user.id);
    return startSession(reply, user.id, tenantId);
  });

  app.post('/auth/logout', { preHandler: requireUser }, async (req, reply) => {
    await deleteSession(db, req.auth!.sessionId);
    clearSessionCookie(reply);
    return respond(OkResponse, { ok: true });
  });

  app.get('/auth/me', async (req) => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Not logged in');
    return respond(MeResponse, await auth.buildMe(db, req.auth));
  });

  app.post('/auth/active-tenant', { preHandler: requireUser }, async (req) => {
    const body = parse(SwitchTenantRequest, req.body);
    const tenantId = await auth.joinTenant(db, req.auth!.user.id, body.slug, body);
    await setActiveTenant(db, req.auth!.sessionId, tenantId);
    const fresh = await loadAuthContext(db, req.cookies.sid!);
    return respond(MeResponse, await auth.buildMe(db, fresh!));
  });

  app.post('/auth/forgot-password', { preHandler: strictLimit }, async (req) => {
    const body = parse(ForgotPasswordRequest, req.body);
    await auth.requestPasswordReset(db, jobs, body.email, config.WEB_ORIGIN);
    // Same answer whether or not the email exists.
    return respond(OkResponse, { ok: true });
  });

  app.post('/auth/reset-password', { preHandler: strictLimit }, async (req) => {
    const body = parse(ResetPasswordRequest, req.body);
    await auth.resetPassword(db, body.token, body.password);
    return respond(OkResponse, { ok: true });
  });

  // ---------- Staff invites ----------

  app.post('/staff/invites', { preHandler: requireRole('OWNER') }, async (req, reply) => {
    const body = parse(InviteStaffRequest, req.body);
    const { inviteLink } = await auth.inviteStaff(
      db,
      jobs,
      tenantContext(req),
      body,
      config.WEB_ORIGIN,
    );
    reply.status(201);
    return respond(InviteStaffResponse, { inviteLink });
  });

  app.get('/auth/invites/:token', async (req) => {
    const { token } = req.params as { token: string };
    return respond(InvitePreviewResponse, await auth.previewInvite(db, token));
  });

  app.post('/auth/accept-invite', { preHandler: strictLimit }, async (req, reply) => {
    const body = parse(AcceptInviteRequest, req.body);
    const { userId, tenantId } = await auth.acceptInvite(db, body);
    return startSession(reply, userId, tenantId);
  });
}
