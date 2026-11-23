import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests: a real browser against the real API, worker and frontend.
 * Needs Postgres + Redis running and the database migrated
 * (`docker compose up -d && pnpm db:migrate`).
 */
const CI = Boolean(process.env.CI);

const apiEnv = {
  NODE_ENV: 'development',
  PORT: '3000',
  WEB_ORIGIN: 'http://localhost:5173',
  DATABASE_URL:
    process.env.E2E_DATABASE_URL ??
    'postgresql://slotwise_app:app_password@localhost:5432/slotwise',
  MIGRATION_DATABASE_URL:
    process.env.E2E_MIGRATION_DATABASE_URL ??
    'postgresql://slotwise_owner:owner_password@localhost:5432/slotwise',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  PAYMENTS_PROVIDER: 'mock',
  RAZORPAY_WEBHOOK_SECRET: 'e2e-webhook-secret',
  // e2e/email-flows.spec.ts runs a tiny SMTP server on this port to read the emails.
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '2526',
  LOG_LEVEL: 'warn',
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Use an installed Chrome instead of Playwright's download, if given.
        launchOptions: process.env.PW_CHROME_PATH
          ? { executablePath: process.env.PW_CHROME_PATH }
          : {},
      },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @slotwise/api exec tsx src/index.ts',
      url: 'http://localhost:3000/ready',
      env: apiEnv,
      reuseExistingServer: !CI,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @slotwise/api exec tsx src/worker.ts',
      wait: { stdout: /Worker started/ },
      env: { ...apiEnv, LOG_LEVEL: 'info' },
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @slotwise/web exec vite --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: !CI,
      timeout: 60_000,
    },
  ],
});
