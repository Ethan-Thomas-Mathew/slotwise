/**
 * The background worker process: `pnpm worker` (or `node dist/worker.js`).
 * Runs separately from the API so slow jobs (email, refunds) never slow down requests.
 */
import pino from 'pino';
import { Redis } from 'ioredis';
import { loadConfig } from './config';
import { createDatabase } from './db/database';
import { BullJobs } from './jobs/bull-jobs';
import { createQueues } from './jobs/queues';
import { startWorkers } from './jobs/workers';
import { createMailer } from './lib/mailer';
import { initSentry } from './lib/sentry';
import { createPaymentProvider } from './modules/payments/provider';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL, name: 'worker' });
initSentry(config, 'worker');

const db = createDatabase(config.DATABASE_URL);
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const queues = createQueues(connection);
const jobs = new BullJobs(queues);
const mailer = createMailer(config);
const workers = startWorkers(
  { db, mailer, jobs, payments: createPaymentProvider(config), webOrigin: config.WEB_ORIGIN, log },
  connection,
);

// The safety-net job: every minute. upsert = safe to call on every start.
await queues.maintenance.upsertJobScheduler('reconcile', { every: 60_000 }, { name: 'reconcile' });
log.info('Worker started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    log.info({ signal }, 'Worker shutting down');
    await Promise.all(workers.map((w) => w.close())); // finish in-flight jobs
    await Promise.all(Object.values(queues).map((q) => q.close()));
    mailer.close();
    await db.destroy();
    connection.disconnect();
    process.exit(0);
  });
}
