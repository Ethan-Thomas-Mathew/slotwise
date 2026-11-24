import type { TenantTx } from '../../db/tenant-tx';

interface RuleInput {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export async function listRules(tx: TenantTx, staffMembershipId: string) {
  return tx.db
    .selectFrom('availability_rules')
    .select(['id', 'weekday', 'start_minute', 'end_minute'])
    .where('tenant_id', '=', tx.tenantId)
    .where('staff_membership_id', '=', staffMembershipId)
    .orderBy('weekday')
    .orderBy('start_minute')
    .execute();
}

/** Replaces a staff member's whole weekly schedule in one go. */
export async function replaceRules(tx: TenantTx, staffMembershipId: string, rules: RuleInput[]) {
  await tx.db
    .deleteFrom('availability_rules')
    .where('tenant_id', '=', tx.tenantId)
    .where('staff_membership_id', '=', staffMembershipId)
    .execute();
  if (rules.length === 0) return;
  await tx.db
    .insertInto('availability_rules')
    .values(
      rules.map((r) => ({
        tenant_id: tx.tenantId,
        staff_membership_id: staffMembershipId,
        weekday: r.weekday,
        start_minute: r.startMinute,
        end_minute: r.endMinute,
      })),
    )
    .execute();
}

export async function listTimeOff(
  tx: TenantTx,
  staffMembershipId: string,
  range?: { from: Date; to: Date },
) {
  let q = tx.db
    .selectFrom('time_off')
    .select(['id', 'start_at', 'end_at', 'reason'])
    .where('tenant_id', '=', tx.tenantId)
    .where('staff_membership_id', '=', staffMembershipId);
  if (range) q = q.where('end_at', '>', range.from).where('start_at', '<', range.to);
  return q.orderBy('start_at').execute();
}

export async function insertTimeOff(
  tx: TenantTx,
  staffMembershipId: string,
  data: { startAt: Date; endAt: Date; reason?: string | null },
) {
  return tx.db
    .insertInto('time_off')
    .values({
      tenant_id: tx.tenantId,
      staff_membership_id: staffMembershipId,
      start_at: data.startAt,
      end_at: data.endAt,
      reason: data.reason ?? null,
    })
    .returning(['id', 'staff_membership_id', 'start_at', 'end_at', 'reason'])
    .executeTakeFirstOrThrow();
}

export async function deleteTimeOff(tx: TenantTx, id: string) {
  return tx.db
    .deleteFrom('time_off')
    .where('tenant_id', '=', tx.tenantId)
    .where('id', '=', id)
    .returning(['id', 'staff_membership_id', 'start_at', 'end_at', 'reason'])
    .executeTakeFirst();
}
