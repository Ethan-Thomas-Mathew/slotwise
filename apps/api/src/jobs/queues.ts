import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';

/** Queue names. Each queue has a worker in src/jobs/workers.ts. */
export const QUEUE = {
  emails: 'emails',
  holds: 'holds',
  notifications: 'notifications',
  refunds: 'refunds',
  maintenance: 'maintenance',
} as const;

export interface EmailJob {
  to: string;
  subject: string;
  text: string;
  html: string;
}
export interface HoldExpiryJob {
  tenantId: string;
  bookingId: string;
}
export interface NotificationJob {
  tenantId: string;
  notificationId: string;
}
export interface RefundJob {
  tenantId: string;
  paymentId: string;
}

/**
 * Retries with exponential backoff: 5s, 10s, 20s, 40s… up to 6 attempts.
 * Finished jobs are deleted; failed ones are kept for a week so they can be inspected.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
};

export function createQueues(connection: ConnectionOptions, prefix?: string) {
  const opts = {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
    ...(prefix ? { prefix } : {}),
  };
  return {
    emails: new Queue<EmailJob>(QUEUE.emails, opts),
    holds: new Queue<HoldExpiryJob>(QUEUE.holds, opts),
    notifications: new Queue<NotificationJob>(QUEUE.notifications, opts),
    refunds: new Queue<RefundJob>(QUEUE.refunds, opts),
    maintenance: new Queue(QUEUE.maintenance, opts),
  };
}
export type Queues = ReturnType<typeof createQueues>;
