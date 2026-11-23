import { useMutation, useQuery } from '@tanstack/react-query';
import type { BookingDto } from '@slotwise/shared';
import { DateTime } from 'luxon';
import { useState } from 'react';
import type { ApiError } from '../../lib/api';
import { get, post } from '../../lib/api';
import { useMe } from '../../lib/auth';
import { fmtDayLong, fmtTime } from '../../lib/time';
import {
  Alert,
  Button,
  cx,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Panel,
  StatusBadge,
} from '../../components/ui';
import { useToast } from '../../components/toast';
import { useInvalidateBookings } from '../booking/booking-actions';
import { useNow } from '../../lib/use-now';

/** Staff: their own appointments for a day or a week, with "completed" / "no-show" buttons. */
export function SchedulePage() {
  const me = useMe();
  const tz = me.data!.activeTenant!.timezone;
  const [view, setView] = useState<'day' | 'week'>('day');
  const [anchor, setAnchor] = useState(() => DateTime.now().setZone(tz).startOf('day'));
  const from = view === 'day' ? anchor : anchor.startOf('week');
  const to = view === 'day' ? from.plus({ days: 1 }) : from.plus({ weeks: 1 });

  const q = useQuery({
    queryKey: ['bookings', 'schedule', from.toISO(), to.toISO()],
    queryFn: () =>
      get<{ bookings: BookingDto[] }>(
        `/staff/schedule?from=${encodeURIComponent(from.toISO()!)}&to=${encodeURIComponent(to.toISO()!)}`,
      ),
  });

  const days: Map<string, BookingDto[]> = new Map();
  for (const b of q.data?.bookings ?? []) {
    const key = DateTime.fromISO(b.startAt, { zone: tz }).toISODate()!;
    days.set(key, [...(days.get(key) ?? []), b]);
  }
  const step = view === 'day' ? { days: 1 } : { weeks: 1 };

  return (
    <>
      <PageHeader title="My schedule">
        <div
          role="group"
          aria-label="View"
          className="flex rounded-[var(--radius-control)] border border-line bg-surface p-0.5"
        >
          {(['day', 'week'] as const).map((v) => (
            <button
              key={v}
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={cx(
                'rounded-md px-3 py-1.5 text-sm',
                view === v ? 'bg-ink text-white' : 'text-ink',
              )}
            >
              {v === 'day' ? 'Day' : 'Week'}
            </button>
          ))}
        </div>
      </PageHeader>
      <div className="mb-5 flex items-center gap-2">
        <Button
          variant="secondary"
          onClick={() => setAnchor((a) => a.minus(step))}
          aria-label={`Previous ${view}`}
        >
          ‹
        </Button>
        <Button
          variant="secondary"
          onClick={() => setAnchor(DateTime.now().setZone(tz).startOf('day'))}
        >
          Today
        </Button>
        <Button
          variant="secondary"
          onClick={() => setAnchor((a) => a.plus(step))}
          aria-label={`Next ${view}`}
        >
          ›
        </Button>
        <span className="ml-2 font-medium">
          {view === 'day'
            ? from.toFormat('cccc d LLLL')
            : `${from.toFormat('d LLL')} to ${to.minus({ days: 1 }).toFormat('d LLL')}`}
        </span>
      </div>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.bookings.length === 0 ? (
        <EmptyState
          title={view === 'day' ? 'No appointments this day' : 'No appointments this week'}
        />
      ) : (
        <div className="flex flex-col gap-6">
          {[...days.entries()].map(([day, list]) => (
            <section key={day}>
              {view === 'week' && (
                <h2 className="mb-2 font-semibold">{fmtDayLong(list[0]!.startAt, tz)}</h2>
              )}
              <Panel className="px-5">
                <ul className="divide-y divide-line">
                  {list.map((b) => (
                    <ScheduleItem key={b.id} booking={b} tz={tz} />
                  ))}
                </ul>
              </Panel>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function ScheduleItem({ booking, tz }: { booking: BookingDto; tz: string }) {
  const toast = useToast();
  const invalidate = useInvalidateBookings();
  const mark = useMutation({
    mutationFn: (outcome: 'complete' | 'no-show') => post(`/bookings/${booking.id}/${outcome}`),
    onSuccess: (_d, outcome) => {
      invalidate();
      toast(outcome === 'complete' ? 'Marked as completed' : 'Marked as no-show');
    },
  });
  const now = useNow(30_000);
  const started = new Date(booking.startAt).getTime() <= now;
  return (
    <li className="grid grid-cols-[5.5rem_1fr] gap-4 py-4 sm:grid-cols-[6rem_1fr_auto] sm:items-center">
      <p className="tabular font-display text-lg font-semibold">{fmtTime(booking.startAt, tz)}</p>
      <div>
        <p className="font-medium">{booking.customer.name}</p>
        <p className="text-sm text-muted">
          {booking.service.name}, until {fmtTime(booking.endAt, tz)}
        </p>
        <div className="mt-1">
          <StatusBadge status={booking.status} />
        </div>
      </div>
      {booking.status === 'CONFIRMED' && (
        <div className="col-span-2 flex gap-2 sm:col-span-1">
          <Button
            variant="secondary"
            disabled={!started}
            busy={mark.isPending && mark.variables === 'complete'}
            onClick={() => mark.mutate('complete')}
            title={started ? undefined : 'Available once the appointment starts'}
          >
            Completed
          </Button>
          <Button
            variant="danger"
            disabled={!started}
            busy={mark.isPending && mark.variables === 'no-show'}
            onClick={() => mark.mutate('no-show')}
          >
            No-show
          </Button>
        </div>
      )}
      {mark.isError && (
        <div className="col-span-full">
          <Alert>{(mark.error as ApiError).message}</Alert>
        </div>
      )}
    </li>
  );
}
