import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client, createTestApp, loginAs, type TestApp } from '../helpers/app';
import { createTestTenant, type TestTenant } from '../helpers/factory';

/**
 * Role matrix: for every protected route, which roles get in?
 * "allowed" means the guard let the request through (any status except 401/403;
 * e.g. a 404 for a made-up id still proves the guard passed).
 */
let t: TestApp;
let T: TestTenant;
const clients: Record<string, Client> = {};

beforeAll(async () => {
  t = await createTestApp();
  T = await createTestTenant(t.db);
  clients.OWNER = await loginAs(t.app, T.owner.email, T.slug);
  clients.STAFF = await loginAs(t.app, T.staff.email, T.slug);
  clients.CUSTOMER = await loginAs(t.app, T.customer.email, T.slug);
  clients.ANONYMOUS = new Client(t.app);
});
afterAll(() => t.close());

type Role = 'OWNER' | 'STAFF' | 'CUSTOMER';
const fakeId = randomUUID();
const ROUTES: {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  allowed: Role[];
}[] = [
  { method: 'GET', path: '/services', allowed: ['OWNER', 'STAFF'] },
  { method: 'POST', path: '/services', body: {}, allowed: ['OWNER'] },
  { method: 'PATCH', path: '/services/:id', body: {}, allowed: ['OWNER'] },
  { method: 'DELETE', path: '/services/:id', allowed: ['OWNER'] },
  { method: 'GET', path: '/staff', allowed: ['OWNER'] },
  { method: 'POST', path: '/staff/invites', body: {}, allowed: ['OWNER'] },
  { method: 'DELETE', path: '/staff/:id', allowed: ['OWNER'] },
  { method: 'PUT', path: '/staff/:id/services', body: {}, allowed: ['OWNER'] },
  { method: 'GET', path: '/staff/:me/availability', allowed: ['OWNER', 'STAFF'] },
  { method: 'PUT', path: '/staff/:id/availability', body: {}, allowed: ['OWNER'] },
  { method: 'POST', path: '/staff/:id/time-off', body: {}, allowed: ['OWNER'] },
  { method: 'DELETE', path: '/time-off/:id', allowed: ['OWNER'] },
  { method: 'GET', path: '/tenant/settings', allowed: ['OWNER'] },
  { method: 'PATCH', path: '/tenant/settings', body: {}, allowed: ['OWNER'] },
  { method: 'GET', path: '/audit-logs', allowed: ['OWNER'] },
  { method: 'GET', path: '/bookings', allowed: ['OWNER'] },
  { method: 'GET', path: '/bookings/mine', allowed: ['CUSTOMER'] },
  { method: 'POST', path: '/bookings/hold', body: {}, allowed: ['CUSTOMER'] },
  { method: 'GET', path: '/staff/schedule', allowed: ['OWNER', 'STAFF'] },
  { method: 'POST', path: '/payments/order', body: {}, allowed: ['CUSTOMER'] },
  { method: 'POST', path: '/bookings/:id/cancel', allowed: ['OWNER', 'STAFF', 'CUSTOMER'] },
  { method: 'POST', path: '/bookings/:id/complete', allowed: ['OWNER', 'STAFF'] },
  { method: 'POST', path: '/bookings/:id/no-show', allowed: ['OWNER', 'STAFF'] },
  { method: 'GET', path: '/bookings/:id', allowed: ['OWNER', 'STAFF', 'CUSTOMER'] },
];

describe('role matrix', () => {
  for (const route of ROUTES) {
    for (const role of ['OWNER', 'STAFF', 'CUSTOMER', 'ANONYMOUS'] as const) {
      const expectAllowed = role !== 'ANONYMOUS' && route.allowed.includes(role);
      it(`${route.method} ${route.path} — ${role} ${expectAllowed ? 'allowed' : 'blocked'}`, async () => {
        const url = route.path.replace(':id', fakeId).replace(':me', T.staff.membershipId);
        const res = await clients[role]!.request(route.method, url, route.body);
        if (expectAllowed) {
          expect([401, 403]).not.toContain(res.statusCode);
        } else {
          expect(res.statusCode).toBe(role === 'ANONYMOUS' ? 401 : 403);
        }
      });
    }
  }
});
