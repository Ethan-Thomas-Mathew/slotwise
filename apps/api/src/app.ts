import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger, { type StaticDocumentSpec } from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { sql } from 'kysely';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { Config } from './config';
import type { Database } from './db/database';
import type { Jobs } from './jobs/types';
import type { PaymentProvider } from './modules/payments/provider';
import { AppError } from './http/errors';
import { httpDuration } from './metrics';
import { buildOpenApiDocument } from './openapi/spec';
import { accessRuleOf, registerAuth, type AccessRule } from './http/auth';
import { registerErrorHandler } from './http/error-handler';
import { authRoutes } from './modules/auth/routes';
import { auditRoutes } from './modules/audit/routes';
import { bookingRoutes } from './modules/bookings/routes';
import { paymentRoutes } from './modules/payments/routes';
import { notificationRoutes } from './modules/notifications/routes';
import { dashboardRoutes } from './modules/dashboard/routes';
import { privacyRoutes } from './modules/privacy/routes';
import { publicRoutes } from './modules/public/routes';
import { serviceRoutes } from './modules/services/routes';
import { staffRoutes } from './modules/staff/routes';
import { tenantRoutes } from './modules/tenants/routes';

declare module 'fastify' {
  interface FastifyInstance {
    routeList: { method: string; url: string; who: AccessRule }[];
  }
}

/** Everything the HTTP app needs, passed in from outside (makes testing easy). */
export interface AppDeps {
  config: Config;
  db: Database;
  /** Used for rate-limit counters. Tests may pass null to use in-memory counters. */
  redis: Redis | null;
  jobs: Jobs;
  payments: PaymentProvider;
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
    // A caller's id (e.g. from a proxy) is kept only if it is short and plain, so
    // it can't flood the logs or smuggle text into them.
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && /^[\w.-]{1,64}$/.test(given) ? given : randomUUID();
    },
    requestIdHeader: false,
    bodyLimit: 100 * 1024,
    requestTimeout: config.HTTP_REQUEST_TIMEOUT_MS,
    // Trust exactly TRUST_PROXY_HOPS proxies (hop 0 is the one we're connected to).
    trustProxy: (_address: string, hop: number) => hop < config.TRUST_PROXY_HOPS,
  });

  // Keep a list of every route, so a test can check the API docs cover them all.
  const routeList: { method: string; url: string; who: AccessRule }[] = [];
  app.decorate('routeList', routeList);
  app.addHook('onRoute', (r) => {
    const who = accessRuleOf(r.preHandler);
    for (const m of [r.method].flat()) routeList.push({ method: m, url: r.url, who });
  });

  registerErrorHandler(app);
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  // Metrics: label by route TEMPLATE (/bookings/:id), never the raw URL, so the
  // number of series stays small and no ids or tokens end up in metrics.
  app.addHook('onResponse', async (req, reply) => {
    httpDuration.observe(
      {
        method: req.method,
        route: req.routeOptions.url ?? 'unmatched',
        status_code: reply.statusCode,
      },
      reply.elapsedTime / 1000,
    );
  });

  // Security headers. The API only returns JSON, so the strictest CSP is fine.
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: config.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  // Only our own frontend may call the API from a browser (with cookies).
  await app.register(cors, {
    origin: [config.WEB_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-csrf-token'],
    maxAge: 600,
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
  await paymentRoutes(app, deps);
  await notificationRoutes(app, deps);
  await dashboardRoutes(app, deps);
  await privacyRoutes(app, deps);

  // Interactive API docs at /docs (through the web app: /api/docs). On by default
  // locally, off by default in production so the API's map is not handed out.
  if (
    config.API_DOCS === 'true' ||
    (config.API_DOCS === undefined && config.NODE_ENV !== 'production')
  ) {
    await app.register(swagger, {
      mode: 'static',
      specification: {
        // Our generator builds plain objects; the plugin's types want literal unions.
        document: buildOpenApiDocument() as unknown as StaticDocumentSpec['document'],
      },
    });
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      // The UI's own CSP (the API's default would block its scripts), minus the
      // external validator host and the http->https upgrade, which breaks localhost.
      staticCSP: true,
      transformStaticCSP: (csp) =>
        csp.replace(' validator.swagger.io', '').replace(/\s*upgrade-insecure-requests;/, ''),
      uiConfig: { tryItOutEnabled: false, withCredentials: true, validatorUrl: null },
      uiHooks: {
        // "/docs" -> "docs/" (relative), so it also works behind the /api proxy.
        onRequest: (req, reply, done) => {
          if (req.url.split('?')[0] === '/docs') return reply.redirect('docs/');
          done();
        },
      },
    });
  }

  return app;
}
