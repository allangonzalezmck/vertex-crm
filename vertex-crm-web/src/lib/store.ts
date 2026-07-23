import { create } from 'zustand';
import { auth, AuthToken } from './auth';

interface AuthStore {
  user: AuthToken | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  setUser: (user: AuthToken | null) => void;
  setAuthenticated: (isAuth: boolean) => void;
  setLoading: (loading: boolean) => void;
  logout: () => void;
  hydrate: () => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,

  setUser: (user) => set({ user }),
  setAuthenticated: (isAuth) => set({ isAuthenticated: isAuth }),
  setLoading: (loading) => set({ isLoading: loading }),

  logout: () => {
    auth.removeToken();
    set({ user: null, isAuthenticated: false });
  },

  hydrate: () => {
    const isAuth = auth.isAuthenticated();
    const user = auth.getCurrentUser();
    set({ isAuthenticated: isAuth, user, isLoading: false });
  },
}));

if (typeof window !== 'undefined') {
  useAuthStore.getState().hydrate();
}
