import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm, type FieldValues, type Path, type UseFormSetError } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import type { InvitePreviewResponse } from '@slotwise/shared';
import {
  ForgotPasswordRequest,
  LoginRequest,
  Password,
  PersonName,
  RegisterRequest,
  SignupOwnerRequest,
} from '@slotwise/shared';
import { Alert, Button, ErrorState, Field, Loading } from '../../components/ui';
import { AuthLayout } from '../../components/layout';
import { ApiError, get, post } from '../../lib/api';
import { useAcceptInvite, useLogin, useRegister, useSignup } from '../../lib/auth';

/** Shows server-side validation errors next to the right fields; returns a general message for the rest. */
function applyServerErrors<T extends FieldValues>(
  err: unknown,
  setError: UseFormSetError<T>,
): string {
  if (!(err instanceof ApiError)) return 'Something went wrong. Please try again.';
  const fields = err.fieldErrors();
  for (const [path, message] of Object.entries(fields)) setError(path as Path<T>, { message });
  return Object.keys(fields).length ? '' : err.message;
}

/** Only follow `next` links that stay on this site. */
function safeNext(next: string | null, fallback = '/app') {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : fallback;
}

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const login = useLogin();
  const [formError, setFormError] = useState('');
  const { register, handleSubmit, setError, formState } = useForm({
    resolver: zodResolver(LoginRequest),
  });
  const tenantSlug = params.get('b') ?? undefined;

  return (
    <AuthLayout title="Log in">
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={handleSubmit(async (values) => {
          setFormError('');
          try {
            await login.mutateAsync({ ...values, tenantSlug });
            navigate(safeNext(params.get('next')));
          } catch (err) {
            setFormError(applyServerErrors(err, setError));
          }
        })}
      >
        {formError && <Alert>{formError}</Alert>}
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          {...register('email')}
          error={formState.errors.email?.message}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          {...register('password')}
          error={formState.errors.password?.message}
        />
        <Button type="submit" busy={login.isPending}>
          Log in
        </Button>
      </form>
      <div className="mt-6 flex flex-col gap-2 text-sm">
        <Link className="text-peacock underline underline-offset-2" to="/forgot-password">
          Forgot your password?
        </Link>
        <span className="text-muted">
          New here?{' '}
          <Link
            className="text-peacock underline underline-offset-2"
            to={`/register${params.size ? `?${params}` : ''}`}
          >
            Create an account
          </Link>{' '}
          or{' '}
          <Link className="text-peacock underline underline-offset-2" to="/signup">
            set up your business
          </Link>
          .
        </span>
      </div>
    </AuthLayout>
  );
}

export function SignupPage() {
  const navigate = useNavigate();
  const signup = useSignup();
  const [formError, setFormError] = useState('');
  const { register, handleSubmit, setError, formState, watch } = useForm({
    resolver: zodResolver(SignupOwnerRequest),
    defaultValues: { timezone: 'Asia/Kolkata' },
  });
  const slug = watch('slug');

  return (
    <AuthLayout
      title="Set up your booking page"
      intro="Takes a minute. You can add services and your team next."
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={handleSubmit(async (values) => {
          setFormError('');
          try {
            await signup.mutateAsync(values);
            navigate('/app/services');
          } catch (err) {
            setFormError(applyServerErrors(err, setError));
          }
        })}
      >
        {formError && <Alert>{formError}</Alert>}
        <Field
          label="Business name"
          {...register('businessName')}
          error={formState.errors.businessName?.message}
        />
        <Field
          label="Booking link"
          {...register('slug')}
          error={formState.errors.slug?.message}
          hint={`Customers will book at /b/${slug || 'your-business'}`}
          autoCapitalize="off"
        />
        <Field
          label="Your name"
          autoComplete="name"
          {...register('name')}
          error={formState.errors.name?.message}
        />
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          {...register('email')}
          error={formState.errors.email?.message}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          {...register('password')}
          error={formState.errors.password?.message}
          hint="At least 8 characters"
        />
        <Button type="submit" busy={signup.isPending}>
          Create booking page
        </Button>
      </form>
      <p className="mt-6 text-sm text-muted">
        Already have an account?{' '}
        <Link className="text-peacock underline underline-offset-2" to="/login">
          Log in
        </Link>
      </p>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const reg = useRegister();
  const [formError, setFormError] = useState('');
  const { register, handleSubmit, setError, formState } = useForm({
    resolver: zodResolver(RegisterRequest),
  });
  const tenantSlug = params.get('b') ?? undefined;

  return (
    <AuthLayout
      title="Create your account"
      intro="So you can see, move or cancel your bookings later."
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={handleSubmit(async (values) => {
          setFormError('');
          try {
            await reg.mutateAsync({ ...values, tenantSlug });
            navigate(safeNext(params.get('next')));
          } catch (err) {
            setFormError(applyServerErrors(err, setError));
          }
        })}
      >
        {formError && <Alert>{formError}</Alert>}
        <Field
          label="Name"
          autoComplete="name"
          {...register('name')}
          error={formState.errors.name?.message}
        />
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          {...register('email')}
          error={formState.errors.email?.message}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          {...register('password')}
          error={formState.errors.password?.message}
          hint="At least 8 characters"
        />
        <Button type="submit" busy={reg.isPending}>
          Create account
        </Button>
      </form>
      <p className="mt-6 text-sm text-muted">
        Have an account?{' '}
        <Link
          className="text-peacock underline underline-offset-2"
          to={`/login${params.size ? `?${params}` : ''}`}
        >
          Log in
        </Link>
      </p>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState('');
  const { register, handleSubmit, setError, formState } = useForm({
    resolver: zodResolver(ForgotPasswordRequest),
  });
  return (
    <AuthLayout title="Reset your password">
      {sent ? (
        <Alert tone="info">
          If that email has an account, a reset link is on its way. It works for one hour.
        </Alert>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={handleSubmit(async (values) => {
            setFormError('');
            try {
              await post('/auth/forgot-password', values);
              setSent(true);
            } catch (err) {
              setFormError(applyServerErrors(err, setError));
            }
          })}
        >
          {formError && <Alert>{formError}</Alert>}
          <Field
            label="Email"
            type="email"
            autoComplete="email"
            {...register('email')}
            error={formState.errors.email?.message}
          />
          <Button type="submit" busy={formState.isSubmitting}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

const ResetForm = z
  .object({ password: Password, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: "Passwords don't match", path: ['confirm'] });

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState('');
  const { register, handleSubmit, formState } = useForm({ resolver: zodResolver(ResetForm) });
  return (
    <AuthLayout title="Choose a new password">
      {done ? (
        <div className="flex flex-col gap-4">
          <Alert tone="info">Password changed. You've been logged out on every device.</Alert>
          <Link className="text-peacock underline underline-offset-2" to="/login">
            Log in with your new password
          </Link>
        </div>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={handleSubmit(async ({ password }) => {
            setFormError('');
            try {
              await post('/auth/reset-password', { token: params.get('token') ?? '', password });
              setDone(true);
            } catch (err) {
              setFormError(err instanceof ApiError ? err.message : 'Something went wrong.');
            }
          })}
        >
          {formError && <Alert>{formError}</Alert>}
          <Field
            label="New password"
            type="password"
            autoComplete="new-password"
            {...register('password')}
            error={formState.errors.password?.message}
          />
          <Field
            label="Repeat it"
            type="password"
            autoComplete="new-password"
            {...register('confirm')}
            error={formState.errors.confirm?.message}
          />
          <Button type="submit" busy={formState.isSubmitting}>
            Save password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

const NewAccountForm = z.object({ name: PersonName, password: Password });
const ExistingAccountForm = z.object({ password: z.string().min(1, 'Required') });

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const accept = useAcceptInvite();
  const [formError, setFormError] = useState('');
  const preview = useQuery({
    queryKey: ['invite', token],
    queryFn: () => get<InvitePreviewResponse>(`/auth/invites/${encodeURIComponent(token)}`),
  });
  const exists = preview.data?.userExists ?? false;
  const { register, handleSubmit, formState } = useForm<{ name?: string; password: string }>({
    resolver: zodResolver(exists ? ExistingAccountForm : NewAccountForm),
  });

  if (preview.isPending)
    return (
      <AuthLayout title="Join the team">
        <Loading />
      </AuthLayout>
    );
  if (preview.isError)
    return (
      <AuthLayout title="Join the team">
        <ErrorState error={preview.error} />
      </AuthLayout>
    );

  return (
    <AuthLayout
      title={`Join ${preview.data.tenantName}`}
      intro={
        exists
          ? `Log in as ${preview.data.email} to accept.`
          : `Create your account for ${preview.data.email}.`
      }
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={handleSubmit(async (values) => {
          setFormError('');
          try {
            await accept.mutateAsync({ token, ...values });
            navigate('/app');
          } catch (err) {
            setFormError(err instanceof ApiError ? err.message : 'Something went wrong.');
          }
        })}
      >
        {formError && <Alert>{formError}</Alert>}
        {!exists && (
          <Field
            label="Your name"
            autoComplete="name"
            {...register('name')}
            error={formState.errors.name?.message}
          />
        )}
        <Field
          label={exists ? 'Your password' : 'Choose a password'}
          type="password"
          autoComplete={exists ? 'current-password' : 'new-password'}
          {...register('password')}
          error={formState.errors.password?.message}
        />
        <Button type="submit" busy={accept.isPending}>
          Accept invite
        </Button>
      </form>
    </AuthLayout>
  );
}
