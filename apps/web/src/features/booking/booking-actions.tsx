import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatPaise, type BookingDto } from '@slotwise/shared';
import { useState } from 'react';
import type { ApiError } from '../../api/client';
import { post } from '../../api/client';
import { useMe } from '../../api/session';
import { dt, fmtDateTime, fmtTime, nextDates } from '../../time/format';
import { Alert, Button, Dialog, StatusBadge } from '../../components/ui';
import { useToast } from '../../components/toast';
import { useNow } from '../../time/use-now';
import { DateStrip, SlotTimeline, useOpenDays } from './slot-picker';

function useInvalidateBookings() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['bookings'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
}

/** One booking as a row: when, what, who, status, and the actions this user may take. */
export function BookingRow({
  booking,
  showCustomer,
}: {
  booking: BookingDto;
  showCustomer?: boolean;
}) {
  const me = useMe();
  const tz = me.data?.activeTenant?.timezone ?? 'Asia/Kolkata';
  const [dialog, setDialog] = useState<'cancel' | 'reschedule' | null>(null);
  const refund =
    booking.payment?.status === 'REFUND_PENDING' || booking.payment?.status === 'REFUNDED';

  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="tabular font-medium">
          {fmtDateTime(booking.startAt, tz)} to {fmtTime(booking.endAt, tz)}
        </p>
        <p className="text-[15px] text-muted">
          {booking.service.name} with {booking.staff.name}
          {showCustomer && <> for {booking.customer.name}</>}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge status={booking.status} />
          {booking.payment && (
            <span className="text-muted">
              {refund
                ? `Refund ${booking.payment.status === 'REFUNDED' ? 'issued' : 'in progress'}: ${formatPaise(booking.payment.amountPaise)}`
                : booking.payment.status === 'CAPTURED'
                  ? `Paid ${formatPaise(booking.payment.amountPaise)}`
                  : null}
            </span>
          )}
        </div>
      </div>
      {(booking.canCancel || booking.canReschedule) && (
        <div className="flex shrink-0 gap-2">
          {booking.canReschedule && (
            <Button variant="secondary" onClick={() => setDialog('reschedule')}>
              Reschedule
            </Button>
          )}
          {booking.canCancel && (
            <Button variant="danger" onClick={() => setDialog('cancel')}>
              Cancel
            </Button>
          )}
        </div>
      )}
      <CancelDialog booking={booking} open={dialog === 'cancel'} onClose={() => setDialog(null)} />
      {dialog === 'reschedule' && (
        <RescheduleDialog booking={booking} onClose={() => setDialog(null)} />
      )}
    </li>
  );
}

function CancelDialog({
  booking,
  open,
  onClose,
}: {
  booking: BookingDto;
  open: boolean;
  onClose: () => void;
}) {
  const me = useMe();
  const toast = useToast();
  const invalidate = useInvalidateBookings();
  const tenant = me.data?.activeTenant;
  const isOwner = tenant?.role === 'OWNER';
  const now = useNow();
  const hoursLeft = (new Date(booking.startAt).getTime() - now) / 3600_000;
  const refunds =
    booking.status === 'CONFIRMED' &&
    (isOwner || hoursLeft >= (tenant?.cancellationWindowHours ?? 0));
  const cancel = useMutation({
    mutationFn: () => post<BookingDto>(`/bookings/${booking.id}/cancel`),
    onSuccess: () => {
      invalidate();
      toast('Booking cancelled');
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="Cancel this booking?">
      <p className="text-[15px]">
        {booking.service.name} on {fmtDateTime(booking.startAt, tenant?.timezone ?? 'Asia/Kolkata')}
        .
      </p>
      <p className="mt-2 text-[15px] text-muted">
        {booking.status === 'HELD'
          ? "You haven't paid yet, so nothing will be charged."
          : refunds
            ? `${isOwner ? 'The customer' : 'You'} will get a full refund of ${formatPaise(booking.pricePaise)}.`
            : `This is less than ${tenant?.cancellationWindowHours} hours before the appointment, so no refund applies.`}
      </p>
      {cancel.isError && (
        <div className="mt-3">
          <Alert>{(cancel.error as ApiError).message}</Alert>
        </div>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Keep booking
        </Button>
        <Button variant="danger" busy={cancel.isPending} onClick={() => cancel.mutate()}>
          Cancel booking
        </Button>
      </div>
    </Dialog>
  );
}

function RescheduleDialog({ booking, onClose }: { booking: BookingDto; onClose: () => void }) {
  const me = useMe();
  const toast = useToast();
  const invalidate = useInvalidateBookings();
  const tenant = me.data!.activeTenant!;
  const tz = tenant.timezone;
  const [date, setDate] = useState(() => {
    const d = dt(booking.startAt, tz).toISODate()!;
    return nextDates(tz, 60).includes(d) ? d : nextDates(tz, 1)[0]!;
  });
  const [time, setTime] = useState<string | null>(null);
  const stripDays = Math.min(tenant.bookingHorizonDays, 21);
  const openDays = useOpenDays(
    tenant.slug,
    booking.service.id,
    booking.staff.membershipId,
    tz,
    stripDays,
  );
  const move = useMutation({
    mutationFn: () => post<BookingDto>(`/bookings/${booking.id}/reschedule`, { startAt: time }),
    onSuccess: () => {
      invalidate();
      toast('Booking moved');
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Move to another time">
      <p className="mb-4 text-sm text-muted">
        {booking.service.name} with {booking.staff.name}. Currently{' '}
        {fmtDateTime(booking.startAt, tz)}.
      </p>
      <DateStrip
        tz={tz}
        days={stripDays}
        value={date}
        openSlots={openDays.counts}
        onChange={(d) => {
          setDate(d);
          setTime(null);
        }}
      />
      <div className="mt-4 max-h-72 overflow-y-auto pr-1">
        <SlotTimeline
          slug={tenant.slug}
          serviceId={booking.service.id}
          staffId={booking.staff.membershipId}
          date={date}
          tz={tz}
          selected={time}
          onPick={setTime}
        />
      </div>
      {move.isError && (
        <div className="mt-3">
          <Alert>{(move.error as ApiError).message}</Alert>
        </div>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Keep current time
        </Button>
        <Button disabled={!time} busy={move.isPending} onClick={() => move.mutate()}>
          {time ? `Move to ${fmtDateTime(time, tz)}` : 'Pick a time'}
        </Button>
      </div>
    </Dialog>
  );
}

export { useInvalidateBookings };
