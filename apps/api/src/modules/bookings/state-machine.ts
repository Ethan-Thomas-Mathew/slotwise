import type { BookingStatus } from '../../db/schema';
import { AppError } from '../../http/errors';

/**
 * The booking lifecycle. Every status change in the app goes through
 * transitionBooking(), so an illegal jump (e.g. CANCELLED → CONFIRMED) is
 * impossible by construction.
 *
 *   HELD ──pay──► CONFIRMED ──► COMPLETED
 *    │  │             │    └──► NO_SHOW
 *    │  └─cancel─►    └──cancel──► CANCELLED
 *    │            CANCELLED
 *    └─timeout─► EXPIRED ──late payment, slot still free──► CONFIRMED
 */
const ALLOWED: Record<BookingStatus, readonly BookingStatus[]> = {
  HELD: ['CONFIRMED', 'EXPIRED', 'CANCELLED'],
  EXPIRED: ['CONFIRMED'],
  CONFIRMED: ['CANCELLED', 'COMPLETED', 'NO_SHOW'],
  CANCELLED: [],
  COMPLETED: [],
  NO_SHOW: [],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return ALLOWED[from].includes(to);
}

/** Returns `to` if the move is legal, otherwise throws a 409 INVALID_STATE. */
export function transitionBooking(from: BookingStatus, to: BookingStatus): BookingStatus {
  if (!canTransition(from, to)) {
    throw new AppError(
      'INVALID_STATE',
      `A ${from.toLowerCase()} booking cannot become ${to.toLowerCase()}`,
    );
  }
  return to;
}
