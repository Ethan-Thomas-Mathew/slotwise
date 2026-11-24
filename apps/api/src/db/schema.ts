import type { ColumnType, Generated, Selectable } from 'kysely';

/**
 * TypeScript description of every table, used by Kysely to type-check queries.
 * Must match the SQL migrations (a test in tests/integration/schema.test.ts checks this).
 *
 * Generated<T>  = the database fills it in (default value), optional on insert.
 * Timestamp     = read as a Date, may be written as Date or ISO string.
 */
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string, string>;

export type MembershipRole = 'OWNER' | 'STAFF' | 'CUSTOMER';
export type BookingStatus =
  'HELD' | 'CONFIRMED' | 'COMPLETED' | 'NO_SHOW' | 'EXPIRED' | 'CANCELLED';
export type PaymentStatus = 'CREATED' | 'CAPTURED' | 'FAILED' | 'REFUND_PENDING' | 'REFUNDED';
export type NotificationType =
  'BOOKING_CONFIRMED' | 'BOOKING_REMINDER' | 'BOOKING_CANCELLED' | 'LATE_PAYMENT_REFUNDED';
export type NotificationStatus = 'PENDING' | 'SENT' | 'FAILED' | 'CANCELLED';
export type AuthTokenType = 'PASSWORD_RESET' | 'STAFF_INVITE';

export interface TenantsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  timezone: Generated<string>;
  currency: Generated<string>;
  cancellation_window_hours: Generated<number>;
  booking_horizon_days: Generated<number>;
  created_at: GeneratedTimestamp;
}

export interface UsersTable {
  id: Generated<string>;
  email: string;
  name: string;
  password_hash: string;
  created_at: GeneratedTimestamp;
  /** Set when the person deleted their account (the row is anonymised, not removed). */
  deleted_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

export interface MembershipsTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  role: MembershipRole;
  created_at: GeneratedTimestamp;
}

export interface ServicesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  duration_minutes: number;
  price_paise: number;
  active: Generated<boolean>;
  created_at: GeneratedTimestamp;
}

export interface StaffServicesTable {
  tenant_id: string;
  staff_membership_id: string;
  service_id: string;
}

export interface AvailabilityRulesTable {
  id: Generated<string>;
  tenant_id: string;
  staff_membership_id: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
}

export interface TimeOffTable {
  id: Generated<string>;
  tenant_id: string;
  staff_membership_id: string;
  start_at: Timestamp;
  end_at: Timestamp;
  reason: string | null;
}

export interface BookingsTable {
  id: Generated<string>;
  tenant_id: string;
  service_id: string;
  staff_membership_id: string;
  customer_membership_id: string;
  start_at: Timestamp;
  end_at: Timestamp;
  status: BookingStatus;
  price_paise: number;
  hold_expires_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  cancelled_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PaymentsTable {
  id: Generated<string>;
  tenant_id: string;
  booking_id: string;
  provider: string;
  provider_order_id: string;
  provider_payment_id: string | null;
  provider_refund_id: string | null;
  amount_paise: number;
  currency: string;
  status: Generated<PaymentStatus>;
  refund_reason: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface WebhookEventsTable {
  id: Generated<string>;
  provider: string;
  event_id: string;
  type: string;
  payload: Json;
  received_at: GeneratedTimestamp;
  processed_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export interface NotificationsTable {
  id: Generated<string>;
  tenant_id: string;
  booking_id: string;
  type: NotificationType;
  status: Generated<NotificationStatus>;
  scheduled_for: GeneratedTimestamp;
  attempts: Generated<number>;
  last_error: string | null;
  sent_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  created_at: GeneratedTimestamp;
}

export interface AuditLogsTable {
  id: Generated<string>;
  tenant_id: string;
  actor_user_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: Json | null;
  after: Json | null;
  created_at: GeneratedTimestamp;
}

export interface SessionsTable {
  id: string; // SHA-256 of the cookie token (the raw token is never stored)
  user_id: string;
  active_tenant_id: string | null;
  csrf_token: string;
  expires_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export interface AuthTokensTable {
  id: Generated<string>;
  type: AuthTokenType;
  token_hash: string;
  email: string;
  user_id: string | null;
  tenant_id: string | null;
  expires_at: Timestamp;
  used_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  created_at: GeneratedTimestamp;
}

export interface DB {
  tenants: TenantsTable;
  users: UsersTable;
  memberships: MembershipsTable;
  services: ServicesTable;
  staff_services: StaffServicesTable;
  availability_rules: AvailabilityRulesTable;
  time_off: TimeOffTable;
  bookings: BookingsTable;
  payments: PaymentsTable;
  webhook_events: WebhookEventsTable;
  notifications: NotificationsTable;
  audit_logs: AuditLogsTable;
  sessions: SessionsTable;
  auth_tokens: AuthTokensTable;
}

export type Tenant = Selectable<TenantsTable>;
export type User = Selectable<UsersTable>;
export type Membership = Selectable<MembershipsTable>;
export type Service = Selectable<ServicesTable>;
export type Booking = Selectable<BookingsTable>;
export type Payment = Selectable<PaymentsTable>;
export type Notification = Selectable<NotificationsTable>;
