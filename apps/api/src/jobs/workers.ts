import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/database';
import { withTenant } from '../db/tenant-tx';
import type { Mailer } from '../lib/mailer';
import { jobs as jobsMetric, refunds } from '../lib/metrics';
import { expireHold } from '../modules/bookings/service';
import { processNotification, reconcile } from '../modules/notifications/service';
import type { PaymentProvider } from '../modules/payments/provider';
import { processRefund } from '../modules/payments/service';
import type { Jobs } from './types';
import {
  QUEUE,
  type EmailJob,
  type HoldExpiryJob,
  type NotificationJob,
  type RefundJob,
} from './queues';

interface WorkerDeps {
  db: Database;
  mailer: Mailer;
  payments: PaymentProvider;
  jobs: Jobs;
  webOrigin: string;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
}

const attemptOf = (job: Job) => ({ number: job.attemptsMade + 1, max: job.opts.attempts ?? 1 });

/** One BullMQ worker per queue. Each processor is a thin wrapper around tested service code. */
export function startWorkers(deps: WorkerDeps, connection: ConnectionOptions, prefix?: string) {
  const opts = { connection, ...(prefix ? { prefix } : {}) };

  const workers = [
    new Worker<EmailJob>(QUEUE.emails, async (job) => deps.mailer.send(job.data), {
      ...opts,
      concurrency: 5,
    }),

    new Worker<HoldExpiryJob>(
      QUEUE.holds,
      async (job) => {
        const expired = await withTenant(deps.db, job.data.tenantId, (tx) =>
          expireHold(tx, job.data.bookingId),
        );
        return { expired };
      },
      { ...opts, concurrency: 10 },
    ),

    new Worker<NotificationJob>(
      QUEUE.notifications,
      async (job) =>
        processNotification(deps, job.data.tenantId, job.data.notificationId, attemptOf(job)),
      { ...opts, concurrency: 5 },
    ),

    new Worker<RefundJob>(
      QUEUE.refunds,
      async (job) => {
        const result = await processRefund(deps, job.data.tenantId, job.data.paymentId);
        if (result === 'refunded') refunds.inc();
        return result;
      },
      { ...opts, concurrency: 2 },
    ),

    new Worker(QUEUE.maintenance, async () => reconcile(deps.db, deps.jobs), {
      ...opts,
      concurrency: 1,
    }),
  ];

  for (const w of workers) {
    w.on('completed', () => jobsMetric.inc({ queue: w.name, result: 'completed' }));
    w.on('failed', (job, err) => {
      jobsMetric.inc({ queue: w.name, result: 'failed' });
      deps.log.warn(
        { queue: w.name, jobId: job?.id, attempt: job?.attemptsMade, err: err.message },
        'Job failed',
      );
    });
    w.on('error', (err) => deps.log.error({ queue: w.name, err }, 'Worker error'));
  }
  return workers;
}
