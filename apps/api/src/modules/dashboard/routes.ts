import type { FastifyInstance } from 'fastify';
import { DashboardSummary } from '@slotwise/shared';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import type { AppDeps } from '../../app';
import { respond } from '../../http/validation';
import { inTenant, requireRole } from '../../http/auth';
import { getTenant } from '../tenants/repo';

const WEEKS = 8;

export async function dashboardRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get('/dashboard/summary', { preHandler: requireRole('OWNER') }, async (req) => {
    const summary = await inTenant(db, req, async (tx) => {
      const tenant = await getTenant(tx);
      // "Today" means today in the business's timezone, not the server's.
      const today = DateTime.now().setZone(tenant.timezone).startOf('day');
      const weekStart = today.startOf('week').minus({ weeks: WEEKS - 1 });

      const counts = await tx.db
        .selectFrom('bookings')
        .select([
          sql<number>`count(*) FILTER (WHERE start_at >= ${today.toJSDate()} AND start_at < ${today.plus({ days: 1 }).toJSDate()} AND status IN ('CONFIRMED','COMPLETED','NO_SHOW'))`.as(
            'today',
          ),
          sql<number>`count(*) FILTER (WHERE start_at > now() AND status = 'CONFIRMED')`.as(
            'upcoming',
          ),
        ])
        .where('tenant_id', '=', tx.tenantId)
        .executeTakeFirstOrThrow();

      // Revenue = money we kept: captured payments, by the week they were paid
      // (weeks start on Monday, in the business's timezone).
      const revenue = await sql<{ week: string; total: number }>`
        SELECT to_char(date_trunc('week', created_at AT TIME ZONE ${tenant.timezone}), 'YYYY-MM-DD') AS week,
               sum(amount_paise)::int AS total
        FROM payments
        WHERE tenant_id = ${tx.tenantId} AND status = 'CAPTURED'
          AND created_at >= ${weekStart.toJSDate()}
        GROUP BY 1`.execute(tx.db);
      const byWeek = new Map(revenue.rows.map((r) => [r.week, r.total]));

      const failed = await tx.db
        .selectFrom('notifications')
        .select(sql<number>`count(*)`.as('n'))
        .where('tenant_id', '=', tx.tenantId)
        .where('status', '=', 'FAILED')
        .executeTakeFirstOrThrow();

      return {
        todayCount: counts.today,
        upcomingCount: counts.upcoming,
        revenueByWeek: Array.from({ length: WEEKS }, (_, i) => {
          const w = weekStart.plus({ weeks: i }).toISODate()!;
          return { weekStart: w, revenuePaise: byWeek.get(w) ?? 0 };
        }),
        failedNotifications: failed.n,
      };
    });
    return respond(DashboardSummary, summary);
  });
}
