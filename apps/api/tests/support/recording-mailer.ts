import type { OutgoingEmail } from '../../src/jobs/types';
import type { Mailer } from '../../src/mail/mailer';

export class RecordingMailer implements Mailer {
  sent: OutgoingEmail[] = [];
  /** Number of upcoming send() calls that should fail. */
  failures = 0;

  async send(email: OutgoingEmail) {
    if (this.failures > 0) {
      this.failures--;
      throw new Error('SMTP connection refused');
    }
    this.sent.push(email);
  }
}
