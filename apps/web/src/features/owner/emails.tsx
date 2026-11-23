import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMe } from '../../lib/auth';
import { get, post } from '../../lib/api';
import { fmtDateTime } from '../../lib/time';
import { Button, EmptyState, ErrorState, Loading, PageHeader, Panel } from '../../components/ui';
import { useToast } from '../../components/toast';

interface Notification {
  id: string;
  bookingId: string;
  type: string;
  status: string;
  attempts: number;
  lastError: string | null;
  scheduledFor: string;
}

const TYPES: Record<string, string> = {
  BOOKING_CONFIRMED: 'Booking confirmation',
  BOOKING_REMINDER: 'Reminder',
  BOOKING_CANCELLED: 'Cancellation notice',
  LATE_PAYMENT_REFUNDED: 'Refund notice',
};

/** Customer emails that failed after every automatic retry. */
export function EmailsPage() {
  const me = useMe();
  const tz = me.data!.activeTenant!.timezone;
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['notifications', 'failed'],
    queryFn: () => get<{ notifications: Notification[] }>('/notifications?status=FAILED'),
  });
  const retry = useMutation({
    mutationFn: (id: string) => post(`/notifications/${id}/retry`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast('Queued to send again');
    },
  });
  return (
    <>
      <PageHeader title="Email problems" />
      <p className="-mt-3 mb-6 max-w-prose text-muted">
        Slotwise retries every email six times over a few minutes. These still didn't go through.
      </p>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.notifications.length === 0 ? (
        <EmptyState title="All emails delivered">Nothing needs your attention.</EmptyState>
      ) : (
        <Panel className="px-5">
          <ul className="divide-y divide-line">
            {q.data.notifications.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div>
                  <p className="font-medium">{TYPES[n.type] ?? n.type}</p>
                  <p className="text-sm text-muted">
                    Due {fmtDateTime(n.scheduledFor, tz)}, tried {n.attempts} times. {n.lastError}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  busy={retry.isPending && retry.variables === n.id}
                  onClick={() => retry.mutate(n.id)}
                >
                  Send again
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
