import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';

describe('GET /health', () => {
  it('returns ok', async () => {
    const app = await buildApp({ config: loadConfig() });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('unknown routes use the standard error shape', async () => {
    const app = await buildApp({ config: loadConfig() });
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
