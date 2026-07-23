import { jwtDecode } from 'jwt-decode';

export interface AuthToken {
  id: string;
  username: string;
  email: string;
  iat: number;
  exp: number;
}

export const auth = {
  setToken: (token: string) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('auth_token', token);
    }
  },

  getToken: (): string | null => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('auth_token');
    }
    return null;
  },

  removeToken: () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('auth_token');
    }
  },

  decodeToken: (token: string): AuthToken | null => {
    try {
      return jwtDecode<AuthToken>(token);
    } catch {
      return null;
    }
  },

  isAuthenticated: (): boolean => {
    const token = auth.getToken();
    if (!token) return false;

    const decoded = auth.decodeToken(token);
    if (!decoded) return false;

    return decoded.exp > Date.now() / 1000;
  },

  getCurrentUser: (): AuthToken | null => {
    const token = auth.getToken();
    if (!token) return null;
    return auth.decodeToken(token);
  },
};
