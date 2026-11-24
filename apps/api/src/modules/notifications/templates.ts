import { formatPaise, HOLD_MINUTES } from '@slotwise/shared';
import { DateTime } from 'luxon';
import type { NotificationType } from '../../db/schema';
import type { OutgoingEmail } from '../../jobs/types';
import { escapeHtml } from '../../mail/html';

interface BookingEmailData {
  businessName: string;
  timezone: string;
  currency: string;
  customerName: string;
  customerEmail: string;
  serviceName: string;
  staffName: string;
  startAt: Date;
  pricePaise: number;
  refundReason: string | null;
  manageUrl: string;
}

/** Times in emails are shown in the BUSINESS's timezone, e.g. "Tue 1 Dec 2026, 9:00 AM GMT+5:30". */
export function formatWhen(d: Date, timezone: string): string {
  return DateTime.fromJSDate(d, { zone: timezone }).toFormat('ccc d LLL yyyy, h:mm a ZZZZ');
}

function layout(
  title: string,
  paragraphs: string[],
  d: BookingEmailData,
): { text: string; html: string } {
  const text = [
    `Hi ${d.customerName},`,
    '',
    ...paragraphs,
    '',
    `Manage your bookings: ${d.manageUrl}`,
    '',
    `— ${d.businessName}`,
  ].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px">
<h2>${escapeHtml(title)}</h2>
<p>Hi ${escapeHtml(d.customerName)},</p>
${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}
<p><a href="${escapeHtml(d.manageUrl)}">Manage your bookings</a></p>
<p style="color:#64748b">— ${escapeHtml(d.businessName)}</p>
</div>`;
  return { text, html };
}

export function renderBookingEmail(type: NotificationType, d: BookingEmailData): OutgoingEmail {
  const when = formatWhen(d.startAt, d.timezone);
  const what = `${d.serviceName} with ${d.staffName}`;
  const price = formatPaise(d.pricePaise, d.currency);
  switch (type) {
    case 'BOOKING_CONFIRMED':
      return {
        to: d.customerEmail,
        subject: `Confirmed: ${d.serviceName} on ${when}`,
        ...layout('Your booking is confirmed', [`${what} on ${when}.`, `Paid: ${price}.`], d),
      };
    case 'BOOKING_REMINDER':
      return {
        to: d.customerEmail,
        subject: `Reminder: ${d.serviceName} tomorrow`,
        ...layout('See you soon', [`This is a reminder of your booking: ${what} on ${when}.`], d),
      };
    case 'BOOKING_CANCELLED':
      return {
        to: d.customerEmail,
        subject: `Cancelled: ${d.serviceName} on ${when}`,
        ...layout(
          'Your booking was cancelled',
          [
            `${what} on ${when} has been cancelled.`,
            d.refundReason
              ? `A full refund of ${price} is on its way (5–7 working days).`
              : 'No refund applies under the cancellation policy.',
          ],
          d,
        ),
      };
    case 'LATE_PAYMENT_REFUNDED':
      return {
        to: d.customerEmail,
        subject: `Refund for your ${d.serviceName} payment`,
        ...layout(
          "We couldn't complete your booking",
          [
            `Your payment for ${what} on ${when} arrived after your ${HOLD_MINUTES}-minute hold ended.`,
            `${d.refundReason ?? 'The slot was no longer available'}. We've started a full refund of ${price} (5–7 working days).`,
          ],
          d,
        ),
      };
  }
}
