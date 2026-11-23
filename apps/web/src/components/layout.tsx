import type { ReactNode } from 'react';
import { Link } from 'react-router';

export function Wordmark() {
  return (
    <Link to="/" className="font-display text-xl font-semibold tracking-tight text-ink">
      slot<span className="text-peacock">wise</span>
    </Link>
  );
}

/** Narrow centred layout for login/signup forms. */
export function AuthLayout({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-5xl items-center px-5 py-5">
        <Wordmark />
      </header>
      <main className="mx-auto max-w-md px-5 pb-16 pt-6">
        <h1 className="text-3xl font-semibold">{title}</h1>
        {intro && <div className="mt-2 text-muted">{intro}</div>}
        <div className="mt-8">{children}</div>
      </main>
    </div>
  );
}
