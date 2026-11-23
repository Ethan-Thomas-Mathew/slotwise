import { describe, expect, it } from 'vitest';
import {
  generateSlots,
  localDateOf,
  localDayRange,
  type SlotInput,
} from '../../src/modules/availability/slots';

/**
 * 2026-12-01 is a Tuesday (weekday 2). Asia/Kolkata is UTC+05:30 all year,
 * so 09:00 local = 03:30Z.
 */
const TUE = '2026-12-01';
const at = (iso: string) => new Date(iso);
const times = (slots: { startAt: Date }[]) =>
  slots.map((s) => s.startAt.toISOString().slice(11, 16));

function input(overrides: Partial<SlotInput> = {}): SlotInput {
  return {
    date: TUE,
    timezone: 'Asia/Kolkata',
    rules: [{ weekday: 2, startMinute: 9 * 60, endMinute: 12 * 60 }], // 09:00-12:00 local
    timeOff: [],
    busy: [],
    durationMinutes: 30,
    now: at('2026-11-30T00:00:00Z'),
    horizonDays: 60,
    ...overrides,
  };
}

describe('generateSlots: basics', () => {
  it('cuts working hours into service-length slots (09:00-12:00, 30 min → 6)', () => {
    const slots = generateSlots(input());
    expect(slots).toHaveLength(6);
    expect(slots[0]).toEqual({
      startAt: at('2026-12-01T03:30:00Z'),
      endAt: at('2026-12-01T04:00:00Z'),
    });
    expect(slots[5]!.endAt).toEqual(at('2026-12-01T06:30:00Z')); // 12:00 local
  });

  it('returns nothing on a day with no working hours', () => {
    expect(generateSlots(input({ date: '2026-12-02' }))).toEqual([]); // Wednesday
  });

  it('returns nothing when there are no rules at all', () => {
    expect(generateSlots(input({ rules: [] }))).toEqual([]);
  });

  it('a service longer than the whole window gets no slots', () => {
    expect(generateSlots(input({ durationMinutes: 240 }))).toEqual([]);
  });

  it('a service exactly as long as the window gets one slot', () => {
    expect(generateSlots(input({ durationMinutes: 180 }))).toHaveLength(1);
  });

  it('drops the last slot if it would run past closing time', () => {
    // 09:00-12:00 with 45 min: 09:00, 09:45, 10:30, 11:15 (11:15+45 = 12:00 fits)
    expect(times(generateSlots(input({ durationMinutes: 45 })))).toEqual([
      '03:30',
      '04:15',
      '05:00',
      '05:45',
    ]);
    // 09:00-12:00 with 50 min: 09:00, 09:50, 10:40 (11:30+50 > 12:00)
    expect(generateSlots(input({ durationMinutes: 50 }))).toHaveLength(3);
  });

  it('supports a custom step (30-min service every 15 min)', () => {
    const slots = generateSlots(input({ stepMinutes: 15 }));
    expect(slots).toHaveLength(11); // 09:00 … 11:30
  });

  it('handles split shifts and skips the break', () => {
    const slots = generateSlots(
      input({
        rules: [
          { weekday: 2, startMinute: 14 * 60, endMinute: 15 * 60 }, // given out of order on purpose
          { weekday: 2, startMinute: 9 * 60, endMinute: 10 * 60 },
        ],
      }),
    );
    expect(times(slots)).toEqual(['03:30', '04:00', '08:30', '09:00']);
  });

  it('supports working until midnight (end minute 1440)', () => {
    const slots = generateSlots(
      input({ rules: [{ weekday: 2, startMinute: 23 * 60, endMinute: 1440 }] }),
    );
    expect(slots).toHaveLength(2);
    expect(slots[1]!.endAt).toEqual(at('2026-12-01T18:30:00Z')); // 00:00 local next day
  });
});

describe('generateSlots: existing bookings', () => {
  it('removes a slot that is exactly booked', () => {
    const busy = [{ startAt: at('2026-12-01T04:00:00Z'), endAt: at('2026-12-01T04:30:00Z') }]; // 09:30-10:00
    expect(times(generateSlots(input({ busy })))).toEqual([
      '03:30',
      '04:30',
      '05:00',
      '05:30',
      '06:00',
    ]);
  });

  it('removes every slot a booking partially overlaps', () => {
    // 09:45-10:15 overlaps both 09:30-10:00 and 10:00-10:30
    const busy = [{ startAt: at('2026-12-01T04:15:00Z'), endAt: at('2026-12-01T04:45:00Z') }];
    expect(times(generateSlots(input({ busy })))).toEqual(['03:30', '05:00', '05:30', '06:00']);
  });

  it('keeps slots that only touch a booking (end == start is not overlap)', () => {
    const busy = [{ startAt: at('2026-12-01T04:00:00Z'), endAt: at('2026-12-01T05:00:00Z') }];
    const t = times(generateSlots(input({ busy })));
    expect(t).toContain('03:30'); // ends exactly when the booking starts
    expect(t).toContain('05:00'); // starts exactly when the booking ends
  });

  it('a booking that started the previous evening blocks the early slots (day boundary)', () => {
    const rules = [{ weekday: 2, startMinute: 0, endMinute: 120 }]; // 00:00-02:00 local Tue
    const busy = [{ startAt: at('2026-11-30T18:00:00Z'), endAt: at('2026-11-30T19:00:00Z') }]; // 23:30 Mon - 00:30 Tue
    expect(times(generateSlots(input({ rules, busy })))).toEqual(['19:00', '19:30', '20:00']);
  });

  it('ignores bookings on other days', () => {
    const busy = [{ startAt: at('2026-12-02T03:30:00Z'), endAt: at('2026-12-02T06:30:00Z') }];
    expect(generateSlots(input({ busy }))).toHaveLength(6);
  });

  it('the input order of bookings does not matter', () => {
    const a = { startAt: at('2026-12-01T03:30:00Z'), endAt: at('2026-12-01T04:00:00Z') };
    const b = { startAt: at('2026-12-01T05:30:00Z'), endAt: at('2026-12-01T06:00:00Z') };
    expect(generateSlots(input({ busy: [a, b] }))).toEqual(generateSlots(input({ busy: [b, a] })));
  });
});

describe('generateSlots: time off', () => {
  it('time off covering part of the day removes only those slots', () => {
    const timeOff = [{ startAt: at('2026-12-01T03:30:00Z'), endAt: at('2026-12-01T05:00:00Z') }]; // 09:00-10:30
    expect(times(generateSlots(input({ timeOff })))).toEqual(['05:00', '05:30', '06:00']);
  });

  it('time off covering the whole day leaves nothing', () => {
    const timeOff = [{ startAt: at('2026-11-30T18:30:00Z'), endAt: at('2026-12-01T18:30:00Z') }];
    expect(generateSlots(input({ timeOff }))).toEqual([]);
  });

  it('multi-day time off that started earlier still applies', () => {
    const timeOff = [{ startAt: at('2026-11-25T00:00:00Z'), endAt: at('2026-12-05T00:00:00Z') }];
    expect(generateSlots(input({ timeOff }))).toEqual([]);
  });

  it('time off and bookings combine', () => {
    const timeOff = [{ startAt: at('2026-12-01T03:30:00Z'), endAt: at('2026-12-01T04:30:00Z') }]; // 09:00-10:00
    const busy = [{ startAt: at('2026-12-01T05:30:00Z'), endAt: at('2026-12-01T06:30:00Z') }]; // 11:00-12:00
    expect(times(generateSlots(input({ timeOff, busy })))).toEqual(['04:30', '05:00']);
  });
});

describe('generateSlots: now, notice and horizon', () => {
  it('hides slots that already started today', () => {
    const now = at('2026-12-01T04:45:00Z'); // 10:15 local
    expect(times(generateSlots(input({ now })))).toEqual(['05:00', '05:30', '06:00']);
  });

  it('a slot starting exactly now is still offered', () => {
    const now = at('2026-12-01T05:00:00Z');
    expect(times(generateSlots(input({ now })))[0]).toBe('05:00');
  });

  it('applies minimum notice', () => {
    const now = at('2026-12-01T03:00:00Z'); // 08:30 local
    expect(times(generateSlots(input({ now, minNoticeMinutes: 60 })))[0]).toBe('04:00'); // 09:30
  });

  it('returns nothing for a date in the past', () => {
    expect(generateSlots(input({ now: at('2026-12-05T00:00:00Z') }))).toEqual([]);
  });

  it('returns nothing beyond the booking horizon', () => {
    // Oct 1 00:00Z → Dec 1 03:30Z is 61 days and 3.5 hours.
    expect(generateSlots(input({ now: at('2026-10-01T00:00:00Z'), horizonDays: 61 }))).toEqual([]);
    expect(generateSlots(input({ now: at('2026-10-01T00:00:00Z'), horizonDays: 62 }))).toHaveLength(
      6,
    );
  });

  it('returns nothing for an invalid date', () => {
    expect(generateSlots(input({ date: '2026-02-30' }))).toEqual([]);
    expect(generateSlots(input({ date: 'not-a-date' }))).toEqual([]);
  });

  it('returns nothing for a non-positive duration', () => {
    expect(generateSlots(input({ durationMinutes: 0 }))).toEqual([]);
  });
});

describe('generateSlots: timezones and daylight saving', () => {
  it('the same local hours mean different UTC instants in different timezones', () => {
    const ny = generateSlots(input({ timezone: 'America/New_York' }));
    expect(ny[0]!.startAt).toEqual(at('2026-12-01T14:00:00Z')); // 09:00 EST = 14:00Z
  });

  it('spring forward: a 01:00-04:00 window is only 2 real hours', () => {
    // 2026-03-08 (Sunday) clocks in New York jump 02:00 → 03:00.
    const slots = generateSlots(
      input({
        date: '2026-03-08',
        timezone: 'America/New_York',
        rules: [{ weekday: 7, startMinute: 60, endMinute: 240 }],
        durationMinutes: 60,
        now: at('2026-03-01T00:00:00Z'),
      }),
    );
    expect(slots.map((s) => s.startAt.toISOString())).toEqual([
      '2026-03-08T06:00:00.000Z', // 01:00 EST
      '2026-03-08T07:00:00.000Z', // 03:00 EDT (02:00 doesn't exist)
    ]);
  });

  it('fall back: a 00:00-04:00 window is 5 real hours', () => {
    // 2026-11-01 (Sunday) clocks in New York go 02:00 → 01:00 again.
    const slots = generateSlots(
      input({
        date: '2026-11-01',
        timezone: 'America/New_York',
        rules: [{ weekday: 7, startMinute: 0, endMinute: 240 }],
        durationMinutes: 60,
        now: at('2026-10-25T00:00:00Z'),
      }),
    );
    expect(slots).toHaveLength(5);
    expect(new Set(slots.map((s) => s.startAt.getTime())).size).toBe(5); // no duplicates
  });
});

describe('date helpers', () => {
  it('localDayRange covers the local day in UTC', () => {
    expect(localDayRange(TUE, 'Asia/Kolkata')).toEqual({
      startAt: at('2026-11-30T18:30:00Z'),
      endAt: at('2026-12-01T18:30:00Z'),
    });
    expect(localDayRange('nope', 'Asia/Kolkata')).toBeNull();
  });

  it('localDateOf uses the tenant timezone', () => {
    expect(localDateOf(at('2026-11-30T20:00:00Z'), 'Asia/Kolkata')).toBe('2026-12-01');
    expect(localDateOf(at('2026-11-30T20:00:00Z'), 'America/New_York')).toBe('2026-11-30');
  });
});
