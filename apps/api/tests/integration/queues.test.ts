import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { SMTPServer } from 'smtp-server';
import type { Worker } from 'bullmq';
import { createTestApp, loginAs, type TestApp } from '../support/app';
import { createTestTenant } from '../support/factory';
import { bookAndPay } from '../support/payments';
import { RecordingMailer } from '../support/recording-mailer';
import { BullJobs } from '../../src/jobs/bull-jobs';
import { createQueues, type Queues } from '../../src/jobs/queues';
import { startWorkers } from '../../src/jobs/workers';
import { SmtpMailer } from '../../src/mail/mailer';
import { withTenant } from '../../src/db/tenant-tx';

/**
 * Real Redis + real BullMQ. A random key prefix isolates each run.
 */
let redis: Redis;
let queues: Queues;
let jobs: BullJobs;
let t: TestApp;
let workers: Worker[] = [];
const mailer = new RecordingMailer();
const prefix = `test-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  queues = createQueues(redis, prefix);
  jobs = new BullJobs(queues);
  t = await createTestApp({ jobs });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(
    Object.values(queues).map((q) => q.obliterate({ force: true }).then(() => q.close())),
  );
  await t.close();
  redis.disconnect();
});

async function waitFor<T>(
  fn: () => Promise<T | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting');
}

describe('scheduling with BullMQ', () => {
  it('a confirmed booking schedules its reminder 24h before the start', async () => {
    const tenant = await createTestTenant(t.db);
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const { bookingId, startAt } = await bookAndPay(t.app, c, tenant, { days: 5 });
    const reminder = await withTenant(t.db, tenant.tenantId, (tx) =>
      tx.db
        .selectFrom('notifications')
        .select('id')
        .where('booking_id', '=', bookingId)
        .where('type', '=', 'BOOKING_REMINDER')
        .executeTakeFirstOrThrow(),
    );
    const job = await queues.notifications.getJob(`notification-${reminder.id}`);
    expect(job).toBeTruthy();
    expect(await job!.getState()).toBe('delayed');
    const runsAt = job!.timestamp + (job!.delay ?? 0);
    expect(Math.abs(runsAt - (new Date(startAt).getTime() - 86400_000))).toBeLessThan(2000);
  });

  it('rescheduling replaces the reminder job; cancelling removes it', async () => {
    const tenant = await createTestTenant(t.db);
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const { bookingId } = await bookAndPay(t.app, c, tenant, { days: 5 });
    const reminderId = async () =>
      (
        await withTenant(t.db, tenant.tenantId, (tx) =>
          tx.db
            .selectFrom('notifications')
            .select('id')
            .where('booking_id', '=', bookingId)
            .where('type', '=', 'BOOKING_REMINDER')
            .where('status', '=', 'PENDING')
            .executeTakeFirst(),
        )
      )?.id;
    const first = (await reminderId())!;

    const slots = (
      await t.app.inject({
        url: `/public/${tenant.slug}/slots?serviceId=${tenant.service.id}&staffId=${tenant.staff.membershipId}&date=${new Date(Date.now() + 8 * 86400_000).toISOString().slice(0, 10)}`,
      })
    ).json().slots;
    const moved = await c.post(`/bookings/${bookingId}/reschedule`, { startAt: slots[2].startAt });
    expect(moved.statusCode).toBe(200);
    const second = (await reminderId())!;
    expect(second).not.toBe(first);
    expect(await queues.notifications.getJob(`notification-${first}`)).toBeUndefined();
    const job = await queues.notifications.getJob(`notification-${second}`);
    expect(
      Math.abs(job!.timestamp + job!.delay - (new Date(slots[2].startAt).getTime() - 86400_000)),
    ).toBeLessThan(2000);

    await c.post(`/bookings/${bookingId}/cancel`);
    expect(await queues.notifications.getJob(`notification-${second}`)).toBeUndefined();
  });

  it('holding a slot schedules its expiry job just after 10 minutes', async () => {
    const tenant = await createTestTenant(t.db);
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const slots = (
      await t.app.inject({
        url: `/public/${tenant.slug}/slots?serviceId=${tenant.service.id}&staffId=${tenant.staff.membershipId}&date=${new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10)}`,
      })
    ).json().slots;
    const b = (
      await c.post('/bookings/hold', {
        serviceId: tenant.service.id,
        staffId: tenant.staff.membershipId,
        startAt: slots[0].startAt,
      })
    ).json();
    const job = await queues.holds.getJob(`hold-${b.id}`);
    expect(job!.delay).toBeGreaterThan(9.9 * 60_000);
    expect(job!.delay).toBeLessThanOrEqual(10 * 60_000 + 1000);
  });
});

describe('workers (end to end through Redis)', () => {
  beforeAll(() => {
    workers = startWorkers(
      {
        db: t.db,
        mailer,
        jobs,
        payments: t.payments,
        webOrigin: 'http://localhost:5173',
        log: console,
      },
      redis,
      prefix,
    );
  });

  it('sends the confirmation email', async () => {
    const tenant = await createTestTenant(t.db);
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    await bookAndPay(t.app, c, tenant, { days: 5 });
    const email = await waitFor(async () =>
      mailer.sent.find((e) => e.to === tenant.customer.email),
    );
    expect(email.subject).toMatch(/^Confirmed/);
  });

  it('expires a hold when its job fires', async () => {
    const tenant = await createTestTenant(t.db);
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const slots = (
      await t.app.inject({
        url: `/public/${tenant.slug}/slots?serviceId=${tenant.service.id}&staffId=${tenant.staff.membershipId}&date=${new Date(Date.now() + 6 * 86400_000).toISOString().slice(0, 10)}`,
      })
    ).json().slots;
    const b = (
      await c.post('/bookings/hold', {
        serviceId: tenant.service.id,
        staffId: tenant.staff.membershipId,
        startAt: slots[0].startAt,
      })
    ).json();
    await withTenant(t.db, tenant.tenantId, (tx) =>
      tx.db
        .updateTable('bookings')
        .set({ hold_expires_at: sql`now() - interval '1 second'` })
        .where('id', '=', b.id)
        .execute(),
    );
    await queues.holds.remove(`hold-${b.id}`);
    await jobs.scheduleHoldExpiry(tenant.tenantId, b.id, new Date());
    await waitFor(async () => (await c.get(`/bookings/${b.id}`)).json().status === 'EXPIRED');
  });

  it('processes a refund', async () => {
    const tenant = await createTestTenant(t.db);
    const c = await loginAs(t.app, tenant.customer.email, tenant.slug);
    const { bookingId } = await bookAndPay(t.app, c, tenant, { days: 7 });
    await c.post(`/bookings/${bookingId}/cancel`);
    await waitFor(
      async () => (await c.get(`/bookings/${bookingId}`)).json().payment.status === 'REFUNDED',
    );
  });

  it('enqueueRefund revives a refund job that used up its retries, and never duplicates', async () => {
    // Separate queues with no running workers, so we control every state change.
    const p2 = `${prefix}-r`;
    const q2 = createQueues(redis, p2);
    const jobs2 = new BullJobs(q2);
    const paymentId = randomUUID();
    const jobId = `refund-${paymentId}`;
    const { Worker } = await import('bullmq');
    try {
      // A refund job with a single attempt, processed by a worker whose provider call fails.
      await q2.refunds.add('refund', { tenantId: 't', paymentId }, { jobId, attempts: 1 });
      const failing = new Worker(
        q2.refunds.name,
        async () => {
          throw new Error('provider down');
        },
        { connection: redis, prefix: p2 },
      );
      await waitFor(async () => (await (await q2.refunds.getJob(jobId))!.getState()) === 'failed');
      await failing.close();

      // BullMQ would silently ignore add() for this id. enqueueRefund retries it instead.
      await jobs2.enqueueRefund('t', paymentId);
      expect(await (await q2.refunds.getJob(jobId))!.getState()).toBe('waiting');
      // Calling again (e.g. the next reconcile run) doesn't create a second job.
      await jobs2.enqueueRefund('t', paymentId);
      expect((await q2.refunds.getJobCounts('waiting')).waiting).toBe(1);
    } finally {
      await Promise.all(
        Object.values(q2).map((q) => q.obliterate({ force: true }).then(() => q.close())),
      );
    }
  });
});

describe('SMTP delivery', () => {
  it('SmtpMailer delivers a real SMTP message', async () => {
    const received: string[] = [];
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, _session, cb) {
        let data = '';
        stream.on('data', (chunk) => (data += chunk));
        stream.on('end', () => {
          received.push(data);
          cb();
        });
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.server.address() as { port: number }).port;
    const m = new SmtpMailer('Slotwise <no-reply@slotwise.local>', { host: '127.0.0.1', port });
    await m.send({
      to: 'someone@test.local',
      subject: 'Hello from Slotwise',
      text: 'hi',
      html: '<p>hi</p>',
    });
    m.close();
    await new Promise<void>((r) => server.close(() => r()));
    expect(received[0]).toContain('Subject: Hello from Slotwise');
  });

  // Runs in CI, where a Mailpit container is available (MAILPIT_URL is set).
  it.skipIf(!process.env.MAILPIT_URL)('emails appear in Mailpit', async () => {
    const subject = `Mailpit check ${randomUUID()}`;
    const m = new SmtpMailer('Slotwise <no-reply@slotwise.local>', {
      host: 'localhost',
      port: 1025,
    });
    await m.send({ to: 'someone@test.local', subject, text: 'hi', html: '<p>hi</p>' });
    m.close();
    const found = await waitFor(async () => {
      const res = await fetch(
        `${process.env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`,
      );
      const body = (await res.json()) as { messages_count: number };
      return body.messages_count > 0;
    });
    expect(found).toBe(true);
  });
});
