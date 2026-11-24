import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { loadConfig } from '../../src/config';
import { sql } from 'kysely';
import { Client, createTestApp, type TestApp } from '../support/app';
import { createTestTenant, TEST_PASSWORD, type TestTenant } from '../support/factory';
import { withTenant } from '../../src/db/tenant-tx';

let t: TestApp;
let tenant: TestTenant;
const u = () => randomUUID().slice(0, 8);

beforeAll(async () => {
  t = await createTestApp();
  tenant = await createTestTenant(t.db);
});
afterAll(() => t.close());

function signupBody(overrides: Record<string, unknown> = {}) {
  const id = u();
  return {
    businessName: `Biz ${id}`,
    slug: `biz-${id}`,
    name: 'Owner Person',
    email: `owner-${id}@test.local`,
    password: 'supersecret1',
    ...overrides,
  };
}

describe('owner signup', () => {
  it('creates tenant + owner in one go and logs them in', async () => {
    const c = new Client(t.app);
    const body = signupBody();
    const res = await c.post('/auth/signup', body);
    expect(res.statusCode).toBe(201);
    const me = res.json();
    expect(me.user.email).toBe(body.email);
    expect(me.activeTenant).toMatchObject({
      slug: body.slug,
      role: 'OWNER',
      timezone: 'Asia/Kolkata',
    });
    expect(res.cookies.find((ck) => ck.name === 'sid')).toMatchObject({
      httpOnly: true,
      sameSite: 'Lax',
    });

    const again = await c.get('/auth/me');
    expect(again.statusCode).toBe(200);

    const audit = await withTenant(t.db, me.activeTenant.id, (tx) =>
      tx.db.selectFrom('audit_logs').select(['action', 'actor_user_id']).execute(),
    );
    expect(audit).toEqual([{ action: 'tenant.create', actor_user_id: me.user.id }]);
  });

  it('rejects a taken slug with 409', async () => {
    const res = await new Client(t.app).post('/auth/signup', signupBody({ slug: tenant.slug }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });

  it('rejects a taken email with 409 and creates no tenant (atomic)', async () => {
    const body = signupBody({ email: tenant.owner.email });
    const res = await new Client(t.app).post('/auth/signup', body);
    expect(res.statusCode).toBe(409);
    const exists = await t.db
      .selectFrom('tenants')
      .select('id')
      .where('slug', '=', body.slug)
      .executeTakeFirst();
    expect(exists).toBeUndefined();
  });

  it('returns field-level validation errors', async () => {
    const res = await new Client(t.app).post(
      '/auth/signup',
      signupBody({ slug: 'Bad Slug!', password: 'short' }),
    );
    expect(res.statusCode).toBe(400);
    const paths = res.json().error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['slug', 'password']));
  });
});

describe('login / logout / me', () => {
  it('logs in and lands in the right tenant', async () => {
    const c = new Client(t.app);
    const me = await c.login(tenant.owner.email);
    expect(me.activeTenant).toMatchObject({ id: tenant.tenantId, role: 'OWNER' });
  });

  it('gives the same error for unknown email and wrong password', async () => {
    const a = await new Client(t.app).post('/auth/login', {
      email: `nobody-${u()}@test.local`,
      password: 'x',
    });
    const b = await new Client(t.app).post('/auth/login', {
      email: tenant.staff.email,
      password: 'wrong',
    });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().error.message).toBe(b.json().error.message);
  });

  it('/auth/me is 401 without a session', async () => {
    const res = await new Client(t.app).get('/auth/me');
    expect(res.statusCode).toBe(401);
  });

  it('logout deletes the session', async () => {
    const c = new Client(t.app);
    await c.login(tenant.customer.email);
    const oldCookie = c.cookie;
    expect((await c.post('/auth/logout')).statusCode).toBe(200);
    // Even if someone kept the old cookie, it no longer works.
    const res = await t.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: oldCookie! },
    });
    expect(res.statusCode).toBe(401);
  });

  it('stores only a hash of the session token', async () => {
    const c = new Client(t.app);
    await c.login(tenant.customer.email);
    const raw = c.cookie!.replace('sid=', '');
    const row = await t.db
      .selectFrom('sessions')
      .select('id')
      .where('id', '=', raw)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });
});

describe('CSRF protection', () => {
  it('rejects a logged-in write without the CSRF header', async () => {
    const c = new Client(t.app);
    await c.login(tenant.customer.email);
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: c.cookie! },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_FAILED');
  });

  it('rejects a write from another website (Origin check)', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { email: tenant.owner.email, password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('customer registration and switching business', () => {
  it('registering from a booking page joins that business as CUSTOMER', async () => {
    const c = new Client(t.app);
    const res = await c.post('/auth/register', {
      name: 'New Customer',
      email: `cust-${u()}@test.local`,
      password: 'supersecret1',
      tenantSlug: tenant.slug,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().activeTenant).toMatchObject({ id: tenant.tenantId, role: 'CUSTOMER' });
  });

  it('switching to a business you are not in is 404 unless joining as customer', async () => {
    const other = await createTestTenant(t.db);
    const c = new Client(t.app);
    await c.login(tenant.customer.email);
    expect((await c.post('/auth/active-tenant', { slug: other.slug })).statusCode).toBe(404);
    const joined = await c.post('/auth/active-tenant', { slug: other.slug, joinAsCustomer: true });
    expect(joined.statusCode).toBe(200);
    expect(joined.json().activeTenant).toMatchObject({ id: other.tenantId, role: 'CUSTOMER' });
    expect(joined.json().memberships).toHaveLength(2);
  });
});

describe('password reset', () => {
  it('full flow: email link → new password works, old one and old sessions do not', async () => {
    const reg = new Client(t.app);
    const email = `reset-${u()}@test.local`;
    await reg.post('/auth/register', { name: 'R', email, password: 'oldpassword1' });

    const res = await new Client(t.app).post('/auth/forgot-password', { email });
    expect(res.statusCode).toBe(200);
    const token = t.jobs.tokenFromLastEmail(email);

    const reset = await new Client(t.app).post('/auth/reset-password', {
      token,
      password: 'newpassword1',
    });
    expect(reset.statusCode).toBe(200);

    expect((await reg.get('/auth/me')).statusCode).toBe(401); // logged out everywhere
    expect(
      (await new Client(t.app).post('/auth/login', { email, password: 'oldpassword1' })).statusCode,
    ).toBe(401);
    expect(
      (await new Client(t.app).post('/auth/login', { email, password: 'newpassword1' })).statusCode,
    ).toBe(200);

    // A reset link works only once.
    const reuse = await new Client(t.app).post('/auth/reset-password', {
      token,
      password: 'another12345',
    });
    expect(reuse.statusCode).toBe(400);
  });

  it('does not reveal whether an email exists', async () => {
    const before = t.jobs.emails.length;
    const res = await new Client(t.app).post('/auth/forgot-password', {
      email: `ghost-${u()}@test.local`,
    });
    expect(res.statusCode).toBe(200);
    expect(t.jobs.emails.length).toBe(before);
  });

  it('rejects an expired token', async () => {
    const email = `exp-${u()}@test.local`;
    await new Client(t.app).post('/auth/register', { name: 'E', email, password: 'oldpassword1' });
    await new Client(t.app).post('/auth/forgot-password', { email });
    const token = t.jobs.tokenFromLastEmail(email);
    await t.db
      .updateTable('auth_tokens')
      .set({ expires_at: sql`now() - interval '1 minute'` })
      .where('email', '=', email)
      .execute();
    const res = await new Client(t.app).post('/auth/reset-password', {
      token,
      password: 'newpassword1',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('staff invites', () => {
  it('owner invites a new person; they accept and become STAFF', async () => {
    const owner = new Client(t.app);
    await owner.login(tenant.owner.email);
    const email = `newstaff-${u()}@test.local`;
    expect((await owner.post('/staff/invites', { email, name: 'New Staff' })).statusCode).toBe(201);

    const token = t.jobs.tokenFromLastEmail(email);
    const preview = await new Client(t.app).get(`/auth/invites/${token}`);
    expect(preview.json()).toMatchObject({ email, userExists: false });

    const staff = new Client(t.app);
    const res = await staff.post('/auth/accept-invite', {
      token,
      name: 'New Staff',
      password: 'staffpass123',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().activeTenant).toMatchObject({ id: tenant.tenantId, role: 'STAFF' });

    // Invite tokens are single-use.
    const again = await new Client(t.app).post('/auth/accept-invite', {
      token,
      name: 'X',
      password: 'staffpass123',
    });
    expect(again.statusCode).toBe(404);
  });

  it('an existing customer must prove their password; a wrong one does not burn the invite', async () => {
    const owner = new Client(t.app);
    await owner.login(tenant.owner.email);
    await owner.post('/staff/invites', { email: tenant.customer.email, name: 'Promoted' });
    const token = t.jobs.tokenFromLastEmail(tenant.customer.email);

    const wrong = await new Client(t.app).post('/auth/accept-invite', {
      token,
      password: 'wrong-password',
    });
    expect(wrong.statusCode).toBe(401);
    const ok = await new Client(t.app).post('/auth/accept-invite', {
      token,
      password: TEST_PASSWORD,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().activeTenant.role).toBe('STAFF');
  });

  it('returns the invite link to the owner so it can be shared without email', async () => {
    const owner = new Client(t.app);
    await owner.login(tenant.owner.email);
    const email = `linkstaff-${u()}@test.local`;
    const res = await owner.post('/staff/invites', { email, name: 'Link Staff' });
    expect(res.statusCode).toBe(201);
    const link: string = res.json().inviteLink;
    expect(link).toMatch(/^http:\/\/localhost:5173\/accept-invite\?token=/);
    // It's the same link that was emailed, and it works.
    const token = decodeURIComponent(link.split('token=')[1]!);
    expect(token).toBe(t.jobs.tokenFromLastEmail(email));
    const accepted = await new Client(t.app).post('/auth/accept-invite', {
      token,
      name: 'Link Staff',
      password: 'staffpass123',
    });
    expect(accepted.json().activeTenant.role).toBe('STAFF');
  });

  it('staff and customers cannot invite', async () => {
    const other = await createTestTenant(t.db);
    for (const email of [other.staff.email, other.customer.email]) {
      const c = new Client(t.app);
      await c.login(email, TEST_PASSWORD, other.slug);
      const res = await c.post('/staff/invites', { email: `x-${u()}@test.local`, name: 'X' });
      expect(res.statusCode).toBe(403);
    }
  });
});

describe('rate limiting (Redis-backed, like production)', () => {
  it('allows 5 login attempts per 15 minutes per IP + email, then 429', async () => {
    const redis = new Redis(process.env.REDIS_URL!);
    const rt = await createTestApp({ redis });
    try {
      const email = `brute-${u()}@test.local`;
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await new Client(rt.app).post('/auth/login', { email, password: 'guess' + i });
        codes.push(res.statusCode);
      }
      expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
      // A different email from the same IP is not blocked.
      const other = await new Client(rt.app).post('/auth/login', {
        email: `other-${u()}@test.local`,
        password: 'x',
      });
      expect(other.statusCode).toBe(401);
    } finally {
      await rt.close();
      await redis.quit();
    }
  });

  it('behind a proxy, limits each client separately, and each reset token separately', async () => {
    // Docker runs the API behind nginx: every request arrives from nginx's address.
    const rt = await createTestApp({ config: { ...loadConfig(), TRUST_PROXY_HOPS: 1 } });
    try {
      const resetFrom = (ip: string, token: string) =>
        rt.app.inject({
          method: 'POST',
          url: '/auth/reset-password',
          remoteAddress: '172.18.0.5',
          headers: { 'x-forwarded-for': ip },
          payload: { token, password: 'newpassword123' },
        });
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await resetFrom('203.0.113.7', 'stolen')).statusCode);
      expect(codes.at(-1)).toBe(429);
      // Someone else, through the same nginx, is not affected...
      expect((await resetFrom('198.51.100.9', 'stolen')).statusCode).not.toBe(429);
      // ...and neither is the same person with a different reset link.
      expect((await resetFrom('203.0.113.7', 'another')).statusCode).not.toBe(429);
    } finally {
      await rt.close();
    }
  });

  it('without a trusted proxy, ignores X-Forwarded-For (a client cannot pick its own address)', async () => {
    const rt = await createTestApp({ config: { ...loadConfig(), TRUST_PROXY_HOPS: 0 } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await rt.app.inject({
          method: 'POST',
          url: '/auth/reset-password',
          headers: { 'x-forwarded-for': `203.0.113.${i}` },
          payload: { token: 'same', password: 'newpassword123' },
        });
        codes.push(res.statusCode);
      }
      expect(codes.at(-1)).toBe(429);
    } finally {
      await rt.close();
    }
  });
});
