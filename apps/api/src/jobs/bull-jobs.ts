import type { Jobs, OutgoingEmail } from './types';
import type { Queues } from './queues';

/**
 * BullMQ implementation of Jobs. Job ids are deterministic (e.g.
 * "notification-<id>") so the same thing is never queued twice, and a
 * rescheduled reminder can find and replace its old job.
 */
export class BullJobs implements Jobs {
  constructor(readonly queues: Queues) {}

  async sendEmail(email: OutgoingEmail) {
    await this.queues.emails.add('send', email);
  }

  async scheduleHoldExpiry(tenantId: string, bookingId: string, at: Date) {
    await this.queues.holds.add(
      'expire',
      { tenantId, bookingId },
      { jobId: `hold-${bookingId}`, delay: Math.max(0, at.getTime() - Date.now()) },
    );
  }

  async scheduleNotification(tenantId: string, notificationId: string, at: Date) {
    await this.cancelNotification(notificationId);
    await this.queues.notifications.add(
      'send',
      { tenantId, notificationId },
      { jobId: `notification-${notificationId}`, delay: Math.max(0, at.getTime() - Date.now()) },
    );
  }

  async cancelNotification(notificationId: string) {
    // remove() is a no-op if the job doesn't exist. If it's running right now,
    // removal fails; that's fine because the worker re-checks the row's status.
    await this.queues.notifications.remove(`notification-${notificationId}`).catch(() => 0);
  }

  async enqueueRefund(tenantId: string, paymentId: string) {
    await this.queues.refunds.add(
      'refund',
      { tenantId, paymentId },
      { jobId: `refund-${paymentId}` },
    );
  }
}
