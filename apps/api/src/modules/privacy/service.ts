import { sql } from 'kysely';
import type { DataExport, DeleteAccountRequest } from '@slotwise/shared';
import type { Database } from '../../db/database';
import { withSystem, withTenant, type TenantTx } from '../../db/tenant-tx';
import { AppError } from '../../lib/errors';
import { verifyPassword } from '../../lib/passwords';
import { writeAudit } from '../audit/repo';
import { lockCustomerHolds } from '../bookings/repo';

/**
 * Privacy rights (India's DPDP Act 2023, similar to GDPR):
 *  - a person can download everything we store about them;
 *  - a customer can erase their account.
 *
 * Erasure ANONYMISES instead of deleting rows, because each business must keep
 * its booking and payment records for its accounts. After erasure nothing left
 * in the database says who the person was.
 */

const iso = (d: Date) => d.toISOString();

export async function exportMyData(db: Database, userId: string): Promise<DataExport> {
  const { user, memberships } = await withSystem(
    db,
    async (tx) => ({
      user: await tx.db
        .selectFrom('users')
        .select(['id', 'name', 'email', 'created_at'])
        .where('id', '=', userId)
        .executeTakeFirstOrThrow(),
      memberships: await tx.db
        .selectFrom('memberships')
        .innerJoin('tenants', 'tenants.id', 'memberships.tenant_id')
        .select([
          'memberships.id',
          'memberships.role',
          'memberships.created_at',
          'tenants.id as tenantId',
          'tenants.name as tenantName',
          'tenants.slug as tenantSlug',
        ])
        .where('memberships.user_id', '=', userId)
        .orderBy('tenants.name')
        .execute(),
    }),
    { userId },
  );

  const bookings: DataExport['bookings'] = [];
  for (const m of memberships) {
    // Each business's data is read inside that business's RLS context.
    const rows = await withTenant(db, m.tenantId, (tx) =>
      tx.db
        .selectFrom('bookings as b')
        .innerJoin('services as s', 's.id', 'b.service_id')
        .innerJoin('memberships as sm', 'sm.id', 'b.staff_membership_id')
        .innerJoin('users as su', 'su.id', 'sm.user_id')
        .select([
          'b.id',
          'b.start_at',
          'b.end_at',
          'b.status',
          'b.price_paise',
          'b.created_at',
          's.name as service',
          'su.name as staff',
          (eb) =>
            eb
              .selectFrom('payments as p')
              .select(
                sql<
                  { amountPaise: number; currency: string; status: string; createdAt: string }[]
                >`coalesce(json_agg(json_build_object(
                    'amountPaise', p.amount_paise, 'currency', p.currency,
                    'status', p.status, 'createdAt', p.created_at) ORDER BY p.created_at), '[]')`.as(
                  'x',
                ),
              )
              .whereRef('p.booking_id', '=', 'b.id')
              .as('payments'),
        ])
        .where('b.customer_membership_id', '=', m.id)
        .orderBy('b.start_at', 'desc')
        .execute(),
    );
    for (const r of rows) {
      bookings.push({
        id: r.id,
        business: m.tenantName,
        service: r.service,
        staff: r.staff,
        startAt: iso(r.start_at),
        endAt: iso(r.end_at),
        status: r.status,
        pricePaise: r.price_paise,
        createdAt: iso(r.created_at),
        payments: (r.payments ?? []).map((p) => ({
          amountPaise: p.amountPaise,
          currency: p.currency,
          status: p.status as DataExport['bookings'][number]['payments'][number]['status'],
          createdAt: new Date(p.createdAt).toISOString(),
        })),
      });
    }
  }

  return {
    exportedAt: new Date().toISOString(),
    user: { id: user.id, name: user.name, email: user.email, createdAt: iso(user.created_at) },
    memberships: memberships.map((m) => ({
      business: m.tenantName,
      bookingLink: `/b/${m.tenantSlug}`,
      role: m.role,
      joinedAt: iso(m.created_at),
    })),
    bookings,
  };
}

/** Points the open transaction at one tenant (for RLS), like withTenant does. */
async function useTenant(trx: TenantTx['db'], tenantId: string, userId: string): Promise<TenantTx> {
  await sql`SELECT set_config('app.tenant_id', ${tenantId}, true),
                   set_config('app.user_id', ${userId}, true)`.execute(trx);
  return { db: trx, tenantId, userId };
}

/**
 * Erases a customer's account. Safeguards:
 *  - the password must be entered again (a stolen, still-open laptop session isn't enough);
 *  - owners and active staff are refused: a business can't lose its owner, and staff
 *    must first be removed from the team by the owner;
 *  - anyone with upcoming bookings is refused until they cancel (so refunds happen);
 *  - everything happens in ONE transaction, with an audit entry in each business.
 */
export async function deleteMyAccount(
  db: Database,
  userId: string,
  input: DeleteAccountRequest,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.tenant_id', '', true),
                     set_config('app.user_id', ${userId}, true)`.execute(trx);

    // Lock the user row so two delete requests can't run at the same time.
    const user = await trx
      .selectFrom('users')
      .select(['email', 'password_hash', 'deleted_at'])
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (!user || user.deleted_at) throw new AppError('NOT_FOUND', 'Account not found');
    if (!(await verifyPassword(user.password_hash, input.password))) {
      throw new AppError('FORBIDDEN', 'That password is not correct');
    }

    const memberships = await trx
      .selectFrom('memberships')
      .innerJoin('tenants', 'tenants.id', 'memberships.tenant_id')
      .select(['memberships.id', 'memberships.role', 'memberships.tenant_id', 'tenants.name'])
      .where('memberships.user_id', '=', userId)
      .execute();

    const managing = memberships.find((m) => m.role !== 'CUSTOMER');
    if (managing) {
      throw new AppError(
        'CONFLICT',
        managing.role === 'OWNER'
          ? `You own ${managing.name}. A business can't be left without its owner, so this account can't be deleted here.`
          : `You're on the team at ${managing.name}. Ask the owner to remove you from the team first.`,
      );
    }

    for (const m of memberships) {
      const tx = await useTenant(trx, m.tenant_id, userId);
      // Waits for any hold in progress for this customer, so it is counted below.
      await lockCustomerHolds(tx, m.id);
      const upcoming = await tx.db
        .selectFrom('bookings')
        .select('id')
        .where('customer_membership_id', '=', m.id)
        .where('status', 'in', ['HELD', 'CONFIRMED'])
        .where('end_at', '>', new Date())
        .executeTakeFirst();
      if (upcoming) {
        throw new AppError(
          'CONFLICT',
          `You have an upcoming booking with ${m.name}. Cancel it first, so any refund can be made.`,
        );
      }
      // No name or email here: the entry must not undo the erasure.
      await writeAudit(tx, {
        action: 'customer.account_deleted',
        entity: 'membership',
        entityId: m.id,
      });
    }

    await sql`SELECT set_config('app.tenant_id', '', true)`.execute(trx);
    await sql`SELECT app_redact_email_in_audit(${user.email})`.execute(trx);
    await trx
      .updateTable('users')
      .set({
        name: 'Deleted user',
        email: `deleted-${userId}@deleted.invalid`,
        password_hash: '!deleted', // not a valid hash: no password can ever match
        deleted_at: new Date(),
      })
      .where('id', '=', userId)
      .execute();
    await trx.deleteFrom('sessions').where('user_id', '=', userId).execute();
    await trx
      .deleteFrom('auth_tokens')
      .where((eb) => eb.or([eb('user_id', '=', userId), eb('email', '=', user.email)]))
      .execute();
  });
}
