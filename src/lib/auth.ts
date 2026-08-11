export type AuthUser = {
  username: string;
  isSuperAdmin: boolean;
};

export type AuthSession = {
  token: string;
  expiresAt: number;
  user: AuthUser;
};

export type DriveSourceMeta = {
  id: string;
  name: string;
  folderId: string;
  folderLabel: string;
};

export type DriveSourceContent = DriveSourceMeta & {
  content: string;
};

const DB_NAME = 'cetas-crm-erd';
const DB_VERSION = 2;
const STORE_NAME = 'session';
const AUTH_KEY = 'authSession';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB açılamadı'));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function idbGet<T>(key: string): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(key);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB okunamadı'));
        request.onsuccess = () => resolve(request.result as T | undefined);
        tx.oncomplete = () => db.close();
      }),
  );
}

function idbSet(key: string, value: unknown): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(value, key);
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB yazılamadı'));
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      }),
  );
}

function idbDelete(key: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB silinemedi'));
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      }),
  );
}

function isAuthSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const user = item.user as Record<string, unknown> | undefined;
  return (
    typeof item.token === 'string' &&
    typeof item.expiresAt === 'number' &&
    !!user &&
    typeof user.username === 'string' &&
    typeof user.isSuperAdmin === 'boolean'
  );
}

export async function loadAuthSession(): Promise<AuthSession | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const stored = await idbGet<unknown>(AUTH_KEY);
    if (!isAuthSession(stored)) return null;
    if (stored.expiresAt <= Date.now()) {
      await clearAuthSession();
      return null;
    }
    return stored;
  } catch {
    return null;
  }
}

export async function saveAuthSession(session: AuthSession): Promise<void> {
  await idbSet(AUTH_KEY, session);
}

export async function clearAuthSession(): Promise<void> {
  await idbDelete(AUTH_KEY);
}

const DEFAULT_FETCH_TIMEOUT_MS = 45_000;

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, ...fetchInit } = init;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...fetchInit, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Sunucu yanıt vermedi (zaman aşımı). Google API kotası veya ağ sorunu olabilir.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit & { token?: string } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const base =
    (typeof import.meta.env.VITE_API_BASE === 'string' && import.meta.env.VITE_API_BASE.trim()) ||
    (import.meta.env.DEV ? 'http://127.0.0.1:3001' : '');
  const url = path.startsWith('http') ? path : `${base}${path}`;

  const response = await fetchWithTimeout(url, { ...options, headers });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };

  if (!response.ok) {
    const message = data.error || `İstek başarısız (${response.status})`;
    if (response.status === 403 && /pasif/i.test(message)) {
      await clearAuthSession();
      window.location.reload();
    }
    throw new Error(message);
  }

  return data;
}

export async function loginRequest(username: string, password: string): Promise<AuthSession> {
  const data = await apiFetch<{
    token: string;
    expiresAt: number;
    user: AuthUser;
  }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });

  const session: AuthSession = {
    token: data.token,
    expiresAt: data.expiresAt,
    user: data.user,
  };
  await saveAuthSession(session);
  return session;
}

export async function verifySession(token: string): Promise<AuthUser> {
  const data = await apiFetch<{ user: AuthUser }>('/api/auth/me', { token });
  return data.user;
}

export async function fetchSourceList(token: string): Promise<DriveSourceMeta[]> {
  const data = await apiFetch<{ sources: DriveSourceMeta[] }>('/api/sources', { token });
  return data.sources;
}

export async function fetchSourceContent(token: string, fileId: string): Promise<DriveSourceContent> {
  const data = await apiFetch<{ source: DriveSourceContent }>(
    `/api/sources/${encodeURIComponent(fileId)}`,
    { token },
  );
  return data.source;
}

export async function updateSourceContent(
  token: string,
  fileId: string,
  content: string,
): Promise<DriveSourceContent> {
  const data = await apiFetch<{ source: DriveSourceContent }>(
    `/api/sources/${encodeURIComponent(fileId)}`,
    {
      method: 'PUT',
      token,
      body: JSON.stringify({ content }),
    },
  );
  return data.source;
}
