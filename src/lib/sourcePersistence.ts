export interface PersistedSource {
  id: string;
  name: string;
  label: string;
  content: string;
  kind: 'upload' | 'link';
  url?: string;
}

const DB_NAME = 'cetas-crm-erd';
const DB_VERSION = 2;
const STORE_NAME = 'session';

const UPLOADED_KEY = 'uploadedSources';
const OVERRIDES_KEY = 'sourceOverrides';
const ACTIVE_KEY = 'activeSourceId';

/** Eski localStorage anahtarları — bir kez IndexedDB'ye taşınıp silinir. */
const LEGACY_UPLOADED_KEY = 'dbml-erd-uploaded-sources';
const LEGACY_OVERRIDES_KEY = 'dbml-erd-source-overrides';
const LEGACY_ACTIVE_KEY = 'dbml-erd-active-source';

export interface PersistedSession {
  uploadedSources: PersistedSource[];
  sourceOverrides: Record<string, string>;
  activeSourceId: string;
}

function isPersistedUserSource(value: unknown): value is PersistedSource {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const kind = item.kind;
  return (
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.label === 'string' &&
    typeof item.content === 'string' &&
    (kind === 'upload' || kind === 'link') &&
    (item.url === undefined || typeof item.url === 'string')
  );
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

function readLegacyLocalStorage(): PersistedSession | null {
  if (typeof window === 'undefined') return null;

  try {
    const uploadedRaw = window.localStorage.getItem(LEGACY_UPLOADED_KEY);
    const overridesRaw = window.localStorage.getItem(LEGACY_OVERRIDES_KEY);
    const activeSourceId = window.localStorage.getItem(LEGACY_ACTIVE_KEY) ?? '';

    if (!uploadedRaw && !overridesRaw && !activeSourceId) return null;

    let uploadedSources: PersistedSource[] = [];
    if (uploadedRaw) {
      const parsed: unknown = JSON.parse(uploadedRaw);
      if (Array.isArray(parsed)) uploadedSources = parsed.filter(isPersistedUserSource);
    }

    let sourceOverrides: Record<string, string> = {};
    if (overridesRaw) {
      const parsed: unknown = JSON.parse(overridesRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string') sourceOverrides[key] = value;
        }
      }
    }

    return { uploadedSources, sourceOverrides, activeSourceId };
  } catch {
    return null;
  }
}

function clearLegacyLocalStorage() {
  try {
    window.localStorage.removeItem(LEGACY_UPLOADED_KEY);
    window.localStorage.removeItem(LEGACY_OVERRIDES_KEY);
    window.localStorage.removeItem(LEGACY_ACTIVE_KEY);
  } catch {
    // ignore
  }
}

export async function loadPersistedSession(): Promise<PersistedSession> {
  const empty: PersistedSession = {
    uploadedSources: [],
    sourceOverrides: {},
    activeSourceId: '',
  };

  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') {
    return empty;
  }

  try {
    const [uploadedSources, sourceOverrides, activeSourceId] = await Promise.all([
      idbGet<PersistedSource[]>(UPLOADED_KEY),
      idbGet<Record<string, string>>(OVERRIDES_KEY),
      idbGet<string>(ACTIVE_KEY),
    ]);

    const hasIdbData =
      uploadedSources !== undefined || sourceOverrides !== undefined || activeSourceId !== undefined;

    if (hasIdbData) {
      return {
        uploadedSources: Array.isArray(uploadedSources)
          ? uploadedSources.filter(isPersistedUserSource)
          : [],
        sourceOverrides:
          sourceOverrides && typeof sourceOverrides === 'object' && !Array.isArray(sourceOverrides)
            ? Object.fromEntries(
                Object.entries(sourceOverrides).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
              )
            : {},
        activeSourceId: typeof activeSourceId === 'string' ? activeSourceId : '',
      };
    }

    const legacy = readLegacyLocalStorage();
    if (legacy) {
      await savePersistedSession(legacy);
      clearLegacyLocalStorage();
      return legacy;
    }
  } catch {
    const legacy = readLegacyLocalStorage();
    if (legacy) return legacy;
  }

  return empty;
}

export async function savePersistedSession(session: PersistedSession): Promise<void> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return;

  await Promise.all([
    idbSet(UPLOADED_KEY, session.uploadedSources),
    idbSet(OVERRIDES_KEY, session.sourceOverrides),
    idbSet(ACTIVE_KEY, session.activeSourceId),
  ]);
}
