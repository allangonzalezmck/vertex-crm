import axios, { AxiosInstance, AxiosError } from 'axios';

/** Standard error envelope returned by all Vertex services. */
export interface ApiErrorEnvelope {
  success: false;
  error: { code: string; message: string; details?: unknown };
  timestamp: string;
  requestId?: string;
}

const api: AxiosInstance = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080',
  headers: { 'Content-Type': 'application/json' },
});

// Request interceptor - add auth token
api.interceptors.request.use(
  (config) => {
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('auth_token');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor - handle auth errors
api.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiErrorEnvelope>) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('auth_token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

/**
 * Extract a human-readable message from an axios error.
 * Handles the standard envelope, plus network failures where there is
 * no response at all.
 */
export function getErrorMessage(error: unknown): string {
  const err = error as AxiosError<ApiErrorEnvelope>;

  if (err?.response?.data?.error?.message) {
    return err.response.data.error.message;
  }
  if (err?.response) {
    return `Request failed (${err.response.status})`;
  }
  if (err?.request) {
    return 'Could not reach the server. Check your connection.';
  }
  return (err as Error)?.message ?? 'An unexpected error occurred';
}

/** Extract the machine-readable error code, when present. */
export function getErrorCode(error: unknown): string | null {
  const err = error as AxiosError<ApiErrorEnvelope>;
  return err?.response?.data?.error?.code ?? null;
}

export default api;

/**
 * Paths as exposed by api-gateway. The gateway rewrites /api/X -> /api/v1/X
 * for CRM routes, so callers use the un-versioned form.
 */
export const apiEndpoints = {
  auth: {
    login: '/api/auth/login',
    logout: '/api/auth/logout',
  },
  crm: {
    leads: '/api/leads',
    contacts: '/api/contacts',
    deals: '/api/deals',
    accounts: '/api/accounts',
    activities: '/api/activities',
    pipelines: '/api/pipelines',
  },
  marketing: {
    campaigns: '/api/marketing/campaigns',
    ads: '/api/marketing/ads',
    analytics: '/api/marketing/analytics',
  },
};
