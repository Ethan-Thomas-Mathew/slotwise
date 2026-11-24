import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { get } from '../../lib/api';
import { useMe } from '../../lib/auth';
import { fmtDateTime } from '../../lib/time';
import {
  Button,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Panel,
  SelectField,
} from '../../components/ui';

interface Log {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  actor: { name: string; email: string } | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

const ENTITIES = [
  ['', 'Everything'],
  ['booking', 'Bookings'],
  ['service', 'Services'],
  ['membership', 'Team and hours'],
  ['time_off', 'Time off'],
  ['tenant', 'Settings'],
  ['payment', 'Payments'],
] as const;

/** Plain-language names for audit actions. */
const ACTIONS: Record<string, string> = {
  'tenant.create': 'created the business',
  'tenant.settings.update': 'changed settings',
  'service.create': 'added a service',
  'service.update': 'edited a service',
  'service.delete': 'deleted a service',
  'staff.invite': 'invited a team member',
  'staff.join': 'joined the team',
  'staff.remove': 'removed a team member',
  'staff.services.update': "changed someone's services",
  'availability.update': 'changed working hours',
  'time_off.create': 'added time off',
  'time_off.delete': 'removed time off',
  'booking.confirm': 'booking confirmed by payment',
  'booking.cancel': 'cancelled a booking',
  'booking.reschedule': 'moved a booking',
  'booking.complete': 'marked a booking completed',
  'booking.no_show': 'marked a no-show',
  'payment.auto_refund': 'automatic refund',
  'payment.amount_mismatch':
    'received a payment for the wrong amount (not applied; refund it from the payment provider)',
  'notification.retry': 'resent an email',
};

export function ActivityPage() {
  const me = useMe();
  const tz = me.data!.activeTenant!.timezone;
  const [entity, setEntity] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['audit', entity],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      get<{ logs: Log[] }>(
        `/audit-logs?limit=50${entity ? `&entity=${entity}` : ''}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (last) => (last.logs.length === 50 ? last.logs.at(-1)!.createdAt : undefined),
  });
  const logs = q.data?.pages.flatMap((p) => p.logs) ?? [];

  return (
    <>
      <PageHeader title="Activity log" />
      <div className="mb-5 max-w-xs">
        <SelectField label="Show" value={entity} onChange={(e) => setEntity(e.target.value)}>
          {ENTITIES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </SelectField>
      </div>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : logs.length === 0 ? (
        <EmptyState title="Nothing recorded yet" />
      ) : (
        <Panel className="px-5">
          <ul className="divide-y divide-line">
            {logs.map((l) => (
              <li key={l.id} className="py-3">
                <details>
                  <summary className="cursor-pointer list-none">
                    <span className="font-medium">{l.actor?.name ?? 'System'}</span>{' '}
                    {ACTIONS[l.action] ?? l.action}
                    <span className="tabular ml-2 text-sm text-muted">
                      {fmtDateTime(l.createdAt, tz)}
                    </span>
                  </summary>
                  <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                    {l.before != null && <Json label="Before" value={l.before} />}
                    {l.after != null && <Json label="After" value={l.after} />}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {q.hasNextPage && (
        <div className="mt-4">
          <Button variant="secondary" busy={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
            Show older
          </Button>
        </div>
      )}
    </>
  );
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 text-muted">{label}</p>
      <pre className="overflow-x-auto rounded bg-paper p-2">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}
