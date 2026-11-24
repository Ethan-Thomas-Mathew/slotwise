import { lazy, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router';
import './index.css';
import { queryClient } from './api/query-client';
import { ToastProvider } from './components/toast';
import { AppIndex, AppLayout, RoleGate } from './components/app-layout';
import { LandingPage, NotFoundPage } from './routes/landing';
import {
  AcceptInvitePage,
  ForgotPasswordPage,
  LoginPage,
  RegisterPage,
  ResetPasswordPage,
  SignupPage,
} from './features/auth/pages';
import { BookingPage } from './features/booking/booking-page';
import { CheckoutPage } from './features/booking/checkout-page';

/*
 * Dashboard pages are loaded only when someone opens them ("code splitting"),
 * so a customer on a phone opening a booking page doesn't download them.
 */
const AccountPage = lazy(() =>
  import('./features/account/account-page').then((m) => ({ default: m.AccountPage })),
);
const MyBookingsPage = lazy(() =>
  import('./features/customer/my-bookings').then((m) => ({ default: m.MyBookingsPage })),
);
const SchedulePage = lazy(() =>
  import('./features/staff/schedule').then((m) => ({ default: m.SchedulePage })),
);
const OverviewPage = lazy(() =>
  import('./features/owner/overview').then((m) => ({ default: m.OverviewPage })),
);
const OwnerBookingsPage = lazy(() =>
  import('./features/owner/bookings').then((m) => ({ default: m.OwnerBookingsPage })),
);
const ServicesPage = lazy(() =>
  import('./features/owner/services').then((m) => ({ default: m.ServicesPage })),
);
const TeamPage = lazy(() => import('./features/owner/team').then((m) => ({ default: m.TeamPage })));
const SettingsPage = lazy(() =>
  import('./features/owner/settings').then((m) => ({ default: m.SettingsPage })),
);
const ActivityPage = lazy(() =>
  import('./features/owner/activity').then((m) => ({ default: m.ActivityPage })),
);
const EmailsPage = lazy(() =>
  import('./features/owner/emails').then((m) => ({ default: m.EmailsPage })),
);
import { useMe } from './api/session';

const owner = (el: React.ReactNode) => <RoleGate roles={['OWNER']}>{el}</RoleGate>;

/** /app/bookings is "my bookings" for customers and "all bookings" for owners. */
function BookingsRoute() {
  const me = useMe();
  return me.data?.activeTenant?.role === 'OWNER' ? (
    <OwnerBookingsPage />
  ) : (
    <RoleGate roles={['CUSTOMER']}>
      <MyBookingsPage />
    </RoleGate>
  );
}

const router = createBrowserRouter([
  { path: '/', element: <LandingPage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/signup', element: <SignupPage /> },
  { path: '/register', element: <RegisterPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '/accept-invite', element: <AcceptInvitePage /> },
  { path: '/b/:slug', element: <BookingPage /> },
  { path: '/b/:slug/checkout/:bookingId', element: <CheckoutPage /> },
  {
    path: '/app',
    element: <AppLayout />,
    children: [
      { index: true, element: <AppIndex /> },
      { path: 'bookings', element: <BookingsRoute /> },
      { path: 'account', element: <AccountPage /> },
      {
        path: 'schedule',
        element: (
          <RoleGate roles={['STAFF', 'OWNER']}>
            <SchedulePage />
          </RoleGate>
        ),
      },
      { path: 'overview', element: owner(<OverviewPage />) },
      { path: 'services', element: owner(<ServicesPage />) },
      { path: 'team', element: owner(<TeamPage />) },
      { path: 'settings', element: owner(<SettingsPage />) },
      { path: 'activity', element: owner(<ActivityPage />) },
      { path: 'emails', element: owner(<EmailsPage />) },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
