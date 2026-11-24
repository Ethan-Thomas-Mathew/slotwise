import { Redis } from 'ioredis';
import type { AppDeps } from './app';
import type { Config } from './config';
import { createDatabase, runtimePoolOptions } from './db/database';
import { BullJobs } from './jobs/bull-jobs';
import { createQueues } from './jobs/queues';
import { createPaymentProvider } from './modules/payments/provider';

/** Creates the real (production/dev) dependencies from config. */
export function createDeps(config: Config) {
  const db = createDatabase(config.DATABASE_URL, runtimePoolOptions(config));
  // BullMQ requires maxRetriesPerRequest: null on its connections.
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const queues = createQueues(redis);
  const jobs = new BullJobs(queues);
  const payments = createPaymentProvider(config);
  const deps: AppDeps = { config, db, redis, jobs, payments };

  async function close() {
    await Promise.all(Object.values(queues).map((q) => q.close()));
    await db.destroy();
    redis.disconnect();
  }
  return { deps, queues, close };
}
