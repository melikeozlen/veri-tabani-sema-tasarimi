const DB_NAME = 'cetas-crm-erd';
const DB_VERSION = 2;
const STORE_NAME = 'session';

export type CachedDriveSource = {
  id: string;
  name: string;
  label: string;
  content: string;
  kind: 'drive';
  url?: string;
  folderId?: string;
  folderLabel?: string;
};

export type DriveSourcesCacheEntry = {
  sources: CachedDriveSource[];
  fetchedAt: number;
};

function cacheKey(username: string): string {
  return `driveSources:${username.trim().toLowerCase()}`;
}

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

function isCachedDriveSource(value: unknown): value is CachedDriveSource {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.label === 'string' &&
    typeof item.content === 'string' &&
    item.kind === 'drive'
  );
}

function isCacheEntry(value: unknown): value is DriveSourcesCacheEntry {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    Array.isArray(item.sources) &&
    item.sources.every(isCachedDriveSource) &&
    typeof item.fetchedAt === 'number'
  );
}

export async function loadDriveSourcesCache(
  username: string,
): Promise<DriveSourcesCacheEntry | null> {
  if (typeof indexedDB === 'undefined' || !username.trim()) return null;
  try {
    const stored = await idbGet<unknown>(cacheKey(username));
    return isCacheEntry(stored) ? stored : null;
  } catch {
    return null;
  }
}

export async function saveDriveSourcesCache(
  username: string,
  sources: CachedDriveSource[],
): Promise<void> {
  if (typeof indexedDB === 'undefined' || !username.trim()) return;
  const entry: DriveSourcesCacheEntry = {
    sources,
    fetchedAt: Date.now(),
  };
  await idbSet(cacheKey(username), entry);
}

const FETCHED_LS_PREFIX = 'dbml-erd-drive-fetched:';

function fetchedLsKey(username: string): string {
  return `${FETCHED_LS_PREFIX}${username.trim().toLowerCase()}`;
}

/** Bu kullanıcı için Drive kaynakları en az bir kez çekildi mi? */
export function hasDriveSourcesFetched(username: string): boolean {
  if (typeof window === 'undefined' || !username.trim()) return false;
  return window.localStorage.getItem(fetchedLsKey(username)) === '1';
}

export function markDriveSourcesFetched(username: string): void {
  if (typeof window === 'undefined' || !username.trim()) return;
  window.localStorage.setItem(fetchedLsKey(username), '1');
}
