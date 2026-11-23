/**
 * Everything the app asks the background job system to do.
 *
 * Code depends on this interface, not on BullMQ directly. Production uses the
 * BullMQ implementation (jobs/bull-jobs.ts); HTTP tests use a recorder
 * (tests/helpers/recording-jobs.ts) so they can assert "a reminder was
 * scheduled" without timing issues.
 */
export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Jobs {
  /** Password reset and staff invite emails (not tied to a booking). */
  sendEmail(email: OutgoingEmail): Promise<void>;
  /** At `at`, expire the hold if it's still HELD. */
  scheduleHoldExpiry(tenantId: string, bookingId: string, at: Date): Promise<void>;
  /** Send the notification row `notificationId` at `at` (replaces any existing job for it). */
  scheduleNotification(tenantId: string, notificationId: string, at: Date): Promise<void>;
  cancelNotification(notificationId: string): Promise<void>;
  /** Ask the payment provider to refund this payment (status REFUND_PENDING). */
  enqueueRefund(tenantId: string, paymentId: string): Promise<void>;
}
