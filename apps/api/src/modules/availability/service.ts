import { DateTime } from 'luxon';
import type { TenantTx } from '../../db/tenant-tx';
import { notFound } from '../../lib/errors';
import { listBusyIntervals } from '../bookings/repo';
import { getService } from '../services/repo';
import { getStaffMember, staffOffersService } from '../staff/repo';
import { getTenant } from '../tenants/repo';
import { listRules, listTimeOff } from './repo';
import { generateSlots, localDayRange, type Interval } from './slots';

type ServiceRow = NonNullable<Awaited<ReturnType<typeof getService>>>;

/**
 * Loads everything the pure slot generator needs for a range of dates, ONCE,
 * and returns a function that computes the slots for any date in that range.
 */
async function loadCalendar(
  tx: TenantTx,
  q: {
    serviceId: string;
    staffId: string;
    firstDate: string;
    lastDate: string;
    excludeBookingId?: string;
  },
  now: Date,
) {
  const tenant = await getTenant(tx);
  const service = await getService(tx, q.serviceId);
  if (!service || !service.active) throw notFound('Service');
  const staff = await getStaffMember(tx, q.staffId);
  if (!staff || !(await staffOffersService(tx, q.staffId, q.serviceId))) {
    throw notFound('Staff member');
  }

  const first = localDayRange(q.firstDate, tenant.timezone);
  const last = localDayRange(q.lastDate, tenant.timezone);
  if (!first || !last) return { tenant, service, slotsOn: (_date: string): Interval[] => [] };
  const range = { from: first.startAt, to: last.endAt };

  const [rules, timeOff, busy] = await Promise.all([
    listRules(tx, q.staffId),
    listTimeOff(tx, q.staffId, range),
    listBusyIntervals(tx, q.staffId, range, { excludeBookingId: q.excludeBookingId }),
  ]);
  const input = {
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
  };
  return { tenant, service, slotsOn: (date: string) => generateSlots({ ...input, date }) };
}

/**
 * The open slots on one date. Used by the public slots endpoint AND by the
 * hold/reschedule endpoints (to check the requested time really is available).
 */
export async function findSlots(
  tx: TenantTx,
  q: { serviceId: string; staffId: string; date: string; excludeBookingId?: string },
  now = new Date(),
): Promise<{ timezone: string; slots: Interval[]; service: ServiceRow }> {
  const cal = await loadCalendar(tx, { ...q, firstDate: q.date, lastDate: q.date }, now);
  return { timezone: cal.tenant.timezone, slots: cal.slotsOn(q.date), service: cal.service };
}

/**
 * How many open slots each of the next `days` dates has, starting at `from`.
 * Lets the booking page grey out closed or full days and jump to the first
 * open one, with three database queries instead of one request per day.
 */
export async function findOpenDays(
  tx: TenantTx,
  q: { serviceId: string; staffId: string; from: string; days: number },
  now = new Date(),
): Promise<{ timezone: string; days: { date: string; openSlots: number }[] }> {
  const start = DateTime.fromISO(q.from);
  if (!start.isValid) return { timezone: (await getTenant(tx)).timezone, days: [] };
  const dates = Array.from({ length: q.days }, (_, i) => start.plus({ days: i }).toISODate()!);
  const cal = await loadCalendar(
    tx,
    { serviceId: q.serviceId, staffId: q.staffId, firstDate: dates[0]!, lastDate: dates.at(-1)! },
    now,
  );
  return {
    timezone: cal.tenant.timezone,
    days: dates.map((date) => ({ date, openSlots: cal.slotsOn(date).length })),
  };
}
