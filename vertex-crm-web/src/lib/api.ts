import axios, { AxiosInstance, AxiosError } from 'axios';

const api: AxiosInstance = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000',
  headers: {
    'Content-Type': 'application/json',
  },
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
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('auth_token');
      if (typeof window !== 'undefined') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default api;

export const apiEndpoints = {
  auth: {
    login: '/api/auth/login',
    logout: '/api/auth/logout',
  },
  crm: {
    leads: '/api/v1/leads',
    contacts: '/api/v1/contacts',
    deals: '/api/v1/deals',
    accounts: '/api/v1/accounts',
    activities: '/api/v1/activities',
    pipelines: '/api/v1/pipelines',
  },
  marketing: {
    campaigns: '/api/v1/marketing/campaigns',
    ads: '/api/v1/marketing/ads',
    analytics: '/api/v1/marketing/analytics',
  },
};
