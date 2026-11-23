import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  clockToMinutes,
  type InviteStaffResponse,
  InviteStaffRequest,
  type AvailabilityRule,
  type ServiceDto,
  type StaffDto,
} from '@slotwise/shared';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { ApiError } from '../../lib/api';
import { del, get, post, put } from '../../lib/api';
import { useMe } from '../../lib/auth';
import { fmtDateTime } from '../../lib/time';
import {
  Alert,
  Button,
  cx,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  Panel,
} from '../../components/ui';
import { useToast } from '../../components/toast';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function TeamPage() {
  const staff = useQuery({
    queryKey: ['staff'],
    queryFn: () => get<{ staff: StaffDto[] }>('/staff'),
  });
  const services = useQuery({
    queryKey: ['services'],
    queryFn: () => get<{ services: ServiceDto[] }>('/services'),
  });
  const [inviting, setInviting] = useState(false);
  const [hoursFor, setHoursFor] = useState<StaffDto | null>(null);
  const [offFor, setOffFor] = useState<StaffDto | null>(null);
  const [removing, setRemoving] = useState<StaffDto | null>(null);

  return (
    <>
      <PageHeader title="Team and hours">
        <Button onClick={() => setInviting(true)}>Invite someone</Button>
      </PageHeader>
      {staff.isPending || services.isPending ? (
        <Loading />
      ) : staff.isError ? (
        <ErrorState error={staff.error} onRetry={() => staff.refetch()} />
      ) : services.isError ? (
        <ErrorState error={services.error} onRetry={() => services.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          {staff.data.staff.map((s) => (
            <Panel key={s.membershipId} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-display text-lg font-semibold">{s.name}</p>
                  <p className="text-sm text-muted">
                    {s.email}
                    {s.role === 'OWNER' && ', owner'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => setHoursFor(s)}>
                    Working hours
                  </Button>
                  <Button variant="secondary" onClick={() => setOffFor(s)}>
                    Time off
                  </Button>
                  {s.role === 'STAFF' && (
                    <Button variant="danger" onClick={() => setRemoving(s)}>
                      Remove
                    </Button>
                  )}
                </div>
              </div>
              <StaffServices staff={s} services={services.data.services} />
            </Panel>
          ))}
          {services.data.services.length === 0 && (
            <EmptyState title="No services yet">
              Add services first, then choose who offers each one.
            </EmptyState>
          )}
        </div>
      )}
      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
      {hoursFor && <HoursDialog staff={hoursFor} onClose={() => setHoursFor(null)} />}
      {offFor && <TimeOffDialog staff={offFor} onClose={() => setOffFor(null)} />}
      {removing && <RemoveDialog staff={removing} onClose={() => setRemoving(null)} />}
    </>
  );
}

/** Toggle which services this person offers. */
function StaffServices({ staff, services }: { staff: StaffDto; services: ServiceDto[] }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (ids: string[]) =>
      put(`/staff/${staff.membershipId}/services`, { serviceIds: ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff'] }),
  });
  if (services.length === 0) return null;
  const offered = new Set(save.isPending ? save.variables : staff.serviceIds);
  return (
    <fieldset className="mt-4">
      <legend className="mb-2 text-sm text-muted">Offers</legend>
      <div className="flex flex-wrap gap-2">
        {services.map((sv) => {
          const on = offered.has(sv.id);
          return (
            <button
              key={sv.id}
              aria-pressed={on}
              onClick={() =>
                save.mutate(on ? [...offered].filter((x) => x !== sv.id) : [...offered, sv.id])
              }
              className={cx(
                'rounded-full border px-3 py-1.5 text-sm transition-colors',
                on
                  ? 'border-peacock bg-peacock-tint text-peacock-dark'
                  : 'border-line text-muted hover:border-ink/40',
              )}
            >
              {sv.name}
            </button>
          );
        })}
      </div>
      {staff.serviceIds.length === 0 && !save.isPending && (
        <p className="mt-2 text-sm text-muted">
          Customers can't book {staff.name.split(' ')[0]} until at least one service is selected.
        </p>
      )}
    </fieldset>
  );
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { register, handleSubmit, formState } = useForm({
    resolver: zodResolver(InviteStaffRequest),
  });
  const invite = useMutation({
    mutationFn: (v: { email: string; name: string }) =>
      post<InviteStaffResponse>('/staff/invites', v),
    onSuccess: (_d, v) => toast(`Invite sent to ${v.email}`),
  });
  const [copied, setCopied] = useState(false);

  // After sending: show the link too, so it can be shared directly (WhatsApp,
  // SMS) in case the email is slow or lands in spam.
  if (invite.isSuccess) {
    const link = invite.data.inviteLink;
    return (
      <Dialog open onClose={onClose} title="Invite sent">
        <p className="text-[15px]">
          We emailed {invite.variables.name} a link to join. You can also send them this link
          yourself. It works once, for 7 days.
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            readOnly
            aria-label="Invite link"
            value={link}
            onFocus={(e) => e.currentTarget.select()}
            className="h-10 min-w-0 flex-1 rounded-[var(--radius-control)] border border-line bg-paper px-3 text-sm"
          />
          <Button
            variant="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                setCopied(true);
              } catch {
                toast('Copying was blocked. Select the link and copy it.', 'error');
              }
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </div>
        <div className="mt-6 flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title="Invite a team member">
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={handleSubmit((v) => invite.mutate(v))}
      >
        {invite.isError && <Alert>{(invite.error as ApiError).message}</Alert>}
        <Field label="Name" {...register('name')} error={formState.errors.name?.message} />
        <Field
          label="Email"
          type="email"
          {...register('email')}
          error={formState.errors.email?.message}
        />
        <p className="text-sm text-muted">
          They'll get an email with a link that works for 7 days.
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={invite.isPending}>
            Send invite
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type DayRanges = { start: string; end: string }[];

/** Weekly hours: each day can have zero or more time ranges (e.g. a lunch break). */
function HoursDialog({ staff, onClose }: { staff: StaffDto; onClose: () => void }) {
  const toast = useToast();
  const q = useQuery({
    queryKey: ['availability', staff.membershipId],
    queryFn: () => get<{ rules: AvailabilityRule[] }>(`/staff/${staff.membershipId}/availability`),
  });
  const [days, setDays] = useState<DayRanges[] | null>(null);
  const current: DayRanges[] =
    days ??
    WEEKDAYS.map((_, i) =>
      (q.data?.rules ?? [])
        .filter((r) => r.weekday === i + 1)
        .map((r) => ({ start: r.start, end: r.end })),
    );
  const update = (i: number, ranges: DayRanges) =>
    setDays(current.map((d, j) => (j === i ? ranges : d)));

  const invalid = current.some((ranges) =>
    ranges.some(
      (r, k) =>
        clockToMinutes(r.end) <= clockToMinutes(r.start) || (k > 0 && r.start < ranges[k - 1]!.end),
    ),
  );
  const save = useMutation({
    mutationFn: () =>
      put(`/staff/${staff.membershipId}/availability`, {
        rules: current.flatMap((ranges, i) =>
          ranges.map((r) => ({ weekday: i + 1, start: r.start, end: r.end })),
        ),
      }),
    onSuccess: () => {
      toast('Working hours saved');
      onClose();
    },
  });

  return (
    <Dialog open wide onClose={onClose} title={`${staff.name}'s working hours`}>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} />
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-line">
            {WEEKDAYS.map((day, i) => (
              <li
                key={day}
                className="grid grid-cols-1 items-start gap-x-3 gap-y-1.5 py-3 sm:grid-cols-[6rem_1fr_auto]"
              >
                <span className="text-sm font-medium sm:pt-2">{day}</span>
                <div className="flex flex-col gap-2">
                  {current[i]!.length === 0 && (
                    <span className="pt-2 text-sm text-muted">Not working</span>
                  )}
                  {current[i]!.map((r, k) => (
                    <div key={k} className="flex flex-wrap items-center gap-2">
                      <input
                        type="time"
                        aria-label={`${day} start`}
                        value={r.start}
                        onChange={(e) =>
                          update(
                            i,
                            current[i]!.map((x, m) =>
                              m === k ? { ...x, start: e.target.value } : x,
                            ),
                          )
                        }
                        className="tabular h-9 w-[8.5rem] rounded-[var(--radius-control)] border border-line px-2"
                      />
                      <span className="text-sm text-muted">to</span>
                      <input
                        type="time"
                        aria-label={`${day} end`}
                        value={r.end}
                        onChange={(e) =>
                          update(
                            i,
                            current[i]!.map((x, m) =>
                              m === k ? { ...x, end: e.target.value } : x,
                            ),
                          )
                        }
                        className="tabular h-9 w-[8.5rem] rounded-[var(--radius-control)] border border-line px-2"
                      />
                      <button
                        className="px-1 text-sm text-muted underline-offset-2 hover:text-danger hover:underline"
                        aria-label={`Remove ${day} hours`}
                        onClick={() =>
                          update(
                            i,
                            current[i]!.filter((_, m) => m !== k),
                          )
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  className="justify-self-start text-sm text-peacock hover:underline sm:col-start-3 sm:pt-2"
                  onClick={() => {
                    const last = current[i]!.at(-1);
                    update(i, [
                      ...current[i]!,
                      last ? { start: last.end, end: '18:00' } : { start: '09:00', end: '17:00' },
                    ]);
                  }}
                >
                  Add hours
                </button>
              </li>
            ))}
          </ul>
          {invalid && (
            <Alert tone="warning">
              Each range must end after it starts, and ranges on the same day can't overlap.
            </Alert>
          )}
          {save.isError && (
            <div className="mt-3">
              <Alert>{(save.error as ApiError).message}</Alert>
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={invalid} busy={save.isPending} onClick={() => save.mutate()}>
              Save hours
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

function TimeOffDialog({ staff, onClose }: { staff: StaffDto; onClose: () => void }) {
  const me = useMe();
  const tz = me.data!.activeTenant!.timezone;
  const qc = useQueryClient();
  const key = ['time-off', staff.membershipId];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      get<{ timeOff: { id: string; startAt: string; endAt: string; reason: string | null }[] }>(
        `/staff/${staff.membershipId}/time-off`,
      ),
  });
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');
  // <input type="datetime-local"> has no timezone; we read it as the business's local time.
  const toIso = (local: string) => DateTime.fromISO(local, { zone: tz }).toISO();
  const add = useMutation({
    mutationFn: () =>
      post(`/staff/${staff.membershipId}/time-off`, {
        startAt: toIso(start),
        endAt: toIso(end),
        reason: reason || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
      setStart('');
      setEnd('');
      setReason('');
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/time-off/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  return (
    <Dialog open onClose={onClose} title={`Time off for ${staff.name}`}>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} />
      ) : q.data.timeOff.length === 0 ? (
        <p className="text-sm text-muted">No time off planned.</p>
      ) : (
        <ul className="mb-2 divide-y divide-line">
          {q.data.timeOff.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="tabular">
                {fmtDateTime(t.startAt, tz)} to {fmtDateTime(t.endAt, tz)}
                {t.reason && <span className="text-muted">, {t.reason}</span>}
              </span>
              <button className="text-danger hover:underline" onClick={() => remove.mutate(t.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-4 flex flex-col gap-3 border-t border-line pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <p className="font-medium">Add time off</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="From"
            type="datetime-local"
            required
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
          <Field
            label="Until"
            type="datetime-local"
            required
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </div>
        <Field
          label="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={200}
        />
        {add.isError && <Alert>{(add.error as ApiError).message}</Alert>}
        <div className="flex justify-end">
          <Button type="submit" busy={add.isPending} disabled={!start || !end}>
            Add time off
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RemoveDialog({ staff, onClose }: { staff: StaffDto; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const remove = useMutation({
    mutationFn: () => del(`/staff/${staff.membershipId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['staff'] });
      toast(`${staff.name} removed from the team`);
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={`Remove ${staff.name}?`}>
      <p className="text-[15px] text-muted">
        They'll lose access to your schedule. Their past bookings stay in your records.
      </p>
      {remove.isError && (
        <div className="mt-3">
          <Alert>{(remove.error as ApiError).message}</Alert>
        </div>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Keep
        </Button>
        <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
          Remove from team
        </Button>
      </div>
    </Dialog>
  );
}
