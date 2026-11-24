/**
 * The background worker process: `pnpm worker` (or `node dist/worker.js`).
 * Runs separately from the API so slow jobs (email, refunds) never slow down requests.
 */
import pino from 'pino';
import { Redis } from 'ioredis';
import { loadConfig } from './config';
import { createDatabase, runtimePoolOptions } from './db/database';
import { BullJobs } from './jobs/bull-jobs';
import { createQueues } from './jobs/queues';
import { startWorkers } from './jobs/workers';
import { createMailer } from './mail/mailer';
import { startMetricsServer, trackQueueDepth } from './metrics';
import { createPaymentProvider } from './modules/payments/provider';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL, name: 'worker' });

const db = createDatabase(config.DATABASE_URL, runtimePoolOptions(config));
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
trackQueueDepth(Object.values(queues));
// Metrics are useful but not essential: if their port is taken, keep working.
const metricsServer = await startMetricsServer(
  config.WORKER_METRICS_PORT,
  config.METRICS_HOST,
).catch((err: Error) => {
  log.warn({ err: err.message }, 'Metrics server not started');
  return undefined;
});
log.info({ metrics: `${config.METRICS_HOST}:${config.WORKER_METRICS_PORT}` }, 'Worker started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    log.info({ signal }, 'Worker shutting down');
    await Promise.all(workers.map((w) => w.close())); // finish in-flight jobs
    await Promise.all(Object.values(queues).map((q) => q.close()));
    metricsServer?.close();
    mailer.close();
    await db.destroy();
    connection.disconnect();
    process.exit(0);
  });
}
