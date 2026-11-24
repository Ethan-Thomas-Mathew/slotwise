import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPaise, type ServiceDto } from '@slotwise/shared';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { ApiError } from '../../api/client';
import { del, get, patch, post } from '../../api/client';
import {
  Alert,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  Panel,
} from '../../components/ui';
import { useToast } from '../../components/toast';

/** The form works in rupees; the API in paise. */
const ServiceForm = z.object({
  name: z.string().trim().min(1, 'Required').max(120),
  durationMinutes: z.coerce.number().int().min(5, 'At least 5 minutes').max(720),
  priceRupees: z.coerce.number().min(1, 'At least ₹1').max(10_000_000),
});

export function ServicesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['services'],
    queryFn: () => get<{ services: ServiceDto[] }>('/services'),
  });
  const [editing, setEditing] = useState<ServiceDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ServiceDto | null>(null);

  const toggle = useMutation({
    mutationFn: (s: ServiceDto) => patch(`/services/${s.id}`, { active: !s.active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['services'] }),
  });
  const remove = useMutation({
    mutationFn: (s: ServiceDto) => del(`/services/${s.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['services'] });
      toast('Service deleted');
      setDeleting(null);
    },
  });

  return (
    <>
      <PageHeader title="Services">
        <Button onClick={() => setEditing('new')}>Add a service</Button>
      </PageHeader>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.services.length === 0 ? (
        <EmptyState title="Add your first service">
          Customers pick a service first, so your booking page needs at least one.
        </EmptyState>
      ) : (
        <Panel className="px-5">
          <ul className="divide-y divide-line">
            {q.data.services.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div>
                  <p className="font-medium">
                    {s.name}{' '}
                    {!s.active && (
                      <span className="ml-1 text-sm font-normal text-muted">
                        (hidden from customers)
                      </span>
                    )}
                  </p>
                  <p className="tabular text-sm text-muted">
                    {s.durationMinutes} min, {formatPaise(s.pricePaise)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => setEditing(s)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    busy={toggle.isPending && toggle.variables?.id === s.id}
                    onClick={() => toggle.mutate(s)}
                  >
                    {s.active ? 'Hide' : 'Show'}
                  </Button>
                  <Button variant="danger" onClick={() => setDeleting(s)}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {editing && (
        <ServiceDialog
          service={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <Dialog
        open={deleting !== null}
        onClose={() => {
          setDeleting(null);
          remove.reset();
        }}
        title={`Delete ${deleting?.name ?? 'service'}?`}
      >
        <p className="text-[15px] text-muted">
          It disappears from your booking page. Services that already have bookings can only be
          hidden.
        </p>
        {remove.isError && (
          <div className="mt-3">
            <Alert>{(remove.error as ApiError).message}</Alert>
          </div>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setDeleting(null);
              remove.reset();
            }}
          >
            Keep it
          </Button>
          <Button
            variant="danger"
            busy={remove.isPending}
            onClick={() => deleting && remove.mutate(deleting)}
          >
            Delete service
          </Button>
        </div>
      </Dialog>
    </>
  );
}

function ServiceDialog({ service, onClose }: { service: ServiceDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { register, handleSubmit, formState } = useForm({
    resolver: zodResolver(ServiceForm),
    defaultValues: service
      ? {
          name: service.name,
          durationMinutes: service.durationMinutes,
          priceRupees: service.pricePaise / 100,
        }
      : { name: '', durationMinutes: 30, priceRupees: 500 },
  });
  const save = useMutation({
    mutationFn: (v: z.output<typeof ServiceForm>) => {
      const body = {
        name: v.name,
        durationMinutes: v.durationMinutes,
        pricePaise: Math.round(v.priceRupees * 100),
      };
      return service ? patch(`/services/${service.id}`, body) : post('/services', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['services'] });
      toast(service ? 'Service saved' : 'Service added');
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={service ? 'Edit service' : 'Add a service'}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={handleSubmit((v) => save.mutate(v))}
      >
        {save.isError && <Alert>{(save.error as ApiError).message}</Alert>}
        <Field label="Name" {...register('name')} error={formState.errors.name?.message} />
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Length (minutes)"
            type="number"
            inputMode="numeric"
            {...register('durationMinutes')}
            error={formState.errors.durationMinutes?.message}
          />
          <Field
            label="Price (₹)"
            type="number"
            inputMode="decimal"
            step="0.01"
            {...register('priceRupees')}
            error={formState.errors.priceRupees?.message}
          />
        </div>
        {service && (
          <p className="text-sm text-muted">
            Existing bookings keep the price they were booked at.
          </p>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={save.isPending}>
            {service ? 'Save service' : 'Add service'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
