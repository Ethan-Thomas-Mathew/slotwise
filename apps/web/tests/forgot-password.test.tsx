import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForgotPasswordPage } from '../src/features/auth/pages';

afterEach(() => vi.restoreAllMocks());

async function submit(email = 'someone@example.com') {
  render(
    <MemoryRouter>
      <ForgotPasswordPage />
    </MemoryRouter>,
  );
  await userEvent.type(screen.getByLabelText('Email'), email);
  await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
}

describe('forgot password', () => {
  it('says the link is on its way, whether or not the account exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    await submit();
    expect(await screen.findByText(/a reset link is on its way/)).toBeInTheDocument();
  });

  it('reports a rate limit instead of pretending an email was sent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in 15 minutes.' },
        }),
        { status: 429 },
      ),
    );
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts');
    expect(screen.queryByText(/on its way/)).not.toBeInTheDocument();
  });

  it('reports a network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach Slotwise");
  });
});
