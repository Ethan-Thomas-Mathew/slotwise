import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';

/**
 * A throwaway SMTP server for tests: the worker "sends" emails to it, and the
 * test reads them, like a person checking their inbox.
 */
export class Mailbox {
  private readonly messages: { to: string; subject: string; text: string }[] = [];
  private readonly server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData: (stream, _session, callback) => {
      simpleParser(stream)
        .then((mail) => {
          const to = Array.isArray(mail.to) ? mail.to[0]?.text : mail.to?.text;
          this.messages.push({ to: to ?? '', subject: mail.subject ?? '', text: mail.text ?? '' });
          callback();
        })
        .catch(callback);
    },
  });

  start(port: number) {
    return new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => resolve());
    });
  }

  stop() {
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Waits for an email to `to` containing a link with `path` in it, and returns that link. */
  async linkSentTo(to: string, path: string, timeoutMs = 20_000): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (const m of [...this.messages].reverse()) {
        if (!m.to.includes(to)) continue;
        const link = m.text.match(/https?:\/\/\S+/g)?.find((l) => l.includes(path));
        if (link) return link;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`No email with a ${path} link arrived for ${to}`);
  }
}
