import { sql } from 'kysely';
import type { PaymentStatus } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-tx';

/** The most recent payment for each booking id (a booking normally has one). */
export async function latestPaymentsFor(tx: TenantTx, bookingIds: string[]) {
  if (bookingIds.length === 0) return new Map();
  const rows = await tx.db
    .selectFrom('payments')
    .select(['booking_id', 'status', 'amount_paise', 'refund_reason', 'created_at'])
    .where('tenant_id', '=', tx.tenantId)
    .where('booking_id', 'in', bookingIds)
    .orderBy('created_at', 'asc')
    .execute();
  const map = new Map<string, (typeof rows)[number]>();
  for (const r of rows) map.set(r.booking_id, r); // later rows overwrite earlier ones
  return map;
}

export async function getCapturedPaymentForUpdate(tx: TenantTx, bookingId: string) {
  return tx.db
    .selectFrom('payments')
    .selectAll()
    .where('tenant_id', '=', tx.tenantId)
    .where('booking_id', '=', bookingId)
    .where('status', '=', 'CAPTURED')
    .forUpdate()
    .executeTakeFirst();
}

export async function getOpenOrderForBooking(tx: TenantTx, bookingId: string) {
  return tx.db
    .selectFrom('payments')
    .selectAll()
    .where('tenant_id', '=', tx.tenantId)
    .where('booking_id', '=', bookingId)
    .where('status', 'in', ['CREATED', 'FAILED'])
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
}

export async function getPaymentByOrderForUpdate(tx: TenantTx, orderId: string) {
  return tx.db
    .selectFrom('payments')
    .selectAll()
    .where('tenant_id', '=', tx.tenantId)
    .where('provider_order_id', '=', orderId)
    .forUpdate()
    .executeTakeFirst();
}

export async function getPaymentForUpdate(tx: TenantTx, id: string) {
  return tx.db
    .selectFrom('payments')
    .selectAll()
    .where('tenant_id', '=', tx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

export async function insertPayment(
  tx: TenantTx,
  data: {
    bookingId: string;
    provider: string;
    orderId: string;
    amountPaise: number;
    currency: string;
  },
) {
  return tx.db
    .insertInto('payments')
    .values({
      tenant_id: tx.tenantId,
      booking_id: data.bookingId,
      provider: data.provider,
      provider_order_id: data.orderId,
      amount_paise: data.amountPaise,
      currency: data.currency,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updatePayment(
  tx: TenantTx,
  id: string,
  from: PaymentStatus[],
  patch: {
    status: PaymentStatus;
    provider_payment_id?: string;
    provider_refund_id?: string;
    refund_reason?: string;
  },
) {
  return tx.db
    .updateTable('payments')
    .set({ ...patch, updated_at: sql`now()` })
    .where('tenant_id', '=', tx.tenantId)
    .where('id', '=', id)
    .where('status', 'in', from)
    .returningAll()
    .executeTakeFirst();
}
