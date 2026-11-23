import type { FastifyInstance, FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { Sentry } from '../lib/sentry';

/** Converts every thrown error into the one consistent error shape. */
export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request is invalid',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }
    const fe = err as FastifyError;
    // Errors Fastify raises itself (bad JSON, body too large, rate limit...).
    if (fe.statusCode && fe.statusCode < 500) {
      const code =
        fe.statusCode === 429
          ? 'RATE_LIMITED'
          : fe.statusCode === 404
            ? 'NOT_FOUND'
            : 'VALIDATION_ERROR';
      return reply.status(fe.statusCode).send({ error: { code, message: fe.message } });
    }
    // Anything else is a bug: log it with the request id, hide details from the client.
    req.log.error({ err }, 'Unhandled error');
    Sentry.captureException(err, { tags: { requestId: req.id } }); // no-op unless SENTRY_DSN is set
    return reply
      .status(500)
      .send({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: `Route ${req.url} not found` } });
  });
}
