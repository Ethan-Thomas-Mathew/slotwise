import type { FastifyInstance } from 'fastify';
import { NotificationDto } from '@slotwise/shared';
import { z } from 'zod';
import type { AppDeps } from '../../app';
import { notFound } from '../../lib/errors';
import { runEffects, type Effects } from '../../lib/effects';
import { idParam } from '../../lib/params';
import { iso, isoOrNull, parse, respond } from '../../lib/validate';
import { inTenant, requireRole } from '../../plugins/auth';
import { writeAudit } from '../audit/repo';
import { listNotifications, retryNotification } from './repo';

const Query = z.object({
  status: z.enum(['FAILED', 'PENDING', 'SENT']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Owners can see emails that failed to send (after all retries) and retry them. */
export async function notificationRoutes(app: FastifyInstance, { db, jobs }: AppDeps) {
  app.get('/notifications', { preHandler: requireRole('OWNER') }, async (req) => {
    const q = parse(Query, req.query);
    const rows = await inTenant(db, req, (tx) => listNotifications(tx, q));
    return respond(z.object({ notifications: z.array(NotificationDto) }), {
      notifications: rows.map((n) => ({
        id: n.id,
        bookingId: n.booking_id,
        type: n.type,
        status: n.status,
        attempts: n.attempts,
        lastError: n.last_error,
        scheduledFor: iso(n.scheduled_for),
        sentAt: isoOrNull(n.sent_at),
      })),
    });
  });

  app.post('/notifications/:id/retry', { preHandler: requireRole('OWNER') }, async (req) => {
    const id = idParam(req, 'id', 'Notification');
    const effects: Effects = [];
    await inTenant(db, req, async (tx) => {
      const n = await retryNotification(tx, id);
      if (!n) throw notFound('Failed notification');
      await writeAudit(tx, { action: 'notification.retry', entity: 'notification', entityId: id });
      const tenantId = tx.tenantId;
      effects.push(() => jobs.scheduleNotification(tenantId, n.id, n.scheduled_for));
    });
    await runEffects(effects, req.log);
    return { ok: true };
  });
}
