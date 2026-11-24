import type { FastifyInstance } from 'fastify';
import { TenantSettingsPatch } from '@slotwise/shared';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { AppDeps } from '../../app';
import type { Tenant } from '../../db/schema';
import { AppError } from '../../http/errors';
import { parse, respond } from '../../http/validation';
import { inTenant, requireRole } from '../../http/auth';
import { writeAudit } from '../audit/repo';
import { getTenant, updateTenantSettings } from './repo';

export const TenantSettings = z.object({
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  currency: z.string(),
  cancellationWindowHours: z.number().int(),
  bookingHorizonDays: z.number().int(),
});

const toDto = (t: Tenant) => ({
  name: t.name,
  slug: t.slug,
  timezone: t.timezone,
  currency: t.currency,
  cancellationWindowHours: t.cancellation_window_hours,
  bookingHorizonDays: t.booking_horizon_days,
});

export async function tenantRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get('/tenant/settings', { preHandler: requireRole('OWNER') }, async (req) => {
    return respond(TenantSettings, toDto(await inTenant(db, req, (tx) => getTenant(tx))));
  });

  app.patch('/tenant/settings', { preHandler: requireRole('OWNER') }, async (req) => {
    const body = parse(TenantSettingsPatch, req.body);
    if (body.timezone && !DateTime.local().setZone(body.timezone).isValid) {
      throw new AppError('VALIDATION_ERROR', 'Unknown timezone', [
        { path: 'timezone', message: 'Unknown timezone' },
      ]);
    }
    const updated = await inTenant(db, req, async (tx) => {
      const before = await getTenant(tx);
      const after = await updateTenantSettings(tx, {
        name: body.name,
        timezone: body.timezone,
        cancellation_window_hours: body.cancellationWindowHours,
        booking_horizon_days: body.bookingHorizonDays,
      });
      await writeAudit(tx, {
        action: 'tenant.settings.update',
        entity: 'tenant',
        entityId: tx.tenantId,
        before: toDto(before),
        after: toDto(after),
      });
      return after;
    });
    return respond(TenantSettings, toDto(updated));
  });
}
