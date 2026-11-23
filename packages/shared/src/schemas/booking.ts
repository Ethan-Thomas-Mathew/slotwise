import { z } from 'zod';
import { IsoDate, IsoDateTime, Paise, Uuid } from './common';
import { ServiceDto } from './catalog';

export const BookingStatus = z.enum([
  'HELD',
  'CONFIRMED',
  'COMPLETED',
  'NO_SHOW',
  'EXPIRED',
  'CANCELLED',
]);
export type BookingStatus = z.infer<typeof BookingStatus>;

export const PaymentStatus = z.enum([
  'CREATED',
  'CAPTURED',
  'FAILED',
  'REFUND_PENDING',
  'REFUNDED',
]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

// ---------- Public booking page ----------
export const PublicTenantResponse = z.object({
  tenant: z.object({
    name: z.string(),
    slug: z.string(),
    timezone: z.string(),
    currency: z.string(),
    cancellationWindowHours: z.number().int(),
    bookingHorizonDays: z.number().int(),
  }),
  services: z.array(ServiceDto),
  staff: z.array(z.object({ membershipId: Uuid, name: z.string(), serviceIds: z.array(Uuid) })),
});
export type PublicTenantResponse = z.infer<typeof PublicTenantResponse>;

export const SlotsQuery = z.object({ serviceId: Uuid, staffId: Uuid, date: IsoDate });
export const SlotsResponse = z.object({
  date: IsoDate,
  timezone: z.string(),
  slots: z.array(z.object({ startAt: IsoDateTime, endAt: IsoDateTime })),
});
export type SlotsResponse = z.infer<typeof SlotsResponse>;

export const OpenDaysQuery = z.object({
  serviceId: Uuid,
  staffId: Uuid,
  from: IsoDate,
  days: z.coerce.number().int().min(1).max(31).default(21),
});
export const OpenDaysResponse = z.object({
  timezone: z.string(),
  days: z.array(z.object({ date: IsoDate, openSlots: z.number().int() })),
});
export type OpenDaysResponse = z.infer<typeof OpenDaysResponse>;

// ---------- Bookings ----------
export const HoldRequest = z.object({ serviceId: Uuid, staffId: Uuid, startAt: IsoDateTime });
export type HoldRequest = z.infer<typeof HoldRequest>;

export const RescheduleRequest = z.object({ startAt: IsoDateTime, staffId: Uuid.optional() });

export const BookingDto = z.object({
  id: Uuid,
  status: BookingStatus,
  startAt: IsoDateTime,
  endAt: IsoDateTime,
  holdExpiresAt: IsoDateTime.nullable(),
  pricePaise: Paise,
  service: z.object({ id: Uuid, name: z.string() }),
  staff: z.object({ membershipId: Uuid, name: z.string() }),
  customer: z.object({ membershipId: Uuid, name: z.string(), email: z.string() }),
  payment: z
    .object({ status: PaymentStatus, amountPaise: Paise, refundReason: z.string().nullable() })
    .nullable(),
  /** Whether the current user may cancel / reschedule right now. */
  canCancel: z.boolean(),
  canReschedule: z.boolean(),
});
export type BookingDto = z.infer<typeof BookingDto>;

export const BookingListResponse = z.object({ bookings: z.array(BookingDto) });

export const BookingListQuery = z.object({
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  status: BookingStatus.optional(),
  staffId: Uuid.optional(),
});

// ---------- Payments ----------
export const CreateOrderRequest = z.object({ bookingId: Uuid });
export const CreateOrderResponse = z.object({
  provider: z.enum(['mock', 'razorpay']),
  orderId: z.string(),
  amountPaise: Paise,
  currency: z.string(),
  /** Public Razorpay key id for Checkout (null for the mock provider). */
  keyId: z.string().nullable(),
  businessName: z.string(),
  customer: z.object({ name: z.string(), email: z.string() }),
});
export type CreateOrderResponse = z.infer<typeof CreateOrderResponse>;

// ---------- Dashboards ----------
export const DashboardSummary = z.object({
  todayCount: z.number().int(),
  upcomingCount: z.number().int(),
  revenueByWeek: z.array(z.object({ weekStart: IsoDate, revenuePaise: z.number().int() })),
  failedNotifications: z.number().int(),
});
export type DashboardSummary = z.infer<typeof DashboardSummary>;

export const AuditLogDto = z.object({
  id: Uuid,
  action: z.string(),
  entity: z.string(),
  entityId: Uuid.nullable(),
  actor: z.object({ name: z.string(), email: z.string() }).nullable(),
  before: z.unknown(),
  after: z.unknown(),
  createdAt: IsoDateTime,
});
export const AuditLogQuery = z.object({
  entity: z.string().max(50).optional(),
  action: z.string().max(80).optional(),
  before: IsoDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const NotificationDto = z.object({
  id: Uuid,
  bookingId: Uuid,
  type: z.string(),
  status: z.enum(['PENDING', 'SENT', 'FAILED', 'CANCELLED']),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  scheduledFor: IsoDateTime,
  sentAt: IsoDateTime.nullable(),
});
