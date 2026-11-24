import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { buildOpenApiDocument, operations } from '../../src/openapi/spec';
import { createTestApp, type TestApp } from '../support/app';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const key = (method: string, url: string) => `${method.toUpperCase()} ${url}`;

describe('API documentation (OpenAPI)', () => {
  it('documents every route the app serves, and nothing that does not exist', () => {
    const served = new Set(
      t.app.routeList
        .filter((r) => !['HEAD', 'OPTIONS'].includes(r.method) && !r.url.startsWith('/docs'))
        .map((r) => key(r.method, r.url)),
    );
    const documented = new Set(operations.map((o) => key(o.method, o.path)));
    expect(
      [...served].filter((r) => !documented.has(r)),
      'undocumented routes',
    ).toEqual([]);
    expect(
      [...documented].filter((r) => !served.has(r)),
      'documented but missing',
    ).toEqual([]);
  });

  it('is a valid OpenAPI 3.1 document', async () => {
    const doc = structuredClone(buildOpenApiDocument());
    await expect(SwaggerParser.validate(doc as never)).resolves.toBeTruthy();
  });

  it('docs/openapi.json is up to date (run: pnpm --filter @slotwise/api openapi)', () => {
    const committed = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../docs/openapi.json'), 'utf8'),
    );
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });

  it('marks writes as needing the CSRF header and public routes as open', () => {
    const doc = buildOpenApiDocument();
    const paths = doc.paths as Record<string, Record<string, { security: unknown[] }>>;
    expect(paths['/bookings/hold']!.post!.security).toEqual([{ session: [], csrf: [] }]);
    expect(paths['/bookings/mine']!.get!.security).toEqual([{ session: [] }]);
    expect(paths['/public/{slug}/slots']!.get!.security).toEqual([]);
  });

  it('serves the interactive docs locally, with their own strict CSP', async () => {
    // "/docs" redirects relatively, so "/api/docs" works through the web proxy too.
    const bare = await t.app.inject({ method: 'GET', url: '/docs' });
    expect(bare.statusCode).toBe(302);
    expect(bare.headers.location).toBe('docs/');
    const res = await t.app.inject({ method: 'GET', url: '/docs/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('./static/swagger-ui.css'); // relative asset paths
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain('validator.swagger.io'); // no calls to outside servers
    expect(csp).not.toContain('upgrade-insecure-requests');
    const json = await t.app.inject({ method: 'GET', url: '/docs/json' });
    expect(json.json().info.title).toBe('Slotwise API');
  });

  it('does not serve the docs in production unless explicitly enabled', async () => {
    const prod = await createTestApp({
      config: {
        ...loadConfig(),
        NODE_ENV: 'production',
        ALLOW_MOCK_PAYMENTS: 'true',
        API_DOCS: undefined,
      },
    });
    try {
      expect((await prod.app.inject({ method: 'GET', url: '/docs/json' })).statusCode).toBe(404);
    } finally {
      await prod.close();
    }
  });
});
