import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatPaise,
  type BookingDto,
  type CreateOrderResponse,
  type MeResponse,
  HOLD_MINUTES,
} from '@slotwise/shared';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError, get, post } from '../../api/client';
import { useMe } from '../../api/session';
import { countdown, fmtDayLong, fmtTime } from '../../time/format';
import { Alert, Button, ErrorState, Loading, Panel, Spinner } from '../../components/ui';
import { BookingShell } from './booking-page';
import { openRazorpayCheckout } from './razorpay';
import { useNow } from '../../time/use-now';

/**
 * Checkout: hold countdown → pay → "processing" → confirmed.
 * The browser never decides that a booking is paid. After paying we poll the
 * booking until the payment webhook (server-to-server) has confirmed it.
 */
export function CheckoutPage() {
  const { slug = '', bookingId = '' } = useParams();
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [paying, setPaying] = useState(false); // true once payment was handed to the provider
  const [error, setError] = useState('');
  const [order, setOrder] = useState<CreateOrderResponse | null>(null);

  const booking = useQuery({
    queryKey: ['booking', bookingId],
    queryFn: () => get<BookingDto>(`/bookings/${bookingId}`),
    enabled: Boolean(me.data),
    // While waiting for the webhook, check every 1.5 seconds.
    refetchInterval: (q) => (paying && q.state.data?.status === 'HELD' ? 1500 : false),
  });

  const now = useNow(1000);
  const b = booking.data;
  const tz = me.data?.activeTenant?.timezone ?? 'Asia/Kolkata';
  const left = b?.holdExpiresAt ? countdown(b.holdExpiresAt, now) : null;

  const startPayment = useMutation({
    mutationFn: () => post<CreateOrderResponse>('/payments/order', { bookingId }),
    onSuccess: async (o) => {
      setOrder(o);
      if (o.provider === 'razorpay') {
        try {
          await openRazorpayCheckout(o, () => setPaying(true));
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Could not open the payment window.');
        }
      }
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'Could not start the payment.'),
  });

  const simulate = useMutation({
    mutationFn: (outcome: 'capture' | 'fail') =>
      post(`/dev/mock-payments/${order!.orderId}/${outcome}`),
    onSuccess: (_d, outcome) => {
      if (outcome === 'capture') setPaying(true);
      else setError('The test payment failed. Your time is still held, so you can try again.');
      qc.invalidateQueries({ queryKey: ['booking', bookingId] });
    },
  });

  const cancelHold = useMutation({
    mutationFn: () => post(`/bookings/${bookingId}/cancel`),
    onSuccess: () => navigate(`/b/${slug}`),
  });

  // Give up polling after a minute and say so honestly.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!paying) return;
    const t = setTimeout(() => setSlow(true), 60_000);
    return () => clearTimeout(t);
  }, [paying]);

  if (me.isPending || booking.isPending)
    return (
      <BookingShell>
        <Loading />
      </BookingShell>
    );
  if (!me.data) {
    return (
      <BookingShell>
        <Alert tone="info">
          Please{' '}
          <Link className="underline" to={`/login?b=${slug}&next=/b/${slug}/checkout/${bookingId}`}>
            log in
          </Link>{' '}
          to continue.
        </Alert>
      </BookingShell>
    );
  }
  if (booking.isError || !b)
    return (
      <BookingShell>
        <ErrorState error={booking.error} onRetry={() => booking.refetch()} />
      </BookingShell>
    );

  return (
    <BookingShell>
      <div className="mx-auto max-w-xl">
        {b.status === 'CONFIRMED' ? (
          <Confirmed booking={b} tz={tz} me={me.data} />
        ) : b.status === 'HELD' && paying ? (
          <Panel className="p-8 text-center">
            <Spinner />
            <h1 className="mt-4 text-2xl font-semibold">Confirming your payment</h1>
            <p className="mt-2 text-muted">
              This usually takes a few seconds. Please keep this page open.
            </p>
            {slow && (
              <div className="mt-4">
                <Alert tone="warning">
                  It's taking longer than usual. If your payment went through, your booking will be
                  confirmed and you'll get an email. Check{' '}
                  <Link className="underline" to="/app/bookings">
                    your bookings
                  </Link>{' '}
                  in a few minutes.
                </Alert>
              </div>
            )}
          </Panel>
        ) : b.status === 'HELD' && left ? (
          <>
            <div
              className="rounded-[var(--radius-panel)] border-2 border-marigold bg-marigold-tint px-5 py-4"
              role="timer"
              aria-live="off"
            >
              <p className="text-sm">We're holding this time for you</p>
              <p className="tabular font-display text-4xl font-semibold">{left}</p>
            </div>
            <Summary booking={b} tz={tz} />
            {error && (
              <div className="mt-4">
                <Alert>{error}</Alert>
              </div>
            )}
            {order?.provider === 'mock' ? (
              <Panel className="mt-4 p-5">
                <p className="font-medium">Test payment</p>
                <p className="mt-1 text-sm text-muted">
                  This environment uses a simulated payment provider. The real webhook code still
                  runs.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    busy={simulate.isPending && simulate.variables === 'capture'}
                    onClick={() => {
                      setError('');
                      simulate.mutate('capture');
                    }}
                  >
                    Pay {formatPaise(order.amountPaise, order.currency)}
                  </Button>
                  <Button
                    variant="secondary"
                    busy={simulate.isPending && simulate.variables === 'fail'}
                    onClick={() => simulate.mutate('fail')}
                  >
                    Simulate a failed payment
                  </Button>
                </div>
              </Panel>
            ) : (
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <Button
                  busy={startPayment.isPending}
                  onClick={() => {
                    setError('');
                    startPayment.mutate();
                  }}
                >
                  Pay {formatPaise(b.pricePaise, me.data.activeTenant?.currency ?? 'INR')}
                </Button>
                <Button
                  variant="ghost"
                  busy={cancelHold.isPending}
                  onClick={() => cancelHold.mutate()}
                >
                  Choose a different time
                </Button>
              </div>
            )}
          </>
        ) : (
          <Panel className="p-8">
            <h1 className="text-2xl font-semibold">Your hold has ended</h1>
            <p className="mt-2 text-muted">
              We kept this time for {HOLD_MINUTES} minutes. It may still be free, so pick it again
              to continue. If you already paid, you'll get an email and either a confirmed booking
              or an automatic refund.
            </p>
            <div className="mt-5">
              <Link className="font-medium text-peacock underline" to={`/b/${slug}`}>
                Pick a time
              </Link>
            </div>
          </Panel>
        )}
      </div>
    </BookingShell>
  );
}

function Summary({ booking, tz }: { booking: BookingDto; tz: string }) {
  return (
    <dl className="mt-5 grid grid-cols-[7rem_1fr] gap-y-2 text-[15px]">
      <dt className="text-muted">Service</dt>
      <dd>{booking.service.name}</dd>
      <dt className="text-muted">With</dt>
      <dd>{booking.staff.name}</dd>
      <dt className="text-muted">When</dt>
      <dd className="tabular">
        {fmtDayLong(booking.startAt, tz)}, {fmtTime(booking.startAt, tz)} to{' '}
        {fmtTime(booking.endAt, tz)}
      </dd>
      <dt className="text-muted">Price</dt>
      <dd className="tabular">{formatPaise(booking.pricePaise)}</dd>
    </dl>
  );
}

function Confirmed({ booking, tz, me }: { booking: BookingDto; tz: string; me: MeResponse }) {
  return (
    <Panel className="p-8">
      <p className="text-sm font-medium text-peacock">Booking confirmed</p>
      <h1 className="mt-1 text-3xl font-semibold">See you {fmtDayLong(booking.startAt, tz)}</h1>
      <Summary booking={booking} tz={tz} />
      <p className="mt-5 text-sm text-muted">
        A confirmation is on its way to {me.user.email}, and we'll remind you a day before.
      </p>
      <div className="mt-6">
        <Link className="font-medium text-peacock underline" to="/app/bookings">
          See my bookings
        </Link>
      </div>
    </Panel>
  );
}
