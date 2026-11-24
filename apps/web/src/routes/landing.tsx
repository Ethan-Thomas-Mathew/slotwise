import { Link } from 'react-router';
import { Wordmark } from '../components/layout';
import { LinkButton } from '../components/ui';
import { useMe } from '../api/session';

/** A sample page from the appointment book, drawn with the same styles as the real booking page. */
const SAMPLE = [
  {
    hour: '10 AM',
    slots: [
      ['10:00', 'taken'],
      ['10:45', 'open'],
    ],
  },
  { hour: '11 AM', slots: [['11:30', 'held']] },
  { hour: '12 PM', slots: [['12:15', 'open']] },
  {
    hour: '2 PM',
    slots: [
      ['2:00', 'open'],
      ['2:45', 'taken'],
    ],
  },
] as const;

export function LandingPage() {
  const me = useMe();
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <Wordmark />
        <nav className="flex items-center gap-4 text-sm font-medium">
          {me.data ? (
            <Link className="text-peacock hover:underline" to="/app">
              Go to your dashboard
            </Link>
          ) : (
            <>
              <Link className="hover:underline" to="/login">
                Log in
              </Link>
              <LinkButton to="/signup">Set up your business</LinkButton>
            </>
          )}
        </nav>
      </header>

      <main className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-20 pt-10 lg:grid-cols-[1.1fr_1fr] lg:pt-20">
        <div>
          <h1 className="text-5xl font-semibold leading-[1.05] sm:text-6xl">
            Your appointment book, open to customers.
          </h1>
          <p className="mt-6 max-w-lg text-lg text-muted">
            Salons, clinics and coaching centres share one link. Customers pick a time, pay by UPI
            or card, and get a reminder the day before. You stop answering the phone to say what's
            free.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <LinkButton to="/signup" className="h-12 px-6 text-base">
              Create your booking page
            </LinkButton>
            <LinkButton to="/b/glow-salon" variant="secondary" className="h-12 px-6 text-base">
              Try a demo salon
            </LinkButton>
          </div>
          <p className="mt-6 text-sm text-muted">
            Demo logins use the password{' '}
            <code className="rounded bg-surface px-1">password123</code>: owner@glow.demo,
            asha@glow.demo (staff), customer@demo.test.
          </p>
        </div>

        <figure
          aria-label="Example of a day on a Slotwise booking page"
          className="rounded-[var(--radius-panel)] border border-line bg-surface p-6"
        >
          <figcaption className="mb-4 flex items-baseline justify-between">
            <span className="text-xl font-semibold">Tuesday, 1 December</span>
            <span className="text-sm text-muted">Women's haircut, 45 min</span>
          </figcaption>
          <ol className="border-l-2 border-line">
            {SAMPLE.map((g) => (
              <li key={g.hour} className="grid grid-cols-[4.5rem_1fr] gap-3 py-2">
                <span className="tabular -ml-px border-l-2 border-ink pl-3 text-sm font-medium text-muted">
                  {g.hour}
                </span>
                <div className="flex flex-wrap gap-2">
                  {g.slots.map(([t, state]) => (
                    <span
                      key={t}
                      className={
                        'tabular inline-flex h-10 min-w-[5.5rem] items-center justify-center rounded-[var(--radius-control)] border px-3 text-sm font-medium ' +
                        (state === 'open'
                          ? 'border-peacock/30 text-peacock-dark'
                          : state === 'held'
                            ? 'border-marigold bg-marigold-tint ring-2 ring-marigold'
                            : 'border-line bg-paper text-muted line-through')
                      }
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-4 rounded-[var(--radius-control)] bg-marigold-tint px-3 py-2 text-sm">
            11:30 is held for Kiran for 9:41 while they pay. Nobody else can take it.
          </p>
        </figure>
      </main>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-xl px-5 py-24">
      <Wordmark />
      <h1 className="mt-10 text-4xl font-semibold">This page doesn't exist</h1>
      <p className="mt-3 text-muted">
        The link may be mistyped.{' '}
        <Link className="text-peacock underline" to="/">
          Go to the home page
        </Link>
        .
      </p>
    </div>
  );
}
