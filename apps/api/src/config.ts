import { z } from 'zod';

/**
 * All configuration comes from environment variables, validated once at startup.
 * If something required is missing, the app refuses to start with a clear message
 * instead of failing later in a confusing way.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  MIGRATION_DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  /**
   * How many reverse proxies sit in front of the API (nginx in Docker = 1). Their
   * X-Forwarded-For entries are trusted to find the client's real address, which
   * rate limiting depends on. 0 = the API is reached directly; trust nothing.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(7),

  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('Slotwise <no-reply@slotwise.local>'),

  PAYMENTS_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(8),

  /**
   * Prometheus metrics are served on a separate port, never the public one.
   * 127.0.0.1 = only this machine can read them. Docker sets 0.0.0.0 so Prometheus
   * can reach them over the private Docker network (the port is not published).
   */
  METRICS_HOST: z.string().default('127.0.0.1'),
  METRICS_PORT: z.coerce.number().int().default(9464),
  WORKER_METRICS_PORT: z.coerce.number().int().default(9465),

  /** Serve interactive API docs at /docs. Default: on unless NODE_ENV=production. */
  API_DOCS: z.enum(['true', 'false']).optional(),

  SENTRY_DSN: z.string().optional(),
  /** Demo deployments only: allow the mock payment provider in production. */
  ALLOW_MOCK_PAYMENTS: z.enum(['true', 'false']).default('false'),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings ("SENTRY_DSN=") as "not set".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  const config = parsed.data;
  if (
    config.PAYMENTS_PROVIDER === 'razorpay' &&
    (!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET)
  ) {
    throw new Error('PAYMENTS_PROVIDER=razorpay needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
  }
  if (
    config.NODE_ENV === 'production' &&
    config.PAYMENTS_PROVIDER === 'mock' &&
    config.ALLOW_MOCK_PAYMENTS !== 'true'
  ) {
    throw new Error(
      'The mock payment provider cannot be used in production (set ALLOW_MOCK_PAYMENTS=true for a demo site)',
    );
  }
  return config;
}
