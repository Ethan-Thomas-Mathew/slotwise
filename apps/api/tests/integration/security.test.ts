import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';
import { buildApp } from '../../src/app';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

describe('HTTP hardening', () => {
  it('sends security headers', async () => {
    const res = await t.app.inject({ url: '/health' });
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('CORS allows only the configured frontend origin, with credentials', async () => {
    const ok = await t.app.inject({
      method: 'OPTIONS',
      url: '/auth/login',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await t.app.inject({
      method: 'OPTIONS',
      url: '/auth/login',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects oversized request bodies (413)', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(200 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
  });

  it('never leaks internal error details', async () => {
    const app = await buildApp(t.deps);
    app.get('/boom', async () => {
      throw new Error('connection to postgres://admin:secret@db failed');
    });
    const res = await app.inject({ url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' },
    });
    expect(res.body).not.toContain('secret');
    await app.close();
  });
});
