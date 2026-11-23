import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { MeResponse } from '@slotwise/shared';
import type { Database } from '../../db/database';
import { PG, pgConstraint, pgErrorCode } from '../../db/pg-errors';
import { withSystem, withTenant } from '../../db/tenant-tx';
import type { Jobs } from '../../jobs/types';
import { AppError } from '../../lib/errors';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../../lib/passwords';
import { hashToken, newToken } from '../../lib/tokens';
import { writeAudit } from '../audit/repo';
import { findMembership, insertMembership, listMyMemberships } from '../memberships/repo';
import { findTenantBySlug, getTenant, insertTenant } from '../tenants/repo';
import { findUserByEmail, insertUser, updatePassword } from '../users/repo';
import { passwordResetEmail, staffInviteEmail } from './emails';
import { deleteAllSessionsForUser, type AuthContext } from './sessions';

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function conflictFromUniqueViolation(err: unknown): never {
  if (pgErrorCode(err) === PG.UNIQUE_VIOLATION) {
    const c = pgConstraint(err) ?? '';
    if (c.includes('slug')) throw new AppError('CONFLICT', 'That booking link is already taken');
    if (c.includes('email'))
      throw new AppError('CONFLICT', 'An account with this email already exists');
  }
  throw err;
}

/** Signup = new tenant + new user + OWNER membership, all in ONE transaction. */
export async function signupOwner(
  db: Database,
  input: {
    businessName: string;
    slug: string;
    timezone: string;
    name: string;
    email: string;
    password: string;
  },
) {
  const passwordHash = await hashPassword(input.password);
  const tenantId = randomUUID();
  try {
    return await withTenant(db, tenantId, async (tx) => {
      if (await findUserByEmail(tx, input.email)) {
        throw new AppError(
          'CONFLICT',
          'An account with this email already exists. Log in instead.',
        );
      }
      const tenant = await insertTenant(tx, {
        name: input.businessName,
        slug: input.slug,
        timezone: input.timezone,
      });
      const user = await insertUser(tx, { email: input.email, name: input.name, passwordHash });
      await insertMembership(tx, user.id, 'OWNER');
      await writeAudit(
        { ...tx, userId: user.id },
        {
          action: 'tenant.create',
          entity: 'tenant',
          entityId: tenant.id,
          after: { name: tenant.name, slug: tenant.slug },
        },
      );
      return { userId: user.id, tenantId: tenant.id };
    });
  } catch (err) {
    conflictFromUniqueViolation(err);
  }
}

/** Customer registration, optionally joining a business straight away. */
export async function registerCustomer(
  db: Database,
  input: { name: string; email: string; password: string; tenantSlug?: string | undefined },
) {
  const passwordHash = await hashPassword(input.password);
  let user;
  try {
    user = await withSystem(db, async (tx) => {
      if (await findUserByEmail(tx, input.email)) {
        throw new AppError(
          'CONFLICT',
          'An account with this email already exists. Log in instead.',
        );
      }
      return insertUser(tx, { email: input.email, name: input.name, passwordHash });
    });
  } catch (err) {
    conflictFromUniqueViolation(err);
  }
  let tenantId: string | null = null;
  if (input.tenantSlug) {
    tenantId = await joinTenant(db, user.id, input.tenantSlug, { joinAsCustomer: true });
  }
  return { userId: user.id, tenantId };
}

export async function login(db: Database, email: string, password: string) {
  const user = await withSystem(db, (tx) => findUserByEmail(tx, email));
  if (!user) {
    await burnPasswordCheck(password);
    // Same message whether the email or the password was wrong.
    throw new AppError('UNAUTHENTICATED', 'Email or password is incorrect');
  }
  if (!(await verifyPassword(user.password_hash, password))) {
    throw new AppError('UNAUTHENTICATED', 'Email or password is incorrect');
  }
  return user;
}

/** Picks a sensible business to land in after login: owner/staff first. */
export async function defaultTenantFor(db: Database, userId: string): Promise<string | null> {
  const ms = await withSystem(db, (tx) => listMyMemberships(tx, userId), { userId });
  const rank = { OWNER: 0, STAFF: 1, CUSTOMER: 2 } as const;
  ms.sort((a, b) => rank[a.role] - rank[b.role]);
  return ms[0]?.tenantId ?? null;
}

/**
 * Makes `slug` the user's active business. If they aren't a member yet and
 * `joinAsCustomer` is true, they become a customer there.
 */
export async function joinTenant(
  db: Database,
  userId: string,
  slug: string,
  opts: { joinAsCustomer: boolean },
): Promise<string> {
  const tenant = await findTenantBySlug(db, slug);
  if (!tenant) throw new AppError('NOT_FOUND', 'Business not found');
  await withTenant(
    db,
    tenant.id,
    async (tx) => {
      const existing = await findMembership(tx, userId);
      if (existing) return;
      if (!opts.joinAsCustomer) throw new AppError('NOT_FOUND', 'Business not found');
      try {
        await insertMembership(tx, userId, 'CUSTOMER');
      } catch (err) {
        // Two tabs joining at the same time: the second one hits the unique key. Fine.
        if (pgErrorCode(err) !== PG.UNIQUE_VIOLATION) throw err;
      }
    },
    { userId },
  );
  return tenant.id;
}

export async function buildMe(db: Database, auth: AuthContext): Promise<MeResponse> {
  const memberships = await withSystem(db, (tx) => listMyMemberships(tx, auth.user.id), {
    userId: auth.user.id,
  });
  let activeTenant: MeResponse['activeTenant'] = null;
  if (auth.activeTenantId && auth.membership) {
    const t = await withTenant(db, auth.activeTenantId, (tx) => getTenant(tx));
    activeTenant = {
      id: t.id,
      name: t.name,
      slug: t.slug,
      timezone: t.timezone,
      currency: t.currency,
      cancellationWindowHours: t.cancellation_window_hours,
      bookingHorizonDays: t.booking_horizon_days,
      role: auth.membership.role,
      membershipId: auth.membership.id,
    };
  }
  return { user: auth.user, csrfToken: auth.csrfToken, activeTenant, memberships };
}

// ---------- Password reset ----------

export async function requestPasswordReset(
  db: Database,
  jobs: Jobs,
  email: string,
  webOrigin: string,
) {
  const user = await withSystem(db, (tx) => findUserByEmail(tx, email));
  // Always behave the same, so this endpoint can't be used to discover accounts.
  if (!user) return;
  const token = newToken();
  await db
    .insertInto('auth_tokens')
    .values({
      type: 'PASSWORD_RESET',
      token_hash: hashToken(token),
      email: user.email,
      user_id: user.id,
      expires_at: new Date(Date.now() + RESET_TTL_MS),
    })
    .execute();
  const link = `${webOrigin}/reset-password?token=${encodeURIComponent(token)}`;
  await jobs.sendEmail(passwordResetEmail(user.email, link));
}

/** Atomically "uses up" a one-time token. Returns it only if valid, unused and unexpired. */
async function consumeToken(db: Database, type: 'PASSWORD_RESET' | 'STAFF_INVITE', token: string) {
  return db
    .updateTable('auth_tokens')
    .set({ used_at: sql`now()` })
    .where('token_hash', '=', hashToken(token))
    .where('type', '=', type)
    .where('used_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .returningAll()
    .executeTakeFirst();
}

export async function resetPassword(db: Database, token: string, newPassword: string) {
  const passwordHash = await hashPassword(newPassword);
  const row = await consumeToken(db, 'PASSWORD_RESET', token);
  if (!row?.user_id)
    throw new AppError('VALIDATION_ERROR', 'This reset link is invalid or has expired');
  await withSystem(db, (tx) => updatePassword(tx, row.user_id!, passwordHash));
  await deleteAllSessionsForUser(db, row.user_id);
}

// ---------- Staff invites ----------

export async function inviteStaff(
  db: Database,
  jobs: Jobs,
  ctx: { tenantId: string; userId: string },
  input: { email: string; name: string },
  webOrigin: string,
) {
  const email = input.email.toLowerCase();
  const token = newToken();
  const tenant = await withTenant(
    db,
    ctx.tenantId,
    async (tx) => {
      const t = await getTenant(tx);
      // Already staff/owner here? Then there's nothing to invite.
      const existingUser = await findUserByEmail(tx, email);
      if (existingUser) {
        const m = await findMembership(tx, existingUser.id);
        if (m && m.role !== 'CUSTOMER')
          throw new AppError('CONFLICT', 'This person is already on your team');
      }
      await tx.db
        .insertInto('auth_tokens')
        .values({
          type: 'STAFF_INVITE',
          token_hash: hashToken(token),
          email,
          tenant_id: ctx.tenantId,
          expires_at: new Date(Date.now() + INVITE_TTL_MS),
        })
        .execute();
      await writeAudit(tx, {
        action: 'staff.invite',
        entity: 'staff_invite',
        after: { email, name: input.name },
      });
      return t;
    },
    { userId: ctx.userId },
  );
  const link = `${webOrigin}/accept-invite?token=${encodeURIComponent(token)}`;
  await jobs.sendEmail(staffInviteEmail(email, input.name, tenant.name, link));
}

export async function previewInvite(db: Database, token: string) {
  const row = await db
    .selectFrom('auth_tokens')
    .innerJoin('tenants', 'tenants.id', 'auth_tokens.tenant_id')
    .select(['auth_tokens.email', 'tenants.name as tenantName'])
    .where('auth_tokens.token_hash', '=', hashToken(token))
    .where('auth_tokens.type', '=', 'STAFF_INVITE')
    .where('auth_tokens.used_at', 'is', null)
    .where('auth_tokens.expires_at', '>', sql<Date>`now()`)
    .executeTakeFirst();
  if (!row) throw new AppError('NOT_FOUND', 'This invite is invalid or has expired');
  const user = await withSystem(db, (tx) => findUserByEmail(tx, row.email));
  return { tenantName: row.tenantName, email: row.email, userExists: Boolean(user) };
}

/**
 * Accepting an invite:
 * - new email → create the account with the given name + password
 * - existing account → must prove it's theirs with their current password
 * Then they become STAFF in that tenant (a customer there is upgraded).
 */
export async function acceptInvite(
  db: Database,
  input: { token: string; name?: string | undefined; password: string },
) {
  // Validate first WITHOUT using the token, so a wrong password doesn't burn the invite.
  const preview = await previewInvite(db, input.token);
  let user = await withSystem(db, (tx) => findUserByEmail(tx, preview.email));
  if (user) {
    if (!(await verifyPassword(user.password_hash, input.password))) {
      throw new AppError('UNAUTHENTICATED', 'Password is incorrect for this existing account');
    }
  } else if (!input.name || input.password.length < 8) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Name and a password of at least 8 characters are required',
    );
  }

  const passwordHash = user ? null : await hashPassword(input.password);
  const row = await consumeToken(db, 'STAFF_INVITE', input.token);
  if (!row?.tenant_id) throw new AppError('NOT_FOUND', 'This invite is invalid or has expired');
  const tenantId = row.tenant_id;

  if (!user) {
    try {
      user = await withSystem(db, (tx) =>
        insertUser(tx, { email: row.email, name: input.name!, passwordHash: passwordHash! }),
      );
    } catch (err) {
      conflictFromUniqueViolation(err);
    }
  }
  const userId = user.id;
  await withTenant(
    db,
    tenantId,
    async (tx) => {
      const m = await findMembership(tx, userId);
      if (!m) {
        await insertMembership(tx, userId, 'STAFF');
      } else if (m.role === 'CUSTOMER') {
        await tx.db
          .updateTable('memberships')
          .set({ role: 'STAFF' })
          .where('tenant_id', '=', tx.tenantId)
          .where('id', '=', m.id)
          .execute();
      }
      await writeAudit(tx, {
        action: 'staff.join',
        entity: 'membership',
        entityId: m?.id ?? null,
        after: { email: row.email },
      });
    },
    { userId },
  );
  return { userId, tenantId };
}
