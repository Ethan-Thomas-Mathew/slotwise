import { DateTime } from 'luxon';

/*
 * Every time is shown in the BUSINESS's timezone (not the viewer's), because
 * that's where the appointment happens.
 */
export const dt = (iso: string, tz: string) => DateTime.fromISO(iso, { zone: tz });

export const fmtTime = (iso: string, tz: string) => dt(iso, tz).toFormat('h:mm a');
export const fmtDay = (iso: string, tz: string) => dt(iso, tz).toFormat('ccc d LLL');
export const fmtDayLong = (iso: string, tz: string) => dt(iso, tz).toFormat('cccc, d LLLL');
export const fmtDateTime = (iso: string, tz: string) => dt(iso, tz).toFormat('ccc d LLL, h:mm a');

/** The next `n` calendar dates (YYYY-MM-DD) starting today, in the business timezone. */
export function nextDates(tz: string, n: number): string[] {
  const today = DateTime.now().setZone(tz).startOf('day');
  return Array.from({ length: n }, (_, i) => today.plus({ days: i }).toISODate()!);
}

/** Groups slot start times by their hour, for the timeline view: { "9 AM": [...], "10 AM": [...] }. */
export function groupByHour<T extends { startAt: string }>(
  slots: T[],
  tz: string,
): { hour: string; slots: T[] }[] {
  const groups: { hour: string; slots: T[] }[] = [];
  for (const s of slots) {
    const hour = dt(s.startAt, tz).toFormat('h a');
    const last = groups[groups.length - 1];
    if (last && last.hour === hour) last.slots.push(s);
    else groups.push({ hour, slots: [s] });
  }
  return groups;
}

/** "9:41" left until `iso`, or null once it's passed. */
export function countdown(iso: string, now = Date.now()): string | null {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
