/**
 * @file frontend/src/stores/auth.store.ts
 * @description Zustand auth store — manages Google Identity Platform session,
 * tenant context, and JWT token refresh.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  role: string;
}

interface AuthTenant {
  id: string;
  name: string;
  logoUrl?: string;
  plan: 'starter' | 'growth' | 'enterprise';
}

interface AuthState {
  user: AuthUser | null;
  tenant: AuthTenant | null;
  token: string | null;
  tokenExpiresAt: number | null;
  isLoading: boolean;

  // Actions
  setSession: (user: AuthUser, tenant: AuthTenant, token: string, expiresAt: number) => void;
  signOut: () => Promise<void>;
  refreshToken: () => Promise<string | null>;
  getValidToken: () => Promise<string | null>;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      tenant: null,
      token: null,
      tokenExpiresAt: null,
      isLoading: true,

      setSession: (user, tenant, token, expiresAt) => {
        set({ user, tenant, token, tokenExpiresAt: expiresAt, isLoading: false });
      },

      signOut: async () => {
        // Revoke Google Identity Platform token
        const token = get().token;
        if (token) {
          try {
            await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, { method: 'POST' });
          } catch {
            // Best-effort
          }
        }
        set({ user: null, tenant: null, token: null, tokenExpiresAt: null, isLoading: false });
      },

      refreshToken: async () => {
        try {
          const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
          if (!res.ok) {
            set({ user: null, tenant: null, token: null, tokenExpiresAt: null });
            return null;
          }
          const data = await res.json();
          const { token, expiresAt, user, tenant } = data;
          set({ token, tokenExpiresAt: expiresAt, user, tenant });
          return token as string;
        } catch {
          return null;
        }
      },

      getValidToken: async () => {
        const { token, tokenExpiresAt, refreshToken } = get();
        // Refresh if within 5 minutes of expiry
        if (!token || !tokenExpiresAt || Date.now() > tokenExpiresAt - 5 * 60 * 1000) {
          return refreshToken();
        }
        return token;
      },
    }),
    {
      name: 'vertex-auth',
      partialize: (state) => ({
        user: state.user,
        tenant: state.tenant,
        token: state.token,
        tokenExpiresAt: state.tokenExpiresAt,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) state.isLoading = false;
      },
    }
  )
);

// ─── API Client with Auth ─────────────────────────────────────────────────────

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await useAuthStore.getState().getValidToken();

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (res.status === 401) {
    useAuthStore.getState().signOut();
    throw new Error('Session expired');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: 'Request failed' } }));
    const msg = body?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}
