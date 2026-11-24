import { useQuery } from '@tanstack/react-query';
import { formatPaise, type BookingDto, type DashboardSummary } from '@slotwise/shared';
import { DateTime } from 'luxon';
import { Link } from 'react-router';
import { get } from '../../api/client';
import { useMe } from '../../api/session';
import { fmtTime } from '../../time/format';
import {
  Alert,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Panel,
  StatusBadge,
} from '../../components/ui';

export function OverviewPage() {
  const me = useMe();
  const tenant = me.data!.activeTenant!;
  const tz = tenant.timezone;
  const today = DateTime.now().setZone(tz).startOf('day');
  const summary = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => get<DashboardSummary>('/dashboard/summary'),
  });
  const agenda = useQuery({
    queryKey: ['bookings', 'today'],
    queryFn: () =>
      get<{ bookings: BookingDto[] }>(
        `/bookings?status=CONFIRMED&from=${encodeURIComponent(today.toISO()!)}&to=${encodeURIComponent(today.plus({ days: 1 }).toISO()!)}`,
      ),
  });

  if (summary.isPending) return <Loading />;
  if (summary.isError)
    return <ErrorState error={summary.error} onRetry={() => summary.refetch()} />;
  const s = summary.data;
  const max = Math.max(...s.revenueByWeek.map((w) => w.revenuePaise), 1);
  const thisWeek = s.revenueByWeek[s.revenueByWeek.length - 1]!;

  return (
    <>
      <PageHeader title={today.toFormat('cccc d LLLL')} />
      <p className="-mt-3 mb-8 max-w-prose text-lg text-muted">
        <span className="text-ink">
          {s.todayCount === 0
            ? 'No appointments today'
            : `${s.todayCount} appointment${s.todayCount === 1 ? '' : 's'} today`}
        </span>
        , {s.upcomingCount} confirmed in total from now on, and {formatPaise(thisWeek.revenuePaise)}{' '}
        taken this week.
      </p>

      {s.failedNotifications > 0 && (
        <div className="mb-6">
          <Alert tone="warning">
            {s.failedNotifications} customer email{s.failedNotifications === 1 ? '' : 's'} could not
            be sent.{' '}
            <Link className="font-medium underline" to="/app/emails">
              Review and resend
            </Link>
          </Alert>
        </div>
      )}

      <div className="grid gap-8 xl:grid-cols-[1fr_20rem]">
        <section>
          <h2 className="mb-3 text-lg font-semibold">Today's appointments</h2>
          {agenda.isPending ? (
            <Loading />
          ) : agenda.isError ? (
            <ErrorState error={agenda.error} onRetry={() => agenda.refetch()} />
          ) : agenda.data.bookings.length === 0 ? (
            <EmptyState title="A quiet day">
              Share your booking link <span className="font-medium text-ink">/b/{tenant.slug}</span>{' '}
              to fill it up.
            </EmptyState>
          ) : (
            <Panel className="px-5">
              <ul className="divide-y divide-line">
                {agenda.data.bookings.map((b) => (
                  <li key={b.id} className="grid grid-cols-[5rem_1fr_auto] items-center gap-3 py-3">
                    <span className="tabular font-display font-semibold">
                      {fmtTime(b.startAt, tz)}
                    </span>
                    <span>
                      <span className="block font-medium">{b.customer.name}</span>
                      <span className="text-sm text-muted">
                        {b.service.name} with {b.staff.name}
                      </span>
                    </span>
                    <StatusBadge status={b.status} />
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </section>

        <section aria-labelledby="revenue-heading">
          <h2 id="revenue-heading" className="mb-3 text-lg font-semibold">
            Payments received, last 8 weeks
          </h2>
          <Panel className="p-5">
            <ul className="flex h-40 items-end gap-2" aria-label="Weekly revenue">
              {s.revenueByWeek.map((w) => (
                <li
                  key={w.weekStart}
                  className="flex h-full flex-1 flex-col justify-end"
                  title={`${formatPaise(w.revenuePaise)} in the week of ${w.weekStart}`}
                >
                  <span className="sr-only">
                    Week of {DateTime.fromISO(w.weekStart).toFormat('d LLL')}:{' '}
                    {formatPaise(w.revenuePaise)}
                  </span>
                  <span
                    aria-hidden
                    className="block rounded-t-[3px] bg-peacock"
                    style={{
                      height: `${Math.max((w.revenuePaise / max) * 100, w.revenuePaise ? 4 : 1)}%`,
                      opacity: w.revenuePaise ? 1 : 0.25,
                    }}
                  />
                </li>
              ))}
            </ul>
            <div aria-hidden className="mt-2 flex justify-between text-xs text-muted">
              <span>{DateTime.fromISO(s.revenueByWeek[0]!.weekStart).toFormat('d LLL')}</span>
              <span>This week</span>
            </div>
          </Panel>
        </section>
      </div>
    </>
  );
}
