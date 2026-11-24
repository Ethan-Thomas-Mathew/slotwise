import { useQuery } from '@tanstack/react-query';
import type { BookingDto, StaffDto } from '@slotwise/shared';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { get } from '../../api/client';
import { useMe } from '../../api/session';
import {
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  Panel,
  SelectField,
} from '../../components/ui';
import { BookingRow } from '../booking/booking-actions';

const STATUSES = [
  ['', 'Any status'],
  ['CONFIRMED', 'Confirmed'],
  ['HELD', 'Awaiting payment'],
  ['COMPLETED', 'Completed'],
  ['NO_SHOW', 'No-show'],
  ['CANCELLED', 'Cancelled'],
] as const;

export function OwnerBookingsPage() {
  const me = useMe();
  const tz = me.data!.activeTenant!.timezone;
  const today = DateTime.now().setZone(tz).startOf('day');
  const [from, setFrom] = useState(today.toISODate()!);
  const [to, setTo] = useState(today.plus({ days: 14 }).toISODate()!);
  const [status, setStatus] = useState('');
  const [staffId, setStaffId] = useState('');

  const staff = useQuery({
    queryKey: ['staff'],
    queryFn: () => get<{ staff: StaffDto[] }>('/staff'),
  });
  const params = new URLSearchParams();
  if (from) params.set('from', DateTime.fromISO(from, { zone: tz }).toISO()!);
  if (to) params.set('to', DateTime.fromISO(to, { zone: tz }).plus({ days: 1 }).toISO()!);
  if (status) params.set('status', status);
  if (staffId) params.set('staffId', staffId);
  const q = useQuery({
    queryKey: ['bookings', 'owner', params.toString()],
    queryFn: () => get<{ bookings: BookingDto[] }>(`/bookings?${params}`),
  });

  return (
    <>
      <PageHeader title="Bookings" />
      <form
        className="mb-6 grid gap-3 sm:grid-cols-4"
        onSubmit={(e) => e.preventDefault()}
        aria-label="Filter bookings"
      >
        <Field label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Field label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Team member"
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
        >
          <option value="">Everyone</option>
          {staff.data?.staff.map((s) => (
            <option key={s.membershipId} value={s.membershipId}>
              {s.name}
            </option>
          ))}
        </SelectField>
      </form>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.bookings.length === 0 ? (
        <EmptyState title="No bookings match these filters">
          Try a wider date range or a different status.
        </EmptyState>
      ) : (
        <Panel className="px-5">
          <ul className="divide-y divide-line">
            {q.data.bookings.map((b) => (
              <BookingRow key={b.id} booking={b} showCustomer />
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
