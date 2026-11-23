import * as Sentry from '@sentry/node';
import type { Config } from '../config';

/** Error tracking. Does nothing unless SENTRY_DSN is set. */
export function initSentry(config: Config, serverName: 'api' | 'worker') {
  if (!config.SENTRY_DSN) return false;
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    serverName,
    tracesSampleRate: 0.1,
    // Never send request bodies or cookies (passwords, session tokens).
    sendDefaultPii: false,
  });
  return true;
}

export { Sentry };
