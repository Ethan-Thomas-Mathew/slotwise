import type { FastifyInstance } from 'fastify';
import {
  OpenDaysQuery,
  OpenDaysResponse,
  PublicTenantResponse,
  Slug,
  SlotsQuery,
  SlotsResponse,
} from '@slotwise/shared';
import type { AppDeps } from '../../app';
import { withTenant } from '../../db/tenant-tx';
import { notFound } from '../../http/errors';
import { parse, respond } from '../../http/validation';
import {
  findOpenDays,
  findOpenDaysAnyStaff,
  findSlots,
  findSlotsAnyStaff,
} from '../availability/service';
import { toServiceDto } from '../services/routes';
import { listServices } from '../services/repo';
import { listStaff } from '../staff/repo';
import { findTenantBySlug } from '../tenants/repo';

/** Unauthenticated endpoints behind a business's public booking page /b/{slug}. */
export async function publicRoutes(app: FastifyInstance, { db }: AppDeps) {
  async function tenantFromSlug(raw: unknown) {
    const slug = Slug.safeParse(raw);
    const tenant = slug.success ? await findTenantBySlug(db, slug.data) : undefined;
    if (!tenant) throw notFound('Business');
    return tenant;
  }

  app.get('/public/:slug', async (req) => {
    const tenant = await tenantFromSlug((req.params as { slug: string }).slug);
    const { services, staff } = await withTenant(db, tenant.id, async (tx) => ({
      services: await listServices(tx, { activeOnly: true }),
      staff: await listStaff(tx),
    }));
    const activeIds = new Set(services.map((s) => s.id));
    return respond(PublicTenantResponse, {
      tenant: {
        name: tenant.name,
        slug: tenant.slug,
        timezone: tenant.timezone,
        currency: tenant.currency,
        cancellationWindowHours: tenant.cancellation_window_hours,
        bookingHorizonDays: tenant.booking_horizon_days,
      },
      services: services.map(toServiceDto),
      // Only people who actually offer something are shown. No emails on public pages.
      staff: staff
        .map((s) => ({
          membershipId: s.id,
          name: s.name,
          serviceIds: (s.service_ids ?? []).filter((id) => activeIds.has(id)),
        }))
        .filter((s) => s.serviceIds.length > 0),
    });
  });

  app.get('/public/:slug/slots', async (req) => {
    const tenant = await tenantFromSlug((req.params as { slug: string }).slug);
    const q = parse(SlotsQuery, req.query);
    const result = await withTenant(db, tenant.id, (tx) =>
      q.staffId === 'any'
        ? findSlotsAnyStaff(tx, { serviceId: q.serviceId, date: q.date })
        : findSlots(tx, { serviceId: q.serviceId, staffId: q.staffId, date: q.date }),
    );
    return respond(SlotsResponse, {
      date: q.date,
      timezone: result.timezone,
      slots: result.slots.map((s) => ({
        startAt: s.startAt.toISOString(),
        endAt: s.endAt.toISOString(),
      })),
    });
  });

  /** Open-slot counts per day, so the date picker can show closed/full days. */
  app.get('/public/:slug/days', async (req) => {
    const tenant = await tenantFromSlug((req.params as { slug: string }).slug);
    const q = parse(OpenDaysQuery, req.query);
    return respond(
      OpenDaysResponse,
      await withTenant(db, tenant.id, (tx) =>
        q.staffId === 'any'
          ? findOpenDaysAnyStaff(tx, { serviceId: q.serviceId, from: q.from, days: q.days })
          : findOpenDays(tx, {
              serviceId: q.serviceId,
              staffId: q.staffId,
              from: q.from,
              days: q.days,
            }),
      ),
    );
  });
}
