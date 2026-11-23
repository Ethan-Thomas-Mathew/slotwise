import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { createTestApp, type TestApp } from '../helpers/app';

let t: TestApp;
let redis: Redis;
beforeAll(async () => {
  redis = new Redis(process.env.REDIS_URL!);
  t = await createTestApp({ redis });
});
afterAll(async () => {
  await t.close();
  await redis.quit();
});

describe('ops endpoints', () => {
  it('GET /health is ok', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('GET /ready checks the database and Redis', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/ready' });
    expect(res.json()).toEqual({ status: 'ok', checks: { database: 'ok', redis: 'ok' } });
  });

  it('unknown routes use the standard error shape', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('malformed JSON is a 400 in the standard shape', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{bad json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});
