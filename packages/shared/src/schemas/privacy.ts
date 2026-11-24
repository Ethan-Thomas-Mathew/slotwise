import { z } from 'zod';
import { BookingStatus, PaymentStatus } from './booking';
import { IsoDateTime, Role, Uuid } from './common';

/** "Delete my account": the password again, plus typing DELETE, so it can't happen by accident. */
export const DeleteAccountRequest = z.object({
  password: z.string().min(1, 'Required').max(128),
  confirm: z.literal('DELETE', { error: 'Type DELETE to confirm' }),
});
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequest>;

/** Everything Slotwise stores about one person, as a downloadable file. */
export const DataExport = z.object({
  exportedAt: IsoDateTime,
  user: z.object({ id: Uuid, name: z.string(), email: z.string(), createdAt: IsoDateTime }),
  memberships: z.array(
    z.object({ business: z.string(), bookingLink: z.string(), role: Role, joinedAt: IsoDateTime }),
  ),
  bookings: z.array(
    z.object({
      id: Uuid,
      business: z.string(),
      service: z.string(),
      staff: z.string(),
      startAt: IsoDateTime,
      endAt: IsoDateTime,
      status: BookingStatus,
      pricePaise: z.number().int(),
      createdAt: IsoDateTime,
      payments: z.array(
        z.object({
          amountPaise: z.number().int(),
          currency: z.string(),
          status: PaymentStatus,
          createdAt: IsoDateTime,
        }),
      ),
    }),
  ),
});
export type DataExport = z.infer<typeof DataExport>;
