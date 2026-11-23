import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { sql } from 'kysely';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { Config } from './config';
import type { Database } from './db/database';
import type { Jobs } from './jobs/types';
import { AppError } from './lib/errors';
import { registerAuth } from './plugins/auth';
import { registerErrorHandler } from './plugins/error-handler';
import { authRoutes } from './modules/auth/routes';
import { auditRoutes } from './modules/audit/routes';
import { bookingRoutes } from './modules/bookings/routes';
import { publicRoutes } from './modules/public/routes';
import { serviceRoutes } from './modules/services/routes';
import { staffRoutes } from './modules/staff/routes';
import { tenantRoutes } from './modules/tenants/routes';

/** Everything the HTTP app needs, passed in from outside (makes testing easy). */
export interface AppDeps {
  config: Config;
  db: Database;
  /** Used for rate-limit counters. Tests may pass null to use in-memory counters. */
  redis: Redis | null;
  jobs: Jobs;
}

/**
 * Builds the Fastify app without starting it. Tests call this and use app.inject()
 * to send fake HTTP requests, so no real port is needed.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: [
              'req.headers.cookie',
              'req.headers.authorization',
              'req.headers["x-csrf-token"]',
            ],
          },
    // Every request gets an id; it appears in every log line for that request.
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    requestIdHeader: false,
    bodyLimit: 100 * 1024,
    trustProxy: config.NODE_ENV === 'production',
  });

  registerErrorHandler(app);
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    ...(deps.redis ? { redis: deps.redis, nameSpace: 'slotwise-rl:' } : {}),
    errorResponseBuilder: (_req, ctx) =>
      new AppError('RATE_LIMITED', `Too many attempts. Try again in ${ctx.after}.`),
  });
  registerAuth(app, deps.db, config.WEB_ORIGIN);

  // Liveness: the process is up.
  app.get('/health', async () => ({ status: 'ok' }));
  // Readiness: the process can actually serve traffic (database + Redis reachable).
  app.get('/ready', async (_req, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = {};
    try {
      await sql`SELECT 1`.execute(deps.db);
      checks.database = 'ok';
    } catch {
      checks.database = 'fail';
    }
    if (deps.redis) {
      try {
        await deps.redis.ping();
        checks.redis = 'ok';
      } catch {
        checks.redis = 'fail';
      }
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ok' : 'fail', checks });
  });

  await authRoutes(app, deps);
  await publicRoutes(app, deps);
  await tenantRoutes(app, deps);
  await serviceRoutes(app, deps);
  await staffRoutes(app, deps);
  await auditRoutes(app, deps);
  await bookingRoutes(app, deps);

  return app;
}
