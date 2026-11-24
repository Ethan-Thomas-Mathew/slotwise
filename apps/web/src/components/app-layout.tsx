import { Suspense, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import type { MeResponse } from '@slotwise/shared';
import { useLogout, useMe, useSwitchTenant } from '../lib/auth';
import { Wordmark } from './layout';
import { cx, EmptyState, ErrorState, Loading } from './ui';

const NAV: Record<string, { to: string; label: string }[]> = {
  OWNER: [
    { to: '/app/overview', label: 'Overview' },
    { to: '/app/bookings', label: 'Bookings' },
    { to: '/app/services', label: 'Services' },
    { to: '/app/team', label: 'Team and hours' },
    { to: '/app/settings', label: 'Settings' },
    { to: '/app/activity', label: 'Activity log' },
    { to: '/app/emails', label: 'Email problems' },
  ],
  STAFF: [{ to: '/app/schedule', label: 'My schedule' }],
  CUSTOMER: [{ to: '/app/bookings', label: 'My bookings' }],
};

const homeFor = (role: string | undefined) =>
  role === 'OWNER' ? '/app/overview' : role === 'STAFF' ? '/app/schedule' : '/app/bookings';

/** The signed-in area: navigation for the current role, business switcher, logout. */
export function AppLayout() {
  const me = useMe();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  if (me.isPending)
    return (
      <div className="p-8">
        <Loading />
      </div>
    );
  if (me.isError)
    return (
      <div className="p-8">
        <ErrorState error={me.error} onRetry={() => me.refetch()} />
      </div>
    );
  if (!me.data)
    return (
      <Navigate
        to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    );

  const role = me.data.activeTenant?.role;
  const links = role ? NAV[role]! : [];

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="border-b border-line bg-surface lg:min-h-dvh lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between px-5 py-4 lg:block">
          <Wordmark />
          <button
            className="rounded px-2 py-1 text-sm font-medium lg:hidden"
            aria-expanded={menuOpen}
            aria-controls="app-nav"
            onClick={() => setMenuOpen((o) => !o)}
          >
            Menu
          </button>
        </div>
        <div id="app-nav" className={cx('px-3 pb-4 lg:block', menuOpen ? 'block' : 'hidden')}>
          <BusinessSwitcher me={me.data} />
          <nav aria-label="Main" className="mt-4 flex flex-col gap-0.5">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) =>
                  cx(
                    'rounded-[var(--radius-control)] px-3 py-2 text-[15px]',
                    isActive
                      ? 'bg-peacock-tint font-medium text-peacock-dark'
                      : 'text-ink hover:bg-paper',
                  )
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
          {role === 'OWNER' && me.data.activeTenant && (
            <a
              href={`/b/${me.data.activeTenant.slug}`}
              target="_blank"
              rel="noreferrer"
              className="mt-4 block px-3 text-sm text-peacock underline-offset-2 hover:underline"
            >
              Open your booking page
            </a>
          )}
          <UserBox me={me.data} />
        </div>
      </aside>
      <main id="main" className="mx-auto w-full max-w-5xl px-5 py-8 lg:px-10">
        {me.data.activeTenant || location.pathname === '/app/account' ? (
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
        ) : (
          <EmptyState title="You're not part of a business yet">
            Open a business's booking link to book with them, or set up your own business from the
            home page.
          </EmptyState>
        )}
      </main>
    </div>
  );
}

function BusinessSwitcher({ me }: { me: MeResponse }) {
  const switchTenant = useSwitchTenant();
  const navigate = useNavigate();
  if (me.memberships.length === 0) return null;
  const roleLabel = { OWNER: 'Owner', STAFF: 'Team', CUSTOMER: 'Customer' } as const;
  if (me.memberships.length === 1) {
    const m = me.memberships[0]!;
    return (
      <div className="px-3">
        <p className="font-medium">{m.tenantName}</p>
        <p className="text-sm text-muted">{roleLabel[m.role]}</p>
      </div>
    );
  }
  return (
    <div className="px-3">
      <label htmlFor="business" className="text-sm text-muted">
        Business
      </label>
      <select
        id="business"
        className="mt-1 h-10 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2"
        value={me.activeTenant?.slug ?? ''}
        disabled={switchTenant.isPending}
        onChange={async (e) => {
          const next = await switchTenant.mutateAsync({ slug: e.target.value });
          navigate(homeFor(next.activeTenant?.role));
        }}
      >
        {!me.activeTenant && <option value="">Choose…</option>}
        {me.memberships.map((m) => (
          <option key={m.tenantId} value={m.tenantSlug}>
            {m.tenantName} ({roleLabel[m.role]})
          </option>
        ))}
      </select>
    </div>
  );
}

function UserBox({ me }: { me: MeResponse }) {
  const logout = useLogout();
  const navigate = useNavigate();
  return (
    <div className="mt-8 border-t border-line px-3 pt-4 text-sm">
      <p className="font-medium">{me.user.name}</p>
      <p className="truncate text-muted">{me.user.email}</p>
      <NavLink to="/app/account" className="mt-2 block text-peacock hover:underline">
        Your account
      </NavLink>
      <button
        className="mt-2 text-peacock hover:underline"
        onClick={() => logout.mutate(undefined, { onSettled: () => navigate('/') })}
      >
        Log out
      </button>
    </div>
  );
}

/** /app → the right home page for the role. */
export function AppIndex() {
  const me = useMe();
  return <Navigate to={homeFor(me.data?.activeTenant?.role)} replace />;
}

/** Shows a page only to some roles (the API enforces this too; this is just UX). */
export function RoleGate({ roles, children }: { roles: string[]; children: React.ReactNode }) {
  const me = useMe();
  const role = me.data?.activeTenant?.role;
  if (!role || !roles.includes(role)) return <Navigate to={homeFor(role)} replace />;
  return <>{children}</>;
}
