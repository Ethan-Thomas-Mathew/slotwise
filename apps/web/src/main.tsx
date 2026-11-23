import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router';
import * as Sentry from '@sentry/react';
import './index.css';
import { queryClient } from './lib/query';
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
import { MyBookingsPage } from './features/customer/my-bookings';
import { SchedulePage } from './features/staff/schedule';
import { OverviewPage } from './features/owner/overview';
import { OwnerBookingsPage } from './features/owner/bookings';
import { ServicesPage } from './features/owner/services';
import { TeamPage } from './features/owner/team';
import { SettingsPage } from './features/owner/settings';
import { ActivityPage } from './features/owner/activity';
import { EmailsPage } from './features/owner/emails';
import { useMe } from './lib/auth';

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    sendDefaultPii: false,
  });
}

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
