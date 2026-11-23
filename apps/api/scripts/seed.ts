/**
 * Seeds two demo tenants with owners, staff, services, working hours and
 * customers. Safe to run more than once: existing tenants are skipped.
 *
 *   pnpm db:seed
 *
 * Demo logins (password for all: "password123"):
 *   Glow Salon      owner@glow.demo  | staff: asha@glow.demo, ravi@glow.demo
 *   Sunrise Physio  owner@sunrise.demo | staff: meera@sunrise.demo
 *   Customer (both) customer@demo.test
 */
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/db/database';
import { withSystem, withTenant } from '../src/db/tenant-tx';
import { hashPassword } from '../src/lib/passwords';
import { findTenantBySlug, insertTenant } from '../src/modules/tenants/repo';
import { findUserByEmail, insertUser } from '../src/modules/users/repo';
import { insertMembership } from '../src/modules/memberships/repo';
import { insertService } from '../src/modules/services/repo';
import { setStaffServices } from '../src/modules/staff/repo';
import { replaceRules } from '../src/modules/availability/repo';

const PASSWORD = 'password123';

interface SeedTenant {
  name: string;
  slug: string;
  owner: { email: string; name: string; worksToo: boolean };
  staff: { email: string; name: string }[];
  services: { name: string; durationMinutes: number; pricePaise: number }[];
  weekdays: number[]; // 1 = Monday
  hours: [number, number]; // minutes after midnight
}

const TENANTS: SeedTenant[] = [
  {
    name: 'Glow Salon',
    slug: 'glow-salon',
    owner: { email: 'owner@glow.demo', name: 'Priya Nair', worksToo: true },
    staff: [
      { email: 'asha@glow.demo', name: 'Asha Kumar' },
      { email: 'ravi@glow.demo', name: 'Ravi Shetty' },
    ],
    services: [
      { name: "Women's haircut", durationMinutes: 45, pricePaise: 80000 },
      { name: "Men's haircut", durationMinutes: 30, pricePaise: 40000 },
      { name: 'Hair colour', durationMinutes: 90, pricePaise: 250000 },
    ],
    weekdays: [2, 3, 4, 5, 6, 7], // closed Mondays
    hours: [10 * 60, 19 * 60],
  },
  {
    name: 'Sunrise Physio Clinic',
    slug: 'sunrise-clinic',
    owner: { email: 'owner@sunrise.demo', name: 'Dr. Arjun Rao', worksToo: false },
    staff: [{ email: 'meera@sunrise.demo', name: 'Dr. Meera Iyer' }],
    services: [
      { name: 'Initial assessment', durationMinutes: 60, pricePaise: 150000 },
      { name: 'Follow-up session', durationMinutes: 30, pricePaise: 90000 },
    ],
    weekdays: [1, 2, 3, 4, 5],
    hours: [9 * 60, 17 * 60],
  },
];

const CUSTOMER = { email: 'customer@demo.test', name: 'Kiran Customer' };

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL (or MIGRATION_DATABASE_URL)');
  const db = createDatabase(url, { max: 2 });
  const passwordHash = await hashPassword(PASSWORD);

  // Users are global (one login across tenants).
  const ensureUser = (email: string, name: string) =>
    withSystem(db, async (tx) => {
      return (await findUserByEmail(tx, email)) ?? insertUser(tx, { email, name, passwordHash });
    });

  const customer = await ensureUser(CUSTOMER.email, CUSTOMER.name);

  for (const t of TENANTS) {
    if (await findTenantBySlug(db, t.slug)) {
      console.log(`- ${t.slug} already exists, skipping`);
      continue;
    }
    const owner = await ensureUser(t.owner.email, t.owner.name);
    const staffUsers = await Promise.all(t.staff.map((s) => ensureUser(s.email, s.name)));

    await withTenant(db, randomUUID(), async (tx) => {
      await insertTenant(tx, { name: t.name, slug: t.slug });
      const ownerM = await insertMembership(tx, owner.id, 'OWNER');
      const staffMs = await Promise.all(staffUsers.map((u) => insertMembership(tx, u.id, 'STAFF')));
      await insertMembership(tx, customer.id, 'CUSTOMER');

      const services = [];
      for (const s of t.services) services.push(await insertService(tx, s));
      const workers = t.owner.worksToo ? [ownerM, ...staffMs] : staffMs;
      for (const m of workers) {
        await setStaffServices(
          tx,
          m.id,
          services.map((s) => s.id),
        );
        await replaceRules(
          tx,
          m.id,
          t.weekdays.map((weekday) => ({
            weekday,
            startMinute: t.hours[0],
            endMinute: t.hours[1],
          })),
        );
      }
    });
    console.log(`+ created ${t.slug}`);
  }

  await db.destroy();
  console.log(`Done. Every demo account's password is "${PASSWORD}".`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
