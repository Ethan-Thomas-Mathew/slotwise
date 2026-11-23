import { sql } from 'kysely';
import type { TenantTx } from '../../db/tenant-tx';

/**
 * "Staff" = members who can be booked: role STAFF, or the OWNER (a solo
 * salon owner often works too). Customers are never staff.
 */
export async function listStaff(tx: TenantTx) {
  return tx.db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select((eb) => [
      'memberships.id',
      'memberships.role',
      'users.name',
      'users.email',
      eb
        .selectFrom('staff_services')
        .select(sql<string[]>`coalesce(array_agg(service_id), '{}')`.as('ids'))
        .whereRef('staff_services.staff_membership_id', '=', 'memberships.id')
        .as('service_ids'),
    ])
    .where('memberships.tenant_id', '=', tx.tenantId)
    .where('memberships.role', 'in', ['OWNER', 'STAFF'])
    .orderBy('users.name')
    .execute();
}

export async function getStaffMember(tx: TenantTx, membershipId: string) {
  return tx.db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select([
      'memberships.id',
      'memberships.role',
      'memberships.user_id',
      'users.name',
      'users.email',
    ])
    .where('memberships.tenant_id', '=', tx.tenantId)
    .where('memberships.id', '=', membershipId)
    .where('memberships.role', 'in', ['OWNER', 'STAFF'])
    .executeTakeFirst();
}

export async function setStaffServices(tx: TenantTx, membershipId: string, serviceIds: string[]) {
  await tx.db
    .deleteFrom('staff_services')
    .where('tenant_id', '=', tx.tenantId)
    .where('staff_membership_id', '=', membershipId)
    .execute();
  if (serviceIds.length === 0) return;
  // The composite foreign keys reject a service from another tenant.
  await tx.db
    .insertInto('staff_services')
    .values(
      serviceIds.map((service_id) => ({
        tenant_id: tx.tenantId,
        staff_membership_id: membershipId,
        service_id,
      })),
    )
    .execute();
}

/** Everyone who can be booked for this service (owner or staff, and they offer it). */
export async function listStaffIdsForService(tx: TenantTx, serviceId: string) {
  const rows = await tx.db
    .selectFrom('staff_services')
    .innerJoin('memberships', 'memberships.id', 'staff_services.staff_membership_id')
    .select('staff_services.staff_membership_id as id')
    .where('staff_services.tenant_id', '=', tx.tenantId)
    .where('staff_services.service_id', '=', serviceId)
    .where('memberships.role', 'in', ['OWNER', 'STAFF'])
    .orderBy('staff_services.staff_membership_id')
    .execute();
  return rows.map((r) => r.id);
}

export async function staffOffersService(tx: TenantTx, membershipId: string, serviceId: string) {
  const row = await tx.db
    .selectFrom('staff_services')
    .select('service_id')
    .where('tenant_id', '=', tx.tenantId)
    .where('staff_membership_id', '=', membershipId)
    .where('service_id', '=', serviceId)
    .executeTakeFirst();
  return row !== undefined;
}

/** Removing a staff member: only allowed if they have no upcoming active bookings. */
export async function staffHasUpcomingBookings(tx: TenantTx, membershipId: string) {
  const row = await tx.db
    .selectFrom('bookings')
    .select('id')
    .where('tenant_id', '=', tx.tenantId)
    .where('staff_membership_id', '=', membershipId)
    .where('status', 'in', ['HELD', 'CONFIRMED'])
    .where('end_at', '>', new Date())
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

export async function downgradeStaffToCustomer(tx: TenantTx, membershipId: string) {
  // Keep the membership row (old bookings reference it) but remove staff powers.
  await tx.db
    .deleteFrom('staff_services')
    .where('tenant_id', '=', tx.tenantId)
    .where('staff_membership_id', '=', membershipId)
    .execute();
  await tx.db
    .deleteFrom('availability_rules')
    .where('tenant_id', '=', tx.tenantId)
    .where('staff_membership_id', '=', membershipId)
    .execute();
  await tx.db
    .updateTable('memberships')
    .set({ role: 'CUSTOMER' })
    .where('tenant_id', '=', tx.tenantId)
    .where('id', '=', membershipId)
    .where('role', '=', 'STAFF')
    .execute();
}
