import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as StaffRepo from '../../src/modules/staff/repo';
import * as staffRepo from '../../src/modules/staff/repo';
import { createTestApp, loginAs, type TestApp } from '../support/app';
import { createTestTenant, type TestTenant } from '../support/factory';

vi.mock('../../src/modules/staff/repo', async (importOriginal) => {
  const actual = await importOriginal<typeof StaffRepo>();
  return { ...actual, setStaffServices: vi.fn(actual.setStaffServices) };
});

let t: TestApp;
let A: TestTenant;
beforeAll(async () => {
  t = await createTestApp();
  A = await createTestTenant(t.db);
});
afterAll(async () => {
  await t.close();
});

describe('setting a staff member’s services when the database fails', () => {
  it('reports a server error, not "service not found"', async () => {
    const owner = await loginAs(t.app, A.owner.email, A.slug);
    // The database fails mid-request (connection lost, deadlock, ...).
    vi.mocked(staffRepo.setStaffServices).mockRejectedValueOnce(
      Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' }),
    );
    const res = await owner.put(`/staff/${A.staff.membershipId}/services`, {
      serviceIds: [A.service.id],
    });
    expect(res.statusCode).toBe(500);
  });
});
