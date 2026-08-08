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
  /** Yalnızca IndexedDB okunurken true — sunucu doğrulaması bekletmez */
  loading: boolean;
  user: AuthUser | null;
  token: string | null;
  /** Giriş ekranında gösterilecek uyarı (oturum düşürüldüyse) */
  authError: string | null;
  /** Oturum açıkken soft uyarı (ör. ağ hatası) */
  sessionNotice: string | null;
  clearAuthError: () => void;
  clearSessionNotice: () => void;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  return /failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(
    error.message,
  );
}

export function useAuth(): AuthState {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const stored = await loadAuthSession();
      if (cancelled) return;

      if (!stored) {
        setSession(null);
        setLoading(false);
        return;
      }

      // Cache'den hemen arayüzü aç; /me doğrulaması arkada.
      setSession(stored);
      setLoading(false);

      try {
        const user = await verifySession(stored.token);
        if (cancelled) return;
        const next = { ...stored, user };
        await saveAuthSession(next);
        if (!cancelled) {
          setSession(next);
          setSessionNotice(null);
        }
      } catch (error) {
        if (cancelled) return;

        if (isNetworkError(error)) {
          setSessionNotice('network');
          return;
        }

        await clearAuthSession();
        if (cancelled) return;
        setSession(null);
        setAuthError(
          error instanceof Error
            ? error.message
            : 'Oturum geçersiz. Yeniden giriş yapın.',
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const next = await loginRequest(username, password);
    setAuthError(null);
    setSessionNotice(null);
    setSession(next);
  }, []);

  const logout = useCallback(async () => {
    await clearAuthSession();
    setSession(null);
    setSessionNotice(null);
  }, []);

  const clearAuthError = useCallback(() => setAuthError(null), []);
  const clearSessionNotice = useCallback(() => setSessionNotice(null), []);

  return {
    loading,
    user: session?.user ?? null,
    token: session?.token ?? null,
    authError,
    sessionNotice,
    clearAuthError,
    clearSessionNotice,
    login,
    logout,
  };
}
