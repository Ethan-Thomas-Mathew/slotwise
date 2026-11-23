import { randomUUID } from 'node:crypto';
import type { Database } from '../../src/db/database';
import { withTenant } from '../../src/db/tenant-tx';
import { insertTenant } from '../../src/modules/tenants/repo';
import { insertUser } from '../../src/modules/users/repo';
import { insertMembership } from '../../src/modules/memberships/repo';
import { insertService } from '../../src/modules/services/repo';
import { setStaffServices } from '../../src/modules/staff/repo';
import { replaceRules } from '../../src/modules/availability/repo';

// A pre-computed argon2 hash of "password123" keeps tests fast.
export const TEST_PASSWORD = 'password123';
export const TEST_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$evjTgB/JospOtH55ArDyug$tAvB8ZQ0CPp2ya1gqJhlRxOImHj+tmxgy7KjsZiH/qI';

const uniq = () => randomUUID().slice(0, 8);

export interface TestTenant {
  tenantId: string;
  slug: string;
  owner: { userId: string; membershipId: string; email: string };
  staff: { userId: string; membershipId: string; email: string };
  customer: { userId: string; membershipId: string; email: string };
  service: { id: string; durationMinutes: number; pricePaise: number };
}

/**
 * Creates a complete tenant (owner, one staff member who works 09:00-17:00
 * every day, one customer, one 30-minute service) with a unique slug, so tests
 * never collide with each other.
 */
export async function createTestTenant(
  db: Database,
  opts: { timezone?: string; cancellationWindowHours?: number } = {},
): Promise<TestTenant> {
  const tenantId = randomUUID();
  const slug = `t-${uniq()}`;
  return withTenant(db, tenantId, async (tx) => {
    await insertTenant(tx, { name: `Tenant ${slug}`, slug, timezone: opts.timezone });
    if (opts.cancellationWindowHours !== undefined) {
      await tx.db
        .updateTable('tenants')
        .set({ cancellation_window_hours: opts.cancellationWindowHours })
        .where('id', '=', tenantId)
        .execute();
    }
    const make = async (role: 'OWNER' | 'STAFF' | 'CUSTOMER') => {
      const email = `${role.toLowerCase()}-${uniq()}@test.local`;
      const user = await insertUser(tx, {
        email,
        name: `${role} ${slug}`,
        passwordHash: TEST_PASSWORD_HASH,
      });
      const m = await insertMembership(tx, user.id, role);
      return { userId: user.id, membershipId: m.id, email };
    };
    const owner = await make('OWNER');
    const staff = await make('STAFF');
    const customer = await make('CUSTOMER');
    const service = await insertService(tx, {
      name: 'Haircut',
      durationMinutes: 30,
      pricePaise: 50000,
    });
    await setStaffServices(tx, staff.membershipId, [service.id]);
    await replaceRules(
      tx,
      staff.membershipId,
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })),
    );
    return {
      tenantId,
      slug,
      owner,
      staff,
      customer,
      service: { id: service.id, durationMinutes: 30, pricePaise: 50000 },
    };
  });
}
