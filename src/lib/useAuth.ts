import { useCallback, useEffect, useState } from 'react';
import {
  clearAuthSession,
  loadAuthSession,
  loginRequest,
  saveAuthSession,
  verifySession,
  type AuthSession,
  type AuthUser,
} from './auth';

export type AuthState = {
  loading: boolean;
  user: AuthUser | null;
  token: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

export function useAuth(): AuthState {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<AuthSession | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const stored = await loadAuthSession();
      if (!stored) {
        if (!cancelled) {
          setSession(null);
          setLoading(false);
        }
        return;
      }

      try {
        const user = await verifySession(stored.token);
        if (!cancelled) {
          const next = { ...stored, user };
          await saveAuthSession(next);
          setSession(next);
        }
      } catch {
        await clearAuthSession();
        if (!cancelled) setSession(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const next = await loginRequest(username, password);
    setSession(next);
  }, []);

  const logout = useCallback(async () => {
    await clearAuthSession();
    setSession(null);
  }, []);

  return {
    loading,
    user: session?.user ?? null,
    token: session?.token ?? null,
    login,
    logout,
  };
}
