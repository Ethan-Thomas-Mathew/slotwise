import { describe, expect, it } from 'vitest';
import { reminderTime } from '../../src/modules/notifications/repo';

const at = (iso: string) => new Date(iso);

describe('reminderTime: 24 hours before the appointment', () => {
  const start = at('2026-12-10T10:00:00Z');

  it('is 24 hours before the start when that is still ahead', () => {
    expect(reminderTime(start, at('2026-12-08T10:00:00Z'))).toEqual(at('2026-12-09T10:00:00Z'));
  });

  it('is skipped when booked less than 24 hours ahead', () => {
    expect(reminderTime(start, at('2026-12-09T12:00:00Z'))).toBeNull();
  });

  it('is skipped at exactly 24 hours (it would be sent at the moment of booking)', () => {
    expect(reminderTime(start, at('2026-12-09T10:00:00Z'))).toBeNull();
  });

  it('is kept one millisecond earlier', () => {
    expect(reminderTime(start, at('2026-12-09T09:59:59.999Z'))).toEqual(at('2026-12-09T10:00:00Z'));
  });
});
