import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler } from './api';
import type { Meta, User } from './types';

interface AuthState {
  user: User | null;
  permissions: string[];
  impersonator: { id: number; name: string } | null;
  meta: Meta | null;
  loading: boolean;
  can: (perm: string) => boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMeta: () => Promise<void>;
  setUser: (u: User) => void;
  switchToUser: (id: number) => Promise<void>;
  switchBack: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [impersonator, setImpersonator] = useState<{ id: number; name: string } | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshMeta = useCallback(async () => {
    setMeta(await api.get<Meta>('/meta'));
  }, []);

  const applyMe = async () => {
    const me = await api.get<{ user: User; permissions: string[]; impersonator: { id: number; name: string } | null }>('/auth/me');
    setUser(me.user);
    setPermissions(me.permissions);
    setImpersonator(me.impersonator);
    await refreshMeta();
  };

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setPermissions([]);
      setImpersonator(null);
    });
    applyMe()
      .catch(() => undefined)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = async (username: string, password: string) => {
    const r = await api.post<{ user: User; permissions: string[] }>('/auth/login', { username, password });
    setUser(r.user);
    setPermissions(r.permissions);
    setImpersonator(null);
    await refreshMeta();
  };

  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    setUser(null);
    setPermissions([]);
    setImpersonator(null);
    setMeta(null);
  };

  const switchToUser = async (id: number) => {
    await api.post(`/auth/impersonate/${id}`);
    await applyMe();
  };

  const switchBack = async () => {
    await api.post('/auth/stop-impersonating');
    await applyMe();
  };

  const can = useCallback((p: string) => permissions.includes(p), [permissions]);

  return (
    <Ctx.Provider value={{ user, permissions, impersonator, meta, loading, can, login, logout, refreshMeta, setUser, switchToUser, switchBack }}>
      {children}
    </Ctx.Provider>
  );
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
