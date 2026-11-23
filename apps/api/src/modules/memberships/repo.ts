import type { MembershipRole } from '../../db/schema';
import type { SystemTx, TenantTx } from '../../db/tenant-tx';

export async function insertMembership(tx: TenantTx, userId: string, role: MembershipRole) {
  return tx.db
    .insertInto('memberships')
    .values({ tenant_id: tx.tenantId, user_id: userId, role })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function findMembership(tx: TenantTx, userId: string) {
  return tx.db
    .selectFrom('memberships')
    .selectAll()
    .where('tenant_id', '=', tx.tenantId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
}

export async function getMembershipById(tx: TenantTx, id: string) {
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
    .where('memberships.id', '=', id)
    .executeTakeFirst();
}

/**
 * All tenants this user belongs to. Works without a tenant context thanks to
 * the own_memberships_read RLS policy (requires app.user_id to be set).
 */
export async function listMyMemberships(tx: SystemTx | TenantTx, userId: string) {
  return tx.db
    .selectFrom('memberships')
    .innerJoin('tenants', 'tenants.id', 'memberships.tenant_id')
    .select([
      'memberships.id as membershipId',
      'memberships.role',
      'tenants.id as tenantId',
      'tenants.name as tenantName',
      'tenants.slug as tenantSlug',
    ])
    .where('memberships.user_id', '=', userId)
    .orderBy('tenants.name')
    .execute();
}
