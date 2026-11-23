import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  LoginRequest,
  MeResponse,
  RegisterRequest,
  SignupOwnerRequest,
} from '@slotwise/shared';
import { ApiError, get, post, setCsrfToken } from './api';

/** The logged-in user (or null). Also stores the CSRF token for later writes. */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async (): Promise<MeResponse | null> => {
      try {
        const me = await get<MeResponse>('/auth/me');
        setCsrfToken(me.csrfToken);
        return me;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setCsrfToken(null);
          return null;
        }
        throw err;
      }
    },
    staleTime: 60_000,
  });
}

function useSessionMutation<TBody>(path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) => post<MeResponse>(path, body),
    onSuccess: (me) => {
      setCsrfToken(me.csrfToken);
      // A different user/business: throw away everything cached for the old one.
      qc.clear();
      qc.setQueryData(['me'], me);
    },
  });
}

export const useLogin = () => useSessionMutation<LoginRequest>('/auth/login');
export const useSignup = () => useSessionMutation<SignupOwnerRequest>('/auth/signup');
export const useRegister = () => useSessionMutation<RegisterRequest>('/auth/register');
export const useAcceptInvite = () =>
  useSessionMutation<{ token: string; name?: string; password: string }>('/auth/accept-invite');
export const useSwitchTenant = () =>
  useSessionMutation<{ slug: string; joinAsCustomer?: boolean }>('/auth/active-tenant');

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post('/auth/logout'),
    onSettled: () => {
      setCsrfToken(null);
      qc.clear();
      qc.setQueryData(['me'], null);
    },
  });
}
