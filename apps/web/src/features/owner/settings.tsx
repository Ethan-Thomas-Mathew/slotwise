import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, get, patch } from '../../api/client';
import {
  Alert,
  Button,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  Panel,
  SelectField,
} from '../../components/ui';
import { useToast } from '../../components/toast';

interface Settings {
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  cancellationWindowHours: number;
  bookingHorizonDays: number;
}

const ZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'Australia/Sydney',
];

export function SettingsPage() {
  const q = useQuery({ queryKey: ['settings'], queryFn: () => get<Settings>('/tenant/settings') });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return <SettingsForm initial={q.data} />;
}

function SettingsForm({ initial }: { initial: Settings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<Settings>(initial);
  const save = useMutation({
    mutationFn: (s: Settings) =>
      patch<Settings>('/tenant/settings', {
        name: s.name,
        timezone: s.timezone,
        cancellationWindowHours: Number(s.cancellationWindowHours),
        bookingHorizonDays: Number(s.bookingHorizonDays),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['me'] });
      toast('Settings saved');
    },
  });
  const errors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  const zones = ZONES.includes(form.timezone) ? ZONES : [form.timezone, ...ZONES];

  return (
    <>
      <PageHeader title="Settings" />
      <Panel className="max-w-xl p-6">
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(form);
          }}
        >
          {save.isError && !Object.keys(errors).length && (
            <Alert>{(save.error as ApiError).message}</Alert>
          )}
          <Field
            label="Business name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            error={errors.name}
          />
          <Field
            label="Booking link"
            value={`/b/${form.slug}`}
            readOnly
            hint="The link can't be changed, so links you've shared keep working."
          />
          <SelectField
            label="Timezone"
            value={form.timezone}
            onChange={(e) => setForm({ ...form, timezone: e.target.value })}
            error={errors.timezone}
          >
            {zones.map((z) => (
              <option key={z}>{z}</option>
            ))}
          </SelectField>
          <Field
            label="Free cancellation until (hours before)"
            type="number"
            min={0}
            max={720}
            value={form.cancellationWindowHours}
            onChange={(e) => setForm({ ...form, cancellationWindowHours: Number(e.target.value) })}
            hint="Customers who cancel later than this don't get a refund. You can always cancel and refund."
            error={errors.cancellationWindowHours}
          />
          <Field
            label="How far ahead customers can book (days)"
            type="number"
            min={1}
            max={365}
            value={form.bookingHorizonDays}
            onChange={(e) => setForm({ ...form, bookingHorizonDays: Number(e.target.value) })}
            error={errors.bookingHorizonDays}
          />
          <div>
            <Button type="submit" busy={save.isPending}>
              Save settings
            </Button>
          </div>
        </form>
      </Panel>
    </>
  );
}
