import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Config } from './config';
import { registerErrorHandler } from './plugins/error-handler';

export interface AppDeps {
  config: Config;
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
    bodyLimit: 100 * 1024,
  });

  registerErrorHandler(app);

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
