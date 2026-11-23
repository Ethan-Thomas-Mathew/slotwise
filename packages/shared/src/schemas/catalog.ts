import { z } from 'zod';
import { ClockTime, Email, IsoDateTime, Paise, PersonName, Role, Uuid } from './common';

// ---------- Services ----------
export const ServiceInput = z.object({
  name: z.string().trim().min(1).max(120),
  durationMinutes: z.number().int().min(5).max(720),
  pricePaise: z.number().int().min(100, 'Minimum price is ₹1'),
  active: z.boolean().default(true),
});
export type ServiceInput = z.input<typeof ServiceInput>;
export const ServicePatch = ServiceInput.partial();

export const ServiceDto = z.object({
  id: Uuid,
  name: z.string(),
  durationMinutes: z.number().int(),
  pricePaise: Paise,
  active: z.boolean(),
});
export type ServiceDto = z.infer<typeof ServiceDto>;

// ---------- Staff ----------
export const StaffDto = z.object({
  membershipId: Uuid,
  name: z.string(),
  email: z.string(),
  role: Role,
  serviceIds: z.array(Uuid),
});
export type StaffDto = z.infer<typeof StaffDto>;

export const InviteStaffRequest = z.object({ email: Email, name: PersonName });
export const SetStaffServicesRequest = z.object({ serviceIds: z.array(Uuid).max(100) });

// ---------- Availability ----------
export const AvailabilityRule = z
  .object({
    weekday: z.number().int().min(1).max(7), // 1 = Monday
    start: ClockTime,
    end: ClockTime,
  })
  .refine((r) => r.end > r.start, { message: 'End must be after start', path: ['end'] });
export type AvailabilityRule = z.infer<typeof AvailabilityRule>;

export const SetAvailabilityRequest = z.object({ rules: z.array(AvailabilityRule).max(50) }).refine(
  (v) => {
    // No two ranges on the same weekday may overlap.
    const byDay = new Map<number, { start: string; end: string }[]>();
    for (const r of v.rules) byDay.set(r.weekday, [...(byDay.get(r.weekday) ?? []), r]);
    for (const ranges of byDay.values()) {
      const sorted = [...ranges].sort((a, b) => a.start.localeCompare(b.start));
      for (let i = 1; i < sorted.length; i++)
        if (sorted[i]!.start < sorted[i - 1]!.end) return false;
    }
    return true;
  },
  { message: 'Working hours on the same day overlap', path: ['rules'] },
);

export const TimeOffInput = z
  .object({ startAt: IsoDateTime, endAt: IsoDateTime, reason: z.string().max(200).optional() })
  .refine((v) => new Date(v.endAt) > new Date(v.startAt), {
    message: 'End must be after start',
    path: ['endAt'],
  });
export const TimeOffDto = z.object({
  id: Uuid,
  startAt: IsoDateTime,
  endAt: IsoDateTime,
  reason: z.string().nullable(),
});

// ---------- Tenant settings ----------
export const TenantSettingsPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().min(1).max(64).optional(),
  cancellationWindowHours: z.number().int().min(0).max(720).optional(),
  bookingHorizonDays: z.number().int().min(1).max(365).optional(),
});
