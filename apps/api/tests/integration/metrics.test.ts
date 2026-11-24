import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registry, startMetricsServer, trackQueueDepth } from '../../src/metrics';
import { createTestApp, type TestApp } from '../support/app';

let t: TestApp;
let server: Server;
let base: string;

beforeAll(async () => {
  t = await createTestApp();
  server = await startMetricsServer(0, '127.0.0.1'); // port 0 = any free port
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await t.close();
});

const metricsText = () => registry.metrics();

describe('metrics server', () => {
  it('listens only where it is told (localhost by default)', () => {
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('serves GET /metrics in Prometheus format', async () => {
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('process_cpu_user_seconds_total');
  });

  it('serves nothing else', async () => {
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/metrics/../admin`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(404);
  });

  it('reports a busy port instead of crashing the process', async () => {
    const port = (server.address() as AddressInfo).port;
    await expect(startMetricsServer(port, '127.0.0.1')).rejects.toThrow(/EADDRINUSE/);
  });

  it('is not reachable through the public API', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(404);
  });
});

describe('what gets recorded', () => {
  it('labels requests by route template, never the raw URL', async () => {
    const id = '00000000-0000-4000-8000-00000000abcd';
    await t.app.inject({ method: 'GET', url: `/bookings/${id}` });
    await t.app.inject({ method: 'GET', url: '/public/no-such-business-xyz' });
    const text = await metricsText();
    expect(text).toMatch(/route="\/bookings\/:id"/);
    expect(text).toMatch(/route="\/public\/:slug"/);
    expect(text).not.toContain(id);
    expect(text).not.toContain('no-such-business-xyz');
  });

  it('unknown URLs share one "unmatched" label (attackers cannot create new series)', async () => {
    await t.app.inject({ method: 'GET', url: '/random-scan-path-123' });
    const text = await metricsText();
    expect(text).toContain('route="unmatched"');
    expect(text).not.toContain('random-scan-path-123');
  });

  it('counts expected errors by code', async () => {
    const before =
      (await registry.getSingleMetric('slotwise_app_errors_total')?.get())?.values.find(
        (v) => v.labels.code === 'UNAUTHENTICATED',
      )?.value ?? 0;
    await t.app.inject({ method: 'GET', url: '/auth/me' });
    const after = (await registry.getSingleMetric('slotwise_app_errors_total')?.get())?.values.find(
      (v) => v.labels.code === 'UNAUTHENTICATED',
    )?.value;
    expect(after).toBe(before + 1);
  });

  it('reports queue depth from each queue, and registering twice is harmless', async () => {
    const fakeQueue = {
      name: 'emails',
      getJobCounts: async () => ({ waiting: 3, active: 1, delayed: 0, failed: 2 }),
    };
    trackQueueDepth([fakeQueue]);
    trackQueueDepth([fakeQueue]);
    const text = await metricsText();
    expect(text).toContain('slotwise_queue_jobs{queue="emails",state="waiting"} 3');
    expect(text).toContain('slotwise_queue_jobs{queue="emails",state="failed"} 2');
  });
});
