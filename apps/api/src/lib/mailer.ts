import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from '../config';
import type { OutgoingEmail } from '../jobs/types';

export interface Mailer {
  send(email: OutgoingEmail): Promise<void>;
}

/**
 * Sends email over SMTP. Locally that's Mailpit (http://localhost:8025 shows
 * every email). In production, point SMTP_* at Resend/SES/Postmark.
 */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    private readonly from: string,
    options: { host: string; port: number; user?: string | undefined; pass?: string | undefined },
  ) {
    this.transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.port === 465,
      auth: options.user ? { user: options.user, pass: options.pass ?? '' } : undefined,
    });
  }

  async send(email: OutgoingEmail) {
    await this.transport.sendMail({ from: this.from, ...email });
  }

  close() {
    this.transport.close();
  }
}

export function createMailer(config: Config): SmtpMailer {
  return new SmtpMailer(config.EMAIL_FROM, {
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    user: config.SMTP_USER,
    pass: config.SMTP_PASS,
  });
}
