import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { Link, type LinkProps } from 'react-router';
import { ApiError } from '../lib/api';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------- Buttons ----------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const variants: Record<Variant, string> = {
  primary: 'bg-peacock text-white hover:bg-peacock-dark disabled:bg-peacock/50',
  secondary: 'bg-surface text-ink border border-line hover:border-ink/40 disabled:text-muted',
  ghost: 'text-peacock hover:bg-peacock-tint disabled:text-muted',
  danger: 'bg-surface text-danger border border-danger/40 hover:bg-danger-tint disabled:opacity-50',
};
const buttonBase =
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] px-4 h-10 text-sm font-medium transition-colors disabled:cursor-not-allowed';

export function Button({
  variant = 'primary',
  busy,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      aria-busy={busy || undefined}
      className={cx(buttonBase, variants[variant], className)}
    >
      {busy && <Spinner small />}
      {children}
    </button>
  );
}

export function LinkButton({
  variant = 'primary',
  className,
  ...rest
}: LinkProps & { variant?: Variant }) {
  return <Link {...rest} className={cx(buttonBase, variants[variant], className)} />;
}

// ---------- Form fields ----------
interface FieldProps {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
}

export const Field = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & FieldProps
>(function Field({ label, error, hint, className, ...rest }, ref) {
  const id = useId();
  const describedBy =
    [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cx(
          'h-10 rounded-[var(--radius-control)] border bg-surface px-3 text-[15px] outline-none',
          'focus:border-peacock',
          error ? 'border-danger' : 'border-line',
        )}
        {...rest}
      />
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
});

export const SelectField = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & FieldProps
>(function SelectField({ label, error, hint, className, children, ...rest }, ref) {
  const id = useId();
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select
        ref={ref}
        id={id}
        aria-invalid={error ? true : undefined}
        className={cx(
          'h-10 rounded-[var(--radius-control)] border bg-surface px-2.5 text-[15px] outline-none focus:border-peacock',
          error ? 'border-danger' : 'border-line',
        )}
        {...rest}
      >
        {children}
      </select>
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
});

// ---------- Feedback ----------
export function Spinner({ small }: { small?: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        'inline-block animate-spin rounded-full border-2 border-current border-r-transparent',
        small ? 'size-3.5' : 'size-5',
      )}
    />
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-3 py-10 text-muted">
      <Spinner />
      <span>{label}…</span>
    </div>
  );
}

export function Alert({
  tone = 'danger',
  children,
}: {
  tone?: 'danger' | 'info' | 'warning';
  children: ReactNode;
}) {
  const tones = {
    danger: 'bg-danger-tint text-danger border-danger/25',
    info: 'bg-peacock-tint text-peacock-dark border-peacock/20',
    warning: 'bg-marigold-tint text-ink border-marigold/40',
  };
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cx('rounded-[var(--radius-control)] border px-3.5 py-2.5 text-sm', tones[tone])}
    >
      {children}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message =
    error instanceof ApiError ? error.message : 'Something went wrong while loading this.';
  return (
    <div className="flex flex-col items-start gap-3 py-8">
      <Alert>{message}</Alert>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-panel)] border border-dashed border-line px-6 py-10 text-center">
      <p className="font-display text-lg">{title}</p>
      {children && <div className="mx-auto mt-2 max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}

// ---------- Layout bits ----------
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <h1 className="text-2xl font-semibold sm:text-3xl">{title}</h1>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={cx('rounded-[var(--radius-panel)] border border-line bg-surface', className)}
    >
      {children}
    </section>
  );
}

const STATUS_STYLES: Record<string, string> = {
  HELD: 'bg-marigold-tint text-ink',
  CONFIRMED: 'bg-peacock-tint text-peacock-dark',
  COMPLETED: 'bg-paper text-muted',
  NO_SHOW: 'bg-danger-tint text-danger',
  CANCELLED: 'bg-paper text-muted line-through decoration-1',
  EXPIRED: 'bg-paper text-muted',
};
const STATUS_LABELS: Record<string, string> = {
  HELD: 'Awaiting payment',
  CONFIRMED: 'Confirmed',
  COMPLETED: 'Completed',
  NO_SHOW: 'No-show',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Hold expired',
};
export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cx(
        'inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium',
        STATUS_STYLES[status] ?? 'bg-paper',
      )}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

// ---------- Dialog (native <dialog>: focus trapping and Escape for free) ----------
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** For dialogs with forms that need more room (e.g. weekly hours). */
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close?.();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="dialog-title"
      className={cx(
        'm-auto max-h-[90dvh] overflow-y-auto rounded-[var(--radius-panel)] border border-line bg-surface p-0 text-ink backdrop:bg-ink/40',
        wide ? 'w-[min(42rem,calc(100vw-2rem))]' : 'w-[min(34rem,calc(100vw-2rem))]',
      )}
    >
      {open && (
        <div className="p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <h2 id="dialog-title" className="text-xl font-semibold">
              {title}
            </h2>
            <button
              onClick={onClose}
              className="rounded px-2 text-xl leading-none text-muted hover:text-ink"
              aria-label="Close"
            >
              ×
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

export { cx };
