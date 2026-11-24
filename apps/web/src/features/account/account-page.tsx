import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { DataExport, DeleteAccountRequest } from '@slotwise/shared';
import { Alert, Button, Dialog, Field, PageHeader, Panel } from '../../components/ui';
import { useToast } from '../../components/toast';
import { ApiError, get, post, setCsrfToken } from '../../api/client';
import { useMe } from '../../api/session';

/** Your details, a copy of your data, and erasing your account (India's DPDP Act). */
export function AccountPage() {
  const me = useMe().data;
  if (!me) return null;
  const manages = me.memberships.filter((m) => m.role !== 'CUSTOMER');

  return (
    <>
      <PageHeader title="Your account" />
      <div className="flex max-w-2xl flex-col gap-6">
        <Panel className="p-6">
          <h2 className="text-lg font-semibold">Your details</h2>
          <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-y-1 text-[15px]">
            <dt className="text-muted">Name</dt>
            <dd>{me.user.name}</dd>
            <dt className="text-muted">Email</dt>
            <dd className="break-all">{me.user.email}</dd>
          </dl>
        </Panel>
        <DownloadPanel />
        <DeletePanel blockedBy={manages.map((m) => `${m.tenantName}`)} />
      </div>
    </>
  );
}

function DownloadPanel() {
  const download = useMutation({
    mutationFn: () => get<DataExport>('/account/data'),
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `slotwise-my-data-${data.exportedAt.slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  return (
    <Panel className="p-6">
      <h2 className="text-lg font-semibold">Download your data</h2>
      <p className="mt-2 text-[15px] text-muted">
        A file with your details, the businesses you belong to, and all your bookings and payments.
      </p>
      {download.isError && (
        <div className="mt-3">
          <Alert>{(download.error as ApiError).message}</Alert>
        </div>
      )}
      <Button
        className="mt-4"
        variant="secondary"
        busy={download.isPending}
        onClick={() => download.mutate()}
      >
        Download my data
      </Button>
    </Panel>
  );
}

function DeletePanel({ blockedBy }: { blockedBy: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Panel className="border-danger/30 p-6">
      <h2 className="text-lg font-semibold">Delete your account</h2>
      <p className="mt-2 text-[15px] text-muted">
        Your name and email are erased and you can't log in again. Businesses keep a record of your
        past bookings for their accounts, but it will say "Deleted user" instead of your name.
        Cancel any upcoming bookings first.
      </p>
      {blockedBy.length > 0 ? (
        <div className="mt-4">
          <Alert tone="info">
            You manage {blockedBy.join(', ')}, so this account can't be deleted here. A business
            owner can remove team members from the Team page.
          </Alert>
        </div>
      ) : (
        <Button className="mt-4" variant="danger" onClick={() => setOpen(true)}>
          Delete account…
        </Button>
      )}
      <DeleteDialog open={open} onClose={() => setOpen(false)} />
    </Panel>
  );
}

function DeleteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [form, setForm] = useState({ password: '', confirm: '' });
  const erase = useMutation({
    mutationFn: (body: DeleteAccountRequest) => post('/account/delete', body),
    onSuccess: () => {
      setCsrfToken(null);
      qc.clear();
      qc.setQueryData(['me'], null);
      toast('Your account was deleted');
      navigate('/');
    },
  });
  const errors = erase.error instanceof ApiError ? erase.error.fieldErrors() : {};

  return (
    <Dialog open={open} onClose={onClose} title="Delete your account?">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          erase.mutate({ password: form.password, confirm: form.confirm as 'DELETE' });
        }}
      >
        <p className="text-[15px]">This can't be undone.</p>
        {erase.isError && !Object.keys(errors).length && (
          <Alert>{(erase.error as ApiError).message}</Alert>
        )}
        <Field
          label="Your password"
          type="password"
          autoComplete="current-password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          error={errors.password}
          required
        />
        <Field
          label='Type "DELETE" to confirm'
          value={form.confirm}
          onChange={(e) => setForm({ ...form, confirm: e.target.value })}
          error={errors.confirm}
          autoComplete="off"
          required
        />
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            Keep my account
          </Button>
          <Button
            type="submit"
            variant="danger"
            busy={erase.isPending}
            disabled={form.confirm !== 'DELETE' || !form.password}
          >
            Delete account
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
