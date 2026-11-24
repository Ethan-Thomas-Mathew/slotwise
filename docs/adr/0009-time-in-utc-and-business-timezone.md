# 0009. UTC storage, the business's timezone at the edges, and pure slot logic

Status: accepted (November 2026)

## Context

Owners think in local wall-clock hours ("09:00 to 17:00"). Appointments are instants.
Daylight-saving changes can create times that don't exist or happen twice.

## Decision

- Every instant is `timestamptz` (UTC). Working hours are stored as minutes after local
  midnight (540 = 09:00).
- Slots come from `generateSlots()`, a pure function that takes rules, time off, existing
  bookings, `now` and the timezone, and returns slots on a fixed grid (steps of the
  service length). It needs no database or clock, so edge cases (DST in both directions,
  day boundaries, partial time off) are unit tests that run in milliseconds.
- Time rules take `now` as a parameter (`bookingPolicy`, `reminderTime`), so their
  boundaries are tested exactly.
- The web app formats every time in the business's timezone, never the browser's.

## Consequences

- A customer abroad still sees "10:00" for a 10:00 appointment in Bengaluru.
- A fixed grid gives tidy times but can leave small gaps unused.

## Alternatives rejected

- **Local timestamps in the database:** ambiguous during DST changes.
- **Slots computed in SQL:** hard to test edge cases.
- **Slots starting right after each booking:** odd start times (10:17).
