import { z } from 'zod';

export const Uuid = z.uuid();
export const Email = z.email().max(254);
export const Password = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128, 'Use at most 128 characters');
export const PersonName = z.string().trim().min(1, 'Required').max(120);
export const Slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'At least 3 characters')
  .max(40, 'At most 40 characters')
  .regex(/^[a-z0-9](-?[a-z0-9])*$/, 'Lowercase letters, numbers and single dashes only');
/** ISO-8601 timestamp with a timezone, e.g. 2026-11-23T09:30:00.000Z */
export const IsoDateTime = z.iso.datetime({ offset: true });
/** Calendar date, e.g. 2026-11-23 */
export const IsoDate = z.iso.date();
/** "HH:MM" 24-hour clock, e.g. "09:30". "24:00" is allowed as an end time. */
export const ClockTime = z
  .string()
  .regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, 'Use HH:MM (24-hour)');
export const Paise = z.number().int().nonnegative();

export const Role = z.enum(['OWNER', 'STAFF', 'CUSTOMER']);
export type Role = z.infer<typeof Role>;

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export const OkResponse = z.object({ ok: z.literal(true) });

/** "09:30" -> 570 */
export function clockToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h! * 60 + m!;
}
/** 570 -> "09:30" */
export function minutesToClock(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
