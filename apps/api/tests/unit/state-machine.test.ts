import { describe, expect, it } from 'vitest';
import type { BookingStatus } from '../../src/db/schema';
import { canTransition, transitionBooking } from '../../src/modules/bookings/state-machine';
import { bookingPolicy } from '../../src/modules/bookings/service';

const ALL: BookingStatus[] = ['HELD', 'CONFIRMED', 'COMPLETED', 'NO_SHOW', 'EXPIRED', 'CANCELLED'];

/** The complete list of legal moves. Every other pair must be rejected. */
const LEGAL = new Set([
  'HELD→CONFIRMED',
  'HELD→EXPIRED',
  'HELD→CANCELLED',
  'EXPIRED→CONFIRMED',
  'CONFIRMED→CANCELLED',
  'CONFIRMED→COMPLETED',
  'CONFIRMED→NO_SHOW',
]);

describe('booking state machine', () => {
  for (const from of ALL) {
    for (const to of ALL) {
      const legal = LEGAL.has(`${from}→${to}`);
      it(`${from} → ${to} is ${legal ? 'allowed' : 'rejected'}`, () => {
        expect(canTransition(from, to)).toBe(legal);
        if (legal) expect(transitionBooking(from, to)).toBe(to);
        else expect(() => transitionBooking(from, to)).toThrow(/cannot become/);
      });
    }
  }
});

describe('cancellation policy', () => {
  const now = new Date('2026-12-01T00:00:00Z');
  const tenant = { cancellation_window_hours: 24 };
  const customer = { role: 'CUSTOMER' as const, membershipId: 'cust-1' };
  const otherCustomer = { role: 'CUSTOMER' as const, membershipId: 'cust-2' };
  const owner = { role: 'OWNER' as const, membershipId: 'own-1' };
  const staff = { role: 'STAFF' as const, membershipId: 'staff-1' };
  const booking = (status: BookingStatus, hoursAhead: number) => ({
    status,
    start_at: new Date(now.getTime() + hoursAhead * 3600_000),
    customer_membership_id: 'cust-1',
  });

  it('customer cancelling 48h ahead (outside the 24h window) gets a refund and may reschedule', () => {
    expect(bookingPolicy(booking('CONFIRMED', 48), tenant, customer, now)).toEqual({
      canCancel: true,
      canReschedule: true,
      refundOnCancel: true,
    });
  });

  it('customer cancelling exactly 24h ahead still gets a refund (boundary included)', () => {
    expect(bookingPolicy(booking('CONFIRMED', 24), tenant, customer, now).refundOnCancel).toBe(
      true,
    );
  });

  it('customer cancelling 2h ahead may cancel but is not refunded and cannot reschedule', () => {
    expect(bookingPolicy(booking('CONFIRMED', 2), tenant, customer, now)).toEqual({
      canCancel: true,
      canReschedule: false,
      refundOnCancel: false,
    });
  });

  it('owner may always cancel/reschedule an upcoming booking, with a full refund', () => {
    expect(bookingPolicy(booking('CONFIRMED', 2), tenant, owner, now)).toEqual({
      canCancel: true,
      canReschedule: true,
      refundOnCancel: true,
    });
  });

  it('nobody can cancel a booking that already started', () => {
    for (const actor of [customer, owner, staff]) {
      expect(bookingPolicy(booking('CONFIRMED', -1), tenant, actor, now).canCancel).toBe(false);
    }
  });

  it("another customer and staff can't cancel someone's booking", () => {
    expect(bookingPolicy(booking('CONFIRMED', 48), tenant, otherCustomer, now).canCancel).toBe(
      false,
    );
    expect(bookingPolicy(booking('CONFIRMED', 48), tenant, staff, now).canCancel).toBe(false);
  });

  it('a hold can be abandoned (no refund, nothing was paid) but not rescheduled', () => {
    expect(bookingPolicy(booking('HELD', 48), tenant, customer, now)).toEqual({
      canCancel: true,
      canReschedule: false,
      refundOnCancel: false,
    });
  });

  it('a 0-hour window means customers are refunded right up to the start', () => {
    expect(
      bookingPolicy(booking('CONFIRMED', 0.1), { cancellation_window_hours: 0 }, customer, now)
        .refundOnCancel,
    ).toBe(true);
  });

  it('finished bookings allow nothing', () => {
    for (const s of ['COMPLETED', 'NO_SHOW', 'CANCELLED', 'EXPIRED'] as BookingStatus[]) {
      expect(bookingPolicy(booking(s, 48), tenant, owner, now)).toEqual({
        canCancel: false,
        canReschedule: false,
        refundOnCancel: false,
      });
    }
  });
});
