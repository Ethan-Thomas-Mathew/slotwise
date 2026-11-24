/**
 * Load test for the booking path.
 *   pnpm bench                                     (20 connections)
 *   pnpm bench -- --concurrency 50 --holds 600 --reads 2000
 *
 * Starts the real API on a random port (real Postgres, real Redis/BullMQ),
 * creates a throwaway business, then fires many concurrent HTTP requests and
 * reports throughput and latency percentiles for:
 *
 *   1. GET  /public/:slug/slots        (the busiest read: every page view)
 *   2. POST /bookings/hold, ONE staff  (every write queues on one calendar lock)
 *   3. POST /bookings/hold, 10 staff   (writes spread across calendars)
 *
 * Comparing 2 and 3 shows what the per-staff advisory lock costs.
 *
 * It prints the machine it ran on and the process's peak memory, so results can
 * be compared and checked. The load generator runs in the same Node process as
 * the API, so the API gets less CPU than it would alone: treat results as a floor.
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { Redis } from 'ioredis';
import { DateTime } from 'luxon';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createDatabase } from '../src/db/database';
import { withTenant } from '../src/db/tenant-tx';
import { BullJobs } from '../src/jobs/bull-jobs';
import { createQueues } from '../src/jobs/queues';
import { hashPassword } from '../src/credentials/passwords';
import { createSession } from '../src/modules/auth/sessions';
import { replaceRules } from '../src/modules/availability/repo';
import { insertMembership } from '../src/modules/memberships/repo';
import { MockPaymentProvider } from '../src/modules/payments/provider';
import { insertService } from '../src/modules/services/repo';
import { setStaffServices } from '../src/modules/staff/repo';
import { insertTenant } from '../src/modules/tenants/repo';
import { insertUser } from '../src/modules/users/repo';

// Command-line options rather than environment variables, so the same command
// works in PowerShell, cmd and bash.
const { values: args } = parseArgs({
  options: {
    concurrency: { type: 'string', default: '20' },
    holds: { type: 'string', default: '600' },
    reads: { type: 'string', default: '2000' },
  },
});
const CONCURRENCY = Number(args.concurrency);
const HOLDS = Number(args.holds);
const READS = Number(args.reads);
const STAFF = 10;

const config = loadConfig({ ...process.env, LOG_LEVEL: 'silent', NODE_ENV: 'development' });
const db = createDatabase(config.DATABASE_URL, { max: CONCURRENCY + 5 });
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const prefix = `bench-${randomUUID().slice(0, 6)}`;
const queues = createQueues(redis, prefix);
const app = await buildApp({
  config,
  db,
  redis,
  jobs: new BullJobs(queues),
  payments: new MockPaymentProvider(config.RAZORPAY_WEBHOOK_SECRET),
});
const address = await app.listen({ port: 0, host: '127.0.0.1' });

// ---------- setup: one business, 10 staff working 24/7, many customers ----------
const tenantId = randomUUID();
const slug = `bench-${tenantId.slice(0, 8)}`;
const customersNeeded = Math.ceil(HOLDS / 3) * 2 + 10; // 3 open holds per customer, 2 scenarios
const passwordHash = await hashPassword('benchmark-password');
const { serviceId, staffIds, customerIds } = await withTenant(db, tenantId, async (tx) => {
  await insertTenant(tx, { name: 'Bench Salon', slug });
  const service = await insertService(tx, { name: 'Cut', durationMinutes: 30, pricePaise: 50000 });
  const staffIds: string[] = [];
  for (let i = 0; i < STAFF; i++) {
    const u = await insertUser(tx, {
      email: `staff${i}-${slug}@bench.local`,
      name: `Staff ${i}`,
      passwordHash,
    });
    const m = await insertMembership(tx, u.id, 'STAFF');
    await setStaffServices(tx, m.id, [service.id]);
    await replaceRules(
      tx,
      m.id,
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })),
    );
    staffIds.push(m.id);
  }
  const customerIds: string[] = [];
  for (let i = 0; i < customersNeeded; i++) {
    const u = await insertUser(tx, {
      email: `c${i}-${slug}@bench.local`,
      name: `Customer ${i}`,
      passwordHash,
    });
    await insertMembership(tx, u.id, 'CUSTOMER');
    customerIds.push(u.id);
  }
  return { serviceId: service.id, staffIds, customerIds };
});

// Sessions are created directly (logging in 400 times would just measure Argon2).
const clients = await Promise.all(
  customerIds.map(async (userId) => {
    const { token } = await createSession(db, userId, tenantId, 1);
    const row = await db
      .selectFrom('sessions')
      .select('csrf_token')
      .orderBy('created_at', 'desc')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    return { cookie: `sid=${token}`, csrf: row.csrf_token };
  }),
);

/** Upcoming slot start times (UTC ISO), 48 per day, starting tomorrow. */
function slotTimes(count: number, dayOffset: number) {
  const day0 = DateTime.now()
    .setZone('Asia/Kolkata')
    .plus({ days: 1 + dayOffset })
    .startOf('day');
  return Array.from({ length: count }, (_, i) =>
    day0
      .plus({ days: Math.floor(i / 48), minutes: (i % 48) * 30 })
      .toUTC()
      .toISO()!,
  );
}

// ---------- tiny load generator ----------
interface Result {
  name: string;
  requests: number;
  seconds: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  statuses: Record<number, number>;
}

async function run(
  name: string,
  total: number,
  makeRequest: (i: number) => Promise<Response>,
): Promise<Result> {
  const latencies: number[] = [];
  const statuses: Record<number, number> = {};
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < total) {
        const i = next++;
        const t0 = performance.now();
        const res = await makeRequest(i);
        await res.arrayBuffer();
        latencies.push(performance.now() - t0);
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const pct = (p: number) =>
    Math.round(
      latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]!,
    );
  return {
    name,
    requests: total,
    seconds: +seconds.toFixed(2),
    rps: Math.round(total / seconds),
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
    statuses,
  };
}

const hold = (clientIndex: number, staffId: string, startAt: string) => {
  const c = clients[clientIndex]!;
  return fetch(`${address}/bookings/hold`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: c.cookie, 'x-csrf-token': c.csrf },
    body: JSON.stringify({ serviceId, staffId, startAt }),
  });
};

// Peak memory of this process while the scenarios run.
let peakRss = 0;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 100);

// Warm up connections and caches.
await run('warm-up', 50, () => fetch(`${address}/health`));

const date = DateTime.now().setZone('Asia/Kolkata').plus({ days: 2 }).toISODate();
const results: Result[] = [];
results.push(
  await run('GET slots (read)', READS, (i) =>
    fetch(
      `${address}/public/${slug}/slots?serviceId=${serviceId}&staffId=${staffIds[i % STAFF]}&date=${date}`,
    ),
  ),
);

// Scenario 2: every hold for the SAME staff member (different slots).
const oneStaffTimes = slotTimes(HOLDS, 0);
results.push(
  await run('POST hold, 1 staff', HOLDS, (i) =>
    hold(Math.floor(i / 3), staffIds[0]!, oneStaffTimes[i]!),
  ),
);

// Scenario 3: holds spread over 10 staff (different customers again).
const offset = Math.ceil(HOLDS / 3) + 5;
const spreadTimes = slotTimes(Math.ceil(HOLDS / STAFF), 20); // later days: no overlap with scenario 2
results.push(
  await run('POST hold, 10 staff', HOLDS, (i) =>
    hold(offset + Math.floor(i / 3), staffIds[i % STAFF]!, spreadTimes[Math.floor(i / STAFF)]!),
  ),
);

clearInterval(sampler);

const { rows: pgRows } = await sql<{
  v: string;
}>`SELECT current_setting('server_version') AS v`.execute(db);
const redisVersion = /redis_version:(\S+)/.exec(await redis.info('server'))?.[1] ?? 'unknown';
const cpus = os.cpus();
const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

console.log(`
Machine:  ${cpus[0]?.model.trim() ?? 'unknown CPU'}, ${cpus.length} logical CPUs, ${mb(os.totalmem())} MB RAM
System:   ${os.type()} ${os.release()} (${os.arch()}), Node ${process.version}, Postgres ${pgRows[0]?.v}, Redis ${redisVersion}
Load:     ${CONCURRENCY} concurrent connections; API, Postgres and Redis on this machine
Memory:   peak ${mb(peakRss)} MB resident (API and load generator share one process)
Date:     ${new Date().toISOString().slice(0, 10)}

| Scenario | Requests | Throughput | p50 | p95 | p99 | Responses |
| --- | --- | --- | --- | --- | --- | --- |
${results
  .map(
    (r) =>
      `| ${r.name} | ${r.requests} | ${r.rps} req/s | ${r.p50} ms | ${r.p95} ms | ${r.p99} ms | ${Object.entries(
        r.statuses,
      )
        .map(([s, n]) => `${n} x ${s}`)
        .join(', ')} |`,
  )
  .join('\n')}
`);

// ---------- clean up ----------
await app.close();
await withTenant(db, tenantId, async (tx) => {
  await tx.db.deleteFrom('bookings').where('tenant_id', '=', tenantId).execute();
});
await db.deleteFrom('sessions').where('active_tenant_id', '=', tenantId).execute();
await Promise.all(
  Object.values(queues).map((q) => q.obliterate({ force: true }).then(() => q.close())),
);
await db.destroy();
redis.disconnect();
