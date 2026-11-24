import { useMutation, useQuery } from '@tanstack/react-query';
import {
  formatPaise,
  HOLD_MINUTES,
  type BookingDto,
  type PublicTenantResponse,
} from '@slotwise/shared';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMemo, useState } from 'react';
import { ApiError, get, post } from '../../api/client';
import { useMe, useSwitchTenant } from '../../api/session';
import { fmtDayLong, fmtTime, nextDates } from '../../time/format';
import { Alert, Button, cx, ErrorState, Loading } from '../../components/ui';
import { Wordmark } from '../../components/layout';
import { DateStrip, SlotTimeline, useOpenDays } from './slot-picker';

/**
 * The public page customers land on: /b/{slug}.
 * Everything the customer picks lives in the URL (?service=&staff=&date=&time=),
 * so the choice survives logging in halfway through and can be shared.
 */
export function BookingPage() {
  const { slug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const me = useMe();
  const switchTenant = useSwitchTenant();

  const page = useQuery({
    queryKey: ['public', slug],
    queryFn: () => get<PublicTenantResponse>(`/public/${slug}`),
  });

  const tz = page.data?.tenant.timezone ?? 'Asia/Kolkata';
  const serviceId = params.get('service');
  const time = params.get('time');

  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  const service = page.data?.services.find((s) => s.id === serviceId);
  const staffForService = useMemo(
    () => page.data?.staff.filter((s) => serviceId && s.serviceIds.includes(serviceId)) ?? [],
    [page.data, serviceId],
  );
  // With several people offering the service, customers can also pick "Anyone available".
  const staffOptions = useMemo(
    () =>
      staffForService.length > 1
        ? [{ membershipId: 'any', name: 'Anyone available', serviceIds: [] }, ...staffForService]
        : staffForService,
    [staffForService],
  );
  // With only one person offering the service, they are the choice; nothing to pick.
  const staffId =
    params.get('staff') ?? (staffForService.length === 1 ? staffForService[0]!.membershipId : null);
  const staff = staffOptions.find((s) => s.membershipId === staffId);
  const isAny = staff?.membershipId === 'any';

  const stripDays = Math.min(page.data?.tenant.bookingHorizonDays ?? 21, 21);
  const openDays = useOpenDays(slug, serviceId ?? undefined, staffId ?? undefined, tz, stripDays);
  // Until the customer picks a day, show the first day that has open times.
  const date = params.get('date') ?? openDays.firstOpen ?? nextDates(tz, 1)[0]!;

  const [holdError, setHoldError] = useState('');
  const hold = useMutation({
    mutationFn: async () => {
      // Make this business the active one (joining as a customer if needed).
      if (me.data?.activeTenant?.slug !== slug)
        await switchTenant.mutateAsync({ slug, joinAsCustomer: true });
      return post<BookingDto>('/bookings/hold', { serviceId, staffId, startAt: time });
    },
    onSuccess: (b) => navigate(`/b/${slug}/checkout/${b.id}`),
    onError: (err) => {
      setHoldError(
        err instanceof ApiError ? err.message : 'Could not hold that time. Please try again.',
      );
      if (err instanceof ApiError && err.code === 'SLOT_TAKEN') set({ time: null });
    },
  });

  if (page.isPending)
    return (
      <Shell>
        <Loading />
      </Shell>
    );
  if (page.isError) {
    return (
      <Shell>
        {page.error instanceof ApiError && page.error.status === 404 ? (
          <div className="py-16">
            <h1 className="text-3xl font-semibold">We couldn't find that booking page</h1>
            <p className="mt-2 text-muted">
              Check the link with the business, or go back to the{' '}
              <Link className="text-peacock underline" to="/">
                home page
              </Link>
              .
            </p>
          </div>
        ) : (
          <ErrorState error={page.error} onRetry={() => page.refetch()} />
        )}
      </Shell>
    );
  }

  const t = page.data.tenant;
  const isTeamMember = me.data?.memberships.some(
    (m) => m.tenantSlug === slug && m.role !== 'CUSTOMER',
  );
  const here = `/b/${slug}?${params}`;

  return (
    <Shell>
      <div className="grid gap-2 lg:grid-cols-[22rem_minmax(0,1fr)] lg:gap-10">
        {/* Left: who and what */}
        <div className="lg:sticky lg:top-6 lg:self-start">
          <h1 className="text-4xl font-semibold leading-tight">{t.name}</h1>
          <p className="mt-3 text-sm text-muted">
            {t.cancellationWindowHours > 0
              ? `Free cancellation up to ${t.cancellationWindowHours} hours before your appointment.`
              : 'Free cancellation any time before your appointment.'}{' '}
            Times shown in {t.timezone.replace('_', ' ')}.
          </p>

          <Step n={1} title="Choose a service">
            {page.data.services.length === 0 ? (
              <p className="text-muted">This business hasn't listed any services yet.</p>
            ) : (
              <div role="radiogroup" aria-label="Service" className="flex flex-col gap-2">
                {page.data.services.map((s) => {
                  const sel = s.id === serviceId;
                  return (
                    <button
                      key={s.id}
                      role="radio"
                      aria-checked={sel}
                      onClick={() => set({ service: s.id, staff: null, time: null })}
                      className={cx(
                        'flex items-baseline justify-between gap-4 rounded-[var(--radius-control)] border px-4 py-3 text-left transition-colors',
                        sel
                          ? 'border-peacock bg-peacock-tint'
                          : 'border-line bg-surface hover:border-ink/40',
                      )}
                    >
                      <span>
                        <span className="block font-medium">{s.name}</span>
                        <span className="text-sm text-muted">{s.durationMinutes} min</span>
                      </span>
                      <span className="tabular font-medium">
                        {formatPaise(s.pricePaise, t.currency)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Step>

          {serviceId && (
            <Step n={2} title="Who would you like?">
              <div role="radiogroup" aria-label="Staff member" className="flex flex-wrap gap-2">
                {staffOptions.map((s) => {
                  const sel = s.membershipId === staffId;
                  return (
                    <button
                      key={s.membershipId}
                      role="radio"
                      aria-checked={sel}
                      onClick={() => set({ staff: s.membershipId, time: null })}
                      className={cx(
                        'rounded-full border px-4 py-2 text-sm font-medium transition-colors',
                        sel
                          ? 'border-peacock bg-peacock text-white'
                          : 'border-line bg-surface hover:border-ink/40',
                      )}
                    >
                      {s.name}
                    </button>
                  );
                })}
              </div>
            </Step>
          )}
        </div>

        {/* Right: when */}
        <div className="min-w-0">
          {!service || !staff ? (
            <div className="hidden rounded-[var(--radius-panel)] border border-dashed border-line p-10 text-center text-muted lg:block">
              Pick a service{service ? ' and a person' : ''} to see open times.
            </div>
          ) : (
            <Step n={3} title="Pick a time">
              <DateStrip
                tz={tz}
                days={stripDays}
                value={date}
                openSlots={openDays.counts}
                onChange={(d) => set({ date: d, time: null })}
              />
              {openDays.counts && !openDays.firstOpen && (
                <p className="mt-2 text-sm text-muted">
                  {isAny ? 'Nobody' : staff.name} has no open times in the next {stripDays} days.{' '}
                  {isAny ? 'Please check back later.' : 'Try someone else, or check back later.'}
                </p>
              )}
              <div className="mt-5">
                <SlotTimeline
                  slug={slug}
                  serviceId={service.id}
                  staffId={staff.membershipId}
                  date={date}
                  tz={tz}
                  selected={time}
                  onPick={(startAt) => {
                    setHoldError('');
                    set({ time: startAt });
                  }}
                />
              </div>

              {time && (
                <div className="mt-6 rounded-[var(--radius-panel)] border-2 border-marigold bg-marigold-tint p-5">
                  <p className="text-xl font-semibold">
                    {service.name} {isAny ? 'with whoever is free' : `with ${staff.name}`}
                  </p>
                  <p className="tabular mt-1">
                    {fmtDayLong(time, tz)} at {fmtTime(time, tz)},{' '}
                    {formatPaise(service.pricePaise, t.currency)}
                  </p>
                  {holdError && (
                    <div className="mt-3">
                      <Alert>{holdError}</Alert>
                    </div>
                  )}
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    {me.data ? (
                      isTeamMember ? (
                        <Alert tone="info">
                          You're on this business's team, so you can't book here as a customer.
                        </Alert>
                      ) : (
                        <Button busy={hold.isPending} onClick={() => hold.mutate()}>
                          Hold this time and pay
                        </Button>
                      )
                    ) : (
                      <>
                        <Button
                          onClick={() =>
                            navigate(`/login?b=${slug}&next=${encodeURIComponent(here)}`)
                          }
                        >
                          Log in to book
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() =>
                            navigate(`/register?b=${slug}&next=${encodeURIComponent(here)}`)
                          }
                        >
                          Create an account
                        </Button>
                      </>
                    )}
                  </div>
                  <p className="mt-3 text-sm text-muted">
                    We'll hold it for {HOLD_MINUTES} minutes while you pay.
                  </p>
                </div>
              )}
            </Step>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 flex items-center gap-3 text-lg font-semibold">
        <span
          aria-hidden
          className="tabular flex size-7 items-center justify-center rounded-full border-2 border-ink text-sm"
        >
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const me = useMe();
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <Wordmark />
        {me.data ? (
          <Link to="/app" className="text-sm font-medium text-peacock hover:underline">
            My bookings
          </Link>
        ) : null}
      </header>
      <main className="mx-auto max-w-6xl px-5 pb-20">{children}</main>
    </div>
  );
}

export { Shell as BookingShell };
