import { useQuery } from '@tanstack/react-query';
import type { OpenDaysResponse, SlotsResponse } from '@slotwise/shared';
import { get } from '../../api/client';
import { dt, groupByHour, nextDates } from '../../time/format';
import { cx, ErrorState, Loading } from '../../components/ui';

/**
 * Open-slot counts for the next `days` days, so the strip can grey out closed
 * or fully booked days and the page can start on the first open one.
 */
export function useOpenDays(
  slug: string,
  serviceId: string | undefined,
  staffId: string | undefined,
  tz: string,
  days: number,
) {
  const from = nextDates(tz, 1)[0]!;
  const enabled = Boolean(serviceId && staffId);
  const q = useQuery({
    queryKey: ['open-days', slug, serviceId, staffId, from, days],
    queryFn: () =>
      get<OpenDaysResponse>(
        `/public/${slug}/days?serviceId=${serviceId}&staffId=${staffId}&from=${from}&days=${days}`,
      ),
    enabled,
    refetchInterval: 60_000,
  });
  const counts = q.data
    ? Object.fromEntries(q.data.days.map((d) => [d.date, d.openSlots]))
    : undefined;
  const firstOpen = q.data?.days.find((d) => d.openSlots > 0)?.date;
  return { counts, firstOpen };
}

/** Horizontal strip of the next N days. Days with no open times are greyed out. */
export function DateStrip({
  tz,
  days,
  value,
  onChange,
  openSlots,
}: {
  tz: string;
  days: number;
  value: string;
  onChange: (date: string) => void;
  openSlots?: Record<string, number> | undefined;
}) {
  const dates = nextDates(tz, days);
  return (
    <div
      role="radiogroup"
      aria-label="Day"
      className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-2"
    >
      {dates.map((d) => {
        const day = dt(d, tz);
        const selected = d === value;
        const none = openSlots !== undefined && !openSlots[d];
        return (
          <button
            key={d}
            role="radio"
            aria-checked={selected}
            aria-label={`${day.toFormat('cccc d LLLL')}${none ? ', no open times' : ''}`}
            onClick={() => onChange(d)}
            className={cx(
              'flex min-w-14 shrink-0 flex-col items-center rounded-[var(--radius-control)] border px-2 py-2 transition-colors',
              selected
                ? 'border-peacock bg-peacock text-white'
                : none
                  ? 'border-dashed border-line bg-transparent text-muted'
                  : 'border-line bg-surface hover:border-ink/40',
            )}
          >
            <span className={cx('text-xs', selected ? 'text-white/80' : 'text-muted')}>
              {day.toFormat('ccc')}
            </span>
            <span className="tabular font-display text-lg font-semibold leading-tight">
              {day.toFormat('d')}
            </span>
            <span className={cx('text-[11px]', selected ? 'text-white/80' : 'text-muted')}>
              {day.toFormat('LLL')}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The day as a page of an appointment book: an hour rail on the left and the
 * open times beside it. This is the one place the design is allowed to be loud.
 */
export function SlotTimeline({
  slug,
  serviceId,
  staffId,
  date,
  tz,
  selected,
  onPick,
}: {
  slug: string;
  serviceId: string;
  staffId: string;
  date: string;
  tz: string;
  selected: string | null;
  onPick: (startAt: string) => void;
}) {
  const q = useQuery({
    queryKey: ['slots', slug, serviceId, staffId, date],
    queryFn: () =>
      get<SlotsResponse>(
        `/public/${slug}/slots?serviceId=${serviceId}&staffId=${staffId}&date=${date}`,
      ),
    refetchInterval: 30_000, // slots get taken; keep the page honest
  });
  if (q.isPending) return <Loading label="Finding open times" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.data.slots.length === 0) {
    return (
      <p className="rounded-[var(--radius-panel)] border border-dashed border-line px-5 py-8 text-center text-muted">
        No open times on {dt(date, tz).toFormat('cccc d LLLL')}. Try another day.
      </p>
    );
  }
  return (
    <ol
      aria-label={`Open times on ${dt(date, tz).toFormat('cccc d LLLL')}`}
      className="border-l-2 border-line"
    >
      {groupByHour(q.data.slots, tz).map((group) => (
        <li key={group.hour} className="relative grid grid-cols-[4.5rem_1fr] gap-3 py-2">
          <span className="tabular -ml-px border-l-2 border-ink pl-3 text-sm font-medium text-muted">
            {group.hour}
          </span>
          <div className="flex flex-wrap gap-2">
            {group.slots.map((s) => {
              const isSel = s.startAt === selected;
              return (
                <button
                  key={s.startAt}
                  onClick={() => onPick(s.startAt)}
                  aria-pressed={isSel}
                  className={cx(
                    'tabular h-10 min-w-[5.5rem] rounded-[var(--radius-control)] border px-3 text-sm font-medium transition-colors',
                    isSel
                      ? 'border-marigold bg-marigold-tint text-ink ring-2 ring-marigold'
                      : 'border-peacock/30 bg-surface text-peacock-dark hover:border-peacock hover:bg-peacock-tint',
                  )}
                >
                  {dt(s.startAt, tz).toFormat('h:mm')}
                </button>
              );
            })}
          </div>
        </li>
      ))}
    </ol>
  );
}
