import { DateTime } from 'luxon';

/**
 * SLOT GENERATION: a pure function (same input → same output, no database,
 * no clock). That makes it easy to test every edge case.
 *
 *   available slots = working hours − time off − existing bookings,
 *                     cut into service-length pieces,
 *                     minus anything in the past or too far ahead.
 *
 * All the input/output instants are absolute (JS Date = UTC). The tenant's
 * timezone is used only to work out what "Tuesday 09:00" means on that date,
 * including daylight-saving changes.
 */

export interface Interval {
  startAt: Date;
  endAt: Date;
}

export interface WeeklyRule {
  weekday: number; // 1 = Monday … 7 = Sunday (ISO, same as Luxon)
  startMinute: number; // minutes after local midnight, e.g. 540 = 09:00
  endMinute: number; // up to 1440 (= midnight at the end of the day)
}

export interface SlotInput {
  /** Calendar date in the tenant's timezone, "YYYY-MM-DD". */
  date: string;
  /** IANA timezone, e.g. "Asia/Kolkata". */
  timezone: string;
  rules: WeeklyRule[];
  timeOff: Interval[];
  /** Existing HELD (unexpired) / CONFIRMED bookings for this staff member. */
  busy: Interval[];
  durationMinutes: number;
  now: Date;
  /** Customers can't book further ahead than this many days. */
  horizonDays: number;
  /** Earliest bookable time is now + this. Default 0. */
  minNoticeMinutes?: number;
  /** Distance between slot start times. Default: the service duration. */
  stepMinutes?: number;
}

const MINUTE = 60_000;

/** Half-open intervals [a, b) and [c, d) overlap if a < d and c < b. */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Local wall-clock time on `day` → absolute instant. 1440 means "next midnight". */
function atLocalMinute(day: DateTime, minute: number): DateTime {
  if (minute >= 1440) return day.plus({ days: 1 }).startOf('day');
  return day.set({ hour: Math.floor(minute / 60), minute: minute % 60, second: 0, millisecond: 0 });
}

export function generateSlots(input: SlotInput): Interval[] {
  const day = DateTime.fromISO(input.date, { zone: input.timezone }).startOf('day');
  if (!day.isValid) return [];
  if (input.durationMinutes <= 0) return [];

  const durationMs = input.durationMinutes * MINUTE;
  const stepMs = (input.stepMinutes ?? input.durationMinutes) * MINUTE;
  const earliest = input.now.getTime() + (input.minNoticeMinutes ?? 0) * MINUTE;
  const latest = input.now.getTime() + input.horizonDays * 24 * 60 * MINUTE;

  const blockers = [...input.timeOff, ...input.busy].map((b) => [
    b.startAt.getTime(),
    b.endAt.getTime(),
  ]) as [number, number][];

  const rules = input.rules
    .filter((r) => r.weekday === day.weekday)
    .sort((a, b) => a.startMinute - b.startMinute);

  const seen = new Set<number>();
  const slots: Interval[] = [];

  for (const rule of rules) {
    const windowStart = atLocalMinute(day, rule.startMinute).toMillis();
    const windowEnd = atLocalMinute(day, rule.endMinute).toMillis();

    // Walk a grid anchored at the start of the working window: 09:00, 09:30, …
    // Stepping in absolute milliseconds means a DST jump can't create
    // duplicate or impossible slots.
    for (let start = windowStart; start + durationMs <= windowEnd; start += stepMs) {
      const end = start + durationMs;
      if (start < earliest || start > latest) continue;
      if (blockers.some(([bs, be]) => overlaps(start, end, bs, be))) continue;
      if (seen.has(start)) continue;
      seen.add(start);
      slots.push({ startAt: new Date(start), endAt: new Date(end) });
    }
  }

  return slots.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

/** The UTC range covering a whole local calendar day (used to query blockers). */
export function localDayRange(date: string, timezone: string): Interval | null {
  const day = DateTime.fromISO(date, { zone: timezone }).startOf('day');
  if (!day.isValid) return null;
  return { startAt: day.toJSDate(), endAt: day.plus({ days: 1 }).startOf('day').toJSDate() };
}

/** Which local calendar date an instant falls on, in the tenant's timezone. */
export function localDateOf(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: timezone }).toISODate()!;
}
