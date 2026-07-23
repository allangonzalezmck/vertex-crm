export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: {
    id: string;
    username: string;
    email: string;
  };
}

export interface Lead {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  company?: string;
  status: 'new' | 'contacted' | 'qualified' | 'converted' | 'lost';
  source: string;
  score: number;
  createdAt: string;
  updatedAt: string;
}

export interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  accountId: string;
  createdAt: string;
}

export interface Deal {
  id: string;
  name: string;
  amount: number;
  stage: string;
  probability: number;
  closedDate?: string;
  leadId: string;
  createdAt: string;
}

export interface Account {
  id: string;
  name: string;
  industry?: string;
  website?: string;
  employees?: number;
  revenue?: number;
  createdAt: string;
}

export interface Campaign {
  id: string;
  name: string;
  platform: 'facebook' | 'instagram' | 'google';
  status: 'active' | 'paused' | 'ended';
  budget: number;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  startDate: string;
  endDate?: string;
}

export interface ApiResponse<T> {
  data: T;
  status: 'success' | 'error';
  message?: string;
}

export interface ApiError {
  status: number;
  message: string;
  errors?: Record<string, string[]>;
}
