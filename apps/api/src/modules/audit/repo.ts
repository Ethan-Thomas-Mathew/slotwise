import type { TenantTx } from '../../db/tenant-tx';

interface AuditEntry {
  action: string; // e.g. "service.update"
  entity: string; // e.g. "service"
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Records who changed what. Called inside the SAME transaction as the change,
 * so a change and its audit entry are saved together or not at all.
 */
export async function writeAudit(tx: TenantTx, entry: AuditEntry) {
  await tx.db
    .insertInto('audit_logs')
    .values({
      tenant_id: tx.tenantId,
      actor_user_id: tx.userId,
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entityId ?? null,
      before: entry.before === undefined ? null : JSON.stringify(entry.before),
      after: entry.after === undefined ? null : JSON.stringify(entry.after),
    })
    .execute();
}

export async function listAudit(
  tx: TenantTx,
  filter: { entity?: string; action?: string; before?: Date; limit: number },
) {
  let q = tx.db
    .selectFrom('audit_logs')
    .leftJoin('users', 'users.id', 'audit_logs.actor_user_id')
    .select([
      'audit_logs.id',
      'audit_logs.action',
      'audit_logs.entity',
      'audit_logs.entity_id',
      'audit_logs.before',
      'audit_logs.after',
      'audit_logs.created_at',
      'users.name as actor_name',
      'users.email as actor_email',
    ])
    .where('audit_logs.tenant_id', '=', tx.tenantId);
  if (filter.entity) q = q.where('audit_logs.entity', '=', filter.entity);
  if (filter.action) q = q.where('audit_logs.action', '=', filter.action);
  if (filter.before) q = q.where('audit_logs.created_at', '<', filter.before);
  return q.orderBy('audit_logs.created_at', 'desc').limit(filter.limit).execute();
}
