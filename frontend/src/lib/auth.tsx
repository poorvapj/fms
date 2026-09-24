import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler } from './api';
import type { Meta, User } from './types';

interface AuthState {
  user: User | null;
  permissions: string[];
  meta: Meta | null;
  loading: boolean;
  can: (perm: string) => boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMeta: () => Promise<void>;
  setUser: (u: User) => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshMeta = useCallback(async () => {
    setMeta(await api.get<Meta>('/meta'));
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setPermissions([]);
    });
    api.get<{ user: User; permissions: string[] }>('/auth/me')
      .then(async (r) => {
        setUser(r.user);
        setPermissions(r.permissions);
        await refreshMeta();
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [refreshMeta]);

  const login = async (username: string, password: string) => {
    const r = await api.post<{ user: User; permissions: string[] }>('/auth/login', { username, password });
    setUser(r.user);
    setPermissions(r.permissions);
    await refreshMeta();
  };

  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    setUser(null);
    setPermissions([]);
    setMeta(null);
  };

  const can = useCallback((p: string) => permissions.includes(p), [permissions]);

  return <Ctx.Provider value={{ user, permissions, meta, loading, can, login, logout, refreshMeta, setUser }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside provider');
  return v;
}

/** Meta is always loaded once a user is signed in. */
export function useMeta(): Meta {
  const { meta } = useAuth();
  if (!meta) throw new Error('Meta not loaded');
  return meta;
}
