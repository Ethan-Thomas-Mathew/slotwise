import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setCsrfToken } from '../src/lib/api';

afterEach(() => {
  vi.restoreAllMocks();
  setCsrfToken(null);
});

describe('api client', () => {
  it('sends cookies, and the CSRF token on writes only', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{"ok":true}', { status: 200 }));
    setCsrfToken('tok');
    await api('/x');
    await api('/y', { method: 'POST', body: {} });
    const [, getInit] = fetchMock.mock.calls[0]!;
    const [, postInit] = fetchMock.mock.calls[1]!;
    expect(getInit!.credentials).toBe('include');
    expect((getInit!.headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
    expect((postInit!.headers as Record<string, string>)['x-csrf-token']).toBe('tok');
  });

  it('turns the error shape into an ApiError with field errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request is invalid',
            details: [{ path: 'email', message: 'Invalid email' }],
          },
        }),
        { status: 400 },
      ),
    );
    const err = await api('/z').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('VALIDATION_ERROR');
    expect((err as ApiError).fieldErrors()).toEqual({ email: 'Invalid email' });
  });

  it('reports network failures in plain language', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api('/z')).rejects.toMatchObject({
      code: 'NETWORK',
      message: expect.stringMatching(/Can't reach/),
    });
  });
});
