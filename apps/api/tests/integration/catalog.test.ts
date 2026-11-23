import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { createTestApp, loginAs, type Client, type TestApp } from '../helpers/app';
import { createTestTenant, type TestTenant } from '../helpers/factory';

let t: TestApp;
let A: TestTenant;
let B: TestTenant;
let ownerA: Client;

/** A date 3 days from now in Asia/Kolkata, as YYYY-MM-DD. */
const futureDate = (days = 3) => DateTime.now().setZone('Asia/Kolkata').plus({ days }).toISODate()!;

beforeAll(async () => {
  t = await createTestApp();
  A = await createTestTenant(t.db);
  B = await createTestTenant(t.db);
  ownerA = await loginAs(t.app, A.owner.email, A.slug);
});
afterAll(() => t.close());

describe('services CRUD (owner)', () => {
  it('creates, updates and deletes a service, writing audit entries', async () => {
    const created = await ownerA.post('/services', {
      name: 'Beard trim',
      durationMinutes: 15,
      pricePaise: 20000,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const updated = await ownerA.patch(`/services/${id}`, { pricePaise: 25000 });
    expect(updated.json()).toMatchObject({ id, pricePaise: 25000, name: 'Beard trim' });

    expect((await ownerA.delete(`/services/${id}`)).statusCode).toBe(200);
    expect((await ownerA.patch(`/services/${id}`, { name: 'x' })).statusCode).toBe(404);

    const audit = await ownerA.get(`/audit-logs?entity=service`);
    const actions = audit
      .json()
      .logs.filter((l: { entityId: string }) => l.entityId === id)
      .map((l: { action: string }) => l.action);
    expect(actions).toEqual(['service.delete', 'service.update', 'service.create']);
    const update = audit
      .json()
      .logs.find(
        (l: { action: string; entityId: string }) =>
          l.action === 'service.update' && l.entityId === id,
      );
    expect(update.before.pricePaise).toBe(20000);
    expect(update.after.pricePaise).toBe(25000);
    expect(update.actor.email).toBe(A.owner.email);
  });

  it('validates input', async () => {
    const res = await ownerA.post('/services', { name: '', durationMinutes: 2, pricePaise: 10.5 });
    expect(res.statusCode).toBe(400);
    expect(
      res
        .json()
        .error.details.map((d: { path: string }) => d.path)
        .sort(),
    ).toEqual(['durationMinutes', 'name', 'pricePaise']);
  });

  it('staff can list services but not change them; customers can do neither', async () => {
    const staff = await loginAs(t.app, A.staff.email, A.slug);
    expect((await staff.get('/services')).statusCode).toBe(200);
    expect(
      (await staff.post('/services', { name: 'x', durationMinutes: 30, pricePaise: 1000 }))
        .statusCode,
    ).toBe(403);
    const customer = await loginAs(t.app, A.customer.email, A.slug);
    expect((await customer.get('/services')).statusCode).toBe(403);
  });
});

describe('cross-tenant access over HTTP returns 404 (never 403)', () => {
  it("owner A cannot touch tenant B's service, staff or availability by id", async () => {
    expect((await ownerA.patch(`/services/${B.service.id}`, { name: 'hacked' })).statusCode).toBe(
      404,
    );
    expect((await ownerA.delete(`/services/${B.service.id}`)).statusCode).toBe(404);
    expect((await ownerA.get(`/staff/${B.staff.membershipId}/availability`)).statusCode).toBe(404);
    expect(
      (await ownerA.put(`/staff/${B.staff.membershipId}/availability`, { rules: [] })).statusCode,
    ).toBe(404);
    expect(
      (
        await ownerA.post(`/staff/${B.staff.membershipId}/time-off`, {
          startAt: '2030-01-01T00:00:00Z',
          endAt: '2030-01-02T00:00:00Z',
        })
      ).statusCode,
    ).toBe(404);
    expect((await ownerA.delete(`/staff/${B.staff.membershipId}`)).statusCode).toBe(404);
    // Attaching another tenant's service to my own staff member.
    expect(
      (await ownerA.put(`/staff/${A.staff.membershipId}/services`, { serviceIds: [B.service.id] }))
        .statusCode,
    ).toBe(404);
  });

  it('malformed ids are 404, not 500', async () => {
    expect((await ownerA.patch('/services/not-a-uuid', { name: 'x' })).statusCode).toBe(404);
  });
});

describe('availability and time off', () => {
  it('owner sets working hours; public slots follow them', async () => {
    const tenant = await createTestTenant(t.db);
    const owner = await loginAs(t.app, tenant.owner.email, tenant.slug);
    const date = futureDate();
    const weekday = DateTime.fromISO(date).weekday;

    const res = await owner.put(`/staff/${tenant.staff.membershipId}/availability`, {
      rules: [
        { weekday, start: '10:00', end: '12:00' },
        { weekday, start: '14:00', end: '15:00' },
      ],
    });
    expect(res.statusCode).toBe(200);

    const read = await owner.get(`/staff/${tenant.staff.membershipId}/availability`);
    expect(read.json().rules).toEqual([
      { weekday, start: '10:00', end: '12:00' },
      { weekday, start: '14:00', end: '15:00' },
    ]);

    const slots = await t.app.inject({
      url: `/public/${tenant.slug}/slots?serviceId=${tenant.service.id}&staffId=${tenant.staff.membershipId}&date=${date}`,
    });
    expect(slots.statusCode).toBe(200);
    expect(slots.json().slots).toHaveLength(6); // 4 in the morning + 2 after lunch
    expect(slots.json().timezone).toBe('Asia/Kolkata');
  });

  it('rejects overlapping working hours on the same day', async () => {
    const res = await ownerA.put(`/staff/${A.staff.membershipId}/availability`, {
      rules: [
        { weekday: 1, start: '09:00', end: '12:00' },
        { weekday: 1, start: '11:00', end: '13:00' },
      ],
    });
    expect(res.statusCode).toBe(400);
  });

  it('time off removes slots, and deleting it brings them back', async () => {
    const tenant = await createTestTenant(t.db);
    const owner = await loginAs(t.app, tenant.owner.email, tenant.slug);
    const date = futureDate(4);
    const url = `/public/${tenant.slug}/slots?serviceId=${tenant.service.id}&staffId=${tenant.staff.membershipId}&date=${date}`;
    const before = (await t.app.inject({ url })).json().slots.length;
    expect(before).toBe(16); // 09:00-17:00, 30 min

    const day = DateTime.fromISO(date, { zone: 'Asia/Kolkata' });
    const off = await owner.post(`/staff/${tenant.staff.membershipId}/time-off`, {
      startAt: day.set({ hour: 9 }).toISO(),
      endAt: day.set({ hour: 13 }).toISO(),
      reason: 'Dentist',
    });
    expect(off.statusCode).toBe(201);
    expect((await t.app.inject({ url })).json().slots).toHaveLength(8);

    expect((await owner.delete(`/time-off/${off.json().id}`)).statusCode).toBe(200);
    expect((await t.app.inject({ url })).json().slots).toHaveLength(16);
  });

  it('staff can read their own hours but not a colleague’s', async () => {
    const staff = await loginAs(t.app, A.staff.email, A.slug);
    expect((await staff.get(`/staff/${A.staff.membershipId}/availability`)).statusCode).toBe(200);
    expect((await staff.get(`/staff/${A.owner.membershipId}/availability`)).statusCode).toBe(404);
  });
});

describe('public booking page', () => {
  it('shows active services and bookable staff, without emails', async () => {
    const res = await t.app.inject({ url: `/public/${A.slug}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenant.slug).toBe(A.slug);
    expect(body.services.map((s: { id: string }) => s.id)).toContain(A.service.id);
    expect(body.staff).toEqual([
      { membershipId: A.staff.membershipId, name: expect.any(String), serviceIds: [A.service.id] },
    ]);
    expect(JSON.stringify(body)).not.toContain('@');
  });

  it('hides a deactivated service and refuses slots for it', async () => {
    const tenant = await createTestTenant(t.db);
    const owner = await loginAs(t.app, tenant.owner.email, tenant.slug);
    await owner.patch(`/services/${tenant.service.id}`, { active: false });
    const page = (await t.app.inject({ url: `/public/${tenant.slug}` })).json();
    expect(page.services).toEqual([]);
    const slots = await t.app.inject({
      url: `/public/${tenant.slug}/slots?serviceId=${tenant.service.id}&staffId=${tenant.staff.membershipId}&date=${futureDate()}`,
    });
    expect(slots.statusCode).toBe(404);
  });

  it('refuses slots for a staff member who does not offer the service', async () => {
    const res = await t.app.inject({
      url: `/public/${A.slug}/slots?serviceId=${A.service.id}&staffId=${A.owner.membershipId}&date=${futureDate()}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('unknown business → 404; bad query → 400', async () => {
    expect((await t.app.inject({ url: '/public/does-not-exist' })).statusCode).toBe(404);
    expect((await t.app.inject({ url: `/public/${A.slug}/slots?serviceId=x` })).statusCode).toBe(
      400,
    );
  });

  it('no slots in the past or beyond the booking horizon', async () => {
    const past = DateTime.now().minus({ days: 2 }).toISODate();
    const far = DateTime.now().plus({ days: 90 }).toISODate();
    for (const date of [past, far]) {
      const res = await t.app.inject({
        url: `/public/${A.slug}/slots?serviceId=${A.service.id}&staffId=${A.staff.membershipId}&date=${date}`,
      });
      expect(res.json().slots).toEqual([]);
    }
  });
});

describe('tenant settings', () => {
  it('owner updates the cancellation window; unknown timezone is rejected', async () => {
    const res = await ownerA.patch('/tenant/settings', { cancellationWindowHours: 12 });
    expect(res.json().cancellationWindowHours).toBe(12);
    const bad = await ownerA.patch('/tenant/settings', { timezone: 'Mars/Olympus' });
    expect(bad.statusCode).toBe(400);
  });
});
