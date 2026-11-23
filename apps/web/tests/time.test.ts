import { describe, expect, it } from 'vitest';
import { countdown, fmtTime, groupByHour, nextDates } from '../src/lib/time';

describe('time helpers', () => {
  it('formats in the business timezone, not the browser timezone', () => {
    expect(fmtTime('2026-12-01T03:30:00Z', 'Asia/Kolkata')).toBe('9:00 AM');
    expect(fmtTime('2026-12-01T03:30:00Z', 'Europe/London')).toBe('3:30 AM');
  });

  it('groups slots by local hour for the timeline', () => {
    const slots = ['03:30', '04:00', '04:30', '05:45'].map((t) => ({
      startAt: `2026-12-01T${t}:00Z`,
    }));
    const groups = groupByHour(slots, 'Asia/Kolkata');
    expect(groups.map((g) => [g.hour, g.slots.length])).toEqual([
      ['9 AM', 2], // 9:00, 9:30
      ['10 AM', 1],
      ['11 AM', 1],
    ]);
  });

  it('counts down the hold and stops at zero', () => {
    const now = Date.parse('2026-12-01T00:00:00Z');
    expect(countdown('2026-12-01T00:09:41Z', now)).toBe('9:41');
    expect(countdown('2026-12-01T00:00:05Z', now)).toBe('0:05');
    expect(countdown('2026-11-30T23:59:59Z', now)).toBeNull();
  });

  it('lists the next N dates starting today in the given timezone', () => {
    const dates = nextDates('Asia/Kolkata', 3);
    expect(dates).toHaveLength(3);
    expect(new Date(dates[1]!).getTime() - new Date(dates[0]!).getTime()).toBe(86400_000);
  });
});
