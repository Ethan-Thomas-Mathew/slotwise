import type { FastifyInstance } from 'fastify';
import { AuditLogDto, AuditLogQuery } from '@slotwise/shared';
import { z } from 'zod';
import type { AppDeps } from '../../app';
import { parse, respond } from '../../http/validation';
import { inTenant, requireRole } from '../../http/auth';
import { listAudit } from './repo';

export async function auditRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get('/audit-logs', { preHandler: requireRole('OWNER') }, async (req) => {
    const q = parse(AuditLogQuery, req.query);
    const rows = await inTenant(db, req, (tx) =>
      listAudit(tx, {
        entity: q.entity,
        action: q.action,
        before: q.before ? new Date(q.before) : undefined,
        limit: q.limit,
      }),
    );
    return respond(z.object({ logs: z.array(AuditLogDto) }), {
      logs: rows.map((r) => ({
        id: r.id,
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        actor: r.actor_name ? { name: r.actor_name, email: r.actor_email! } : null,
        before: r.before,
        after: r.after,
        createdAt: r.created_at.toISOString(),
      })),
    });
  });
}
