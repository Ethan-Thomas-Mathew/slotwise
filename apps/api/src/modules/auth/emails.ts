import type { OutgoingEmail } from '../../jobs/types';
import { escapeHtml } from '../../mail/html';

export function passwordResetEmail(to: string, link: string): OutgoingEmail {
  return {
    to,
    subject: 'Reset your Slotwise password',
    text: `Someone asked to reset your Slotwise password.\n\nReset it here (valid for 1 hour): ${link}\n\nIf this wasn't you, ignore this email.`,
    html: `<p>Someone asked to reset your Slotwise password.</p>
<p><a href="${escapeHtml(link)}">Reset your password</a> (valid for 1 hour).</p>
<p>If this wasn't you, ignore this email.</p>`,
  };
}

export function staffInviteEmail(
  to: string,
  inviteeName: string,
  businessName: string,
  link: string,
): OutgoingEmail {
  return {
    to,
    subject: `You're invited to join ${businessName} on Slotwise`,
    text: `Hi ${inviteeName},\n\n${businessName} has invited you to join their team on Slotwise.\n\nAccept the invite (valid for 7 days): ${link}`,
    html: `<p>Hi ${escapeHtml(inviteeName)},</p>
<p>${escapeHtml(businessName)} has invited you to join their team on Slotwise.</p>
<p><a href="${escapeHtml(link)}">Accept the invite</a> (valid for 7 days).</p>`,
  };
}
