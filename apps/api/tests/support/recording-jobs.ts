import type { Jobs, OutgoingEmail } from '../../src/jobs/types';

/** A fake job system that just remembers what it was asked to do. */
export class RecordingJobs implements Jobs {
  emails: OutgoingEmail[] = [];
  holdExpiries: { tenantId: string; bookingId: string; at: Date }[] = [];
  notifications = new Map<string, { tenantId: string; at: Date }>();
  cancelledNotifications: string[] = [];
  refunds: { tenantId: string; paymentId: string }[] = [];

  async sendEmail(email: OutgoingEmail) {
    this.emails.push(email);
  }
  async scheduleHoldExpiry(tenantId: string, bookingId: string, at: Date) {
    this.holdExpiries.push({ tenantId, bookingId, at });
  }
  async scheduleNotification(tenantId: string, notificationId: string, at: Date) {
    this.notifications.set(notificationId, { tenantId, at });
  }
  async cancelNotification(notificationId: string) {
    this.notifications.delete(notificationId);
    this.cancelledNotifications.push(notificationId);
  }
  async enqueueRefund(tenantId: string, paymentId: string) {
    this.refunds.push({ tenantId, paymentId });
  }

  /** Finds the last email sent to `to` and pulls the token out of its link. */
  tokenFromLastEmail(to: string): string {
    const email = [...this.emails].reverse().find((e) => e.to === to.toLowerCase());
    const match = email?.text.match(/token=([A-Za-z0-9_\-%]+)/);
    if (!match) throw new Error(`No token email for ${to}`);
    return decodeURIComponent(match[1]!);
  }
}
