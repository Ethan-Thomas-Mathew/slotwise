import type { TenantTx } from '../../db/tenant-tx';
import { notFound } from '../../lib/errors';
import { listBusyIntervals } from '../bookings/repo';
import { getService } from '../services/repo';
import { getStaffMember, staffOffersService } from '../staff/repo';
import { getTenant } from '../tenants/repo';
import { listRules, listTimeOff } from './repo';
import { generateSlots, localDayRange, type Interval } from './slots';

/**
 * Loads everything the pure slot generator needs from the database and runs it.
 * Used by the public slots endpoint AND by the hold endpoint (to check the
 * requested time really is an available slot).
 */
export async function findSlots(
  tx: TenantTx,
  q: { serviceId: string; staffId: string; date: string; excludeBookingId?: string },
  now = new Date(),
): Promise<{
  timezone: string;
  slots: Interval[];
  service: NonNullable<Awaited<ReturnType<typeof getService>>>;
}> {
  const tenant = await getTenant(tx);
  const service = await getService(tx, q.serviceId);
  if (!service || !service.active) throw notFound('Service');
  const staff = await getStaffMember(tx, q.staffId);
  if (!staff || !(await staffOffersService(tx, q.staffId, q.serviceId)))
    throw notFound('Staff member');

  const range = localDayRange(q.date, tenant.timezone);
  if (!range) return { timezone: tenant.timezone, slots: [], service };
  const range2 = { from: range.startAt, to: range.endAt };

  const [rules, timeOff, busy] = await Promise.all([
    listRules(tx, q.staffId),
    listTimeOff(tx, q.staffId, range2),
    listBusyIntervals(tx, q.staffId, range2, { excludeBookingId: q.excludeBookingId }),
  ]);

  const slots = generateSlots({
    date: q.date,
    timezone: tenant.timezone,
    rules: rules.map((r) => ({
      weekday: r.weekday,
      startMinute: r.start_minute,
      endMinute: r.end_minute,
    })),
    timeOff: timeOff.map((t) => ({ startAt: t.start_at, endAt: t.end_at })),
    busy: busy.map((b) => ({ startAt: b.start_at, endAt: b.end_at })),
    durationMinutes: service.duration_minutes,
    now,
    horizonDays: tenant.booking_horizon_days,
  });
  return { timezone: tenant.timezone, slots, service };
}
