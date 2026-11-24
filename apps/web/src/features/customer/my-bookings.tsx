import { useQuery } from '@tanstack/react-query';
import type { BookingDto } from '@slotwise/shared';
import { Link } from 'react-router';
import { get } from '../../api/client';
import { useMe } from '../../api/session';
import { EmptyState, ErrorState, Loading, PageHeader, Panel } from '../../components/ui';
import { BookingRow } from '../booking/booking-actions';
import { useNow } from '../../time/use-now';

export function MyBookingsPage() {
  const me = useMe();
  const tenant = me.data!.activeTenant!;
  const q = useQuery({
    queryKey: ['bookings', 'mine', tenant.id],
    queryFn: () => get<{ bookings: BookingDto[] }>('/bookings/mine'),
  });
  const now = useNow();
  const upcoming = q.data?.bookings
    .filter(
      (b) => new Date(b.endAt).getTime() > now && (b.status === 'CONFIRMED' || b.status === 'HELD'),
    )
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  const past = q.data?.bookings.filter((b) => !upcoming?.includes(b));

  return (
    <>
      <PageHeader title={`Your bookings at ${tenant.name}`} />
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.bookings.length === 0 ? (
        <EmptyState title="No bookings yet">
          <Link className="font-medium text-peacock underline" to={`/b/${tenant.slug}`}>
            Book an appointment
          </Link>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-8">
          <section>
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-lg font-semibold">Coming up</h2>
              <Link
                className="text-sm font-medium text-peacock hover:underline"
                to={`/b/${tenant.slug}`}
              >
                Book another
              </Link>
            </div>
            {upcoming!.length ? (
              <Panel className="px-5">
                <ul className="divide-y divide-line">
                  {upcoming!.map((b) => (
                    <BookingRow key={b.id} booking={b} />
                  ))}
                </ul>
              </Panel>
            ) : (
              <p className="text-muted">Nothing booked right now.</p>
            )}
          </section>
          {past!.length > 0 && (
            <section>
              <h2 className="mb-2 text-lg font-semibold">Past and cancelled</h2>
              <Panel className="px-5">
                <ul className="divide-y divide-line">
                  {past!.map((b) => (
                    <BookingRow key={b.id} booking={b} />
                  ))}
                </ul>
              </Panel>
            </section>
          )}
        </div>
      )}
    </>
  );
}
