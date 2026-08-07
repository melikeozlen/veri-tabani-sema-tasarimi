const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const GAPI_SRC = 'https://apis.google.com/js/api.js';

export type GoogleDriveFileResult = {
  id: string;
  name: string;
  content: string;
  url: string;
};

type TokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
  expires_in?: number;
};

type PickerDocument = {
  id: string;
  name: string;
  mimeType?: string;
  url?: string;
};

type PickerCallbackData = {
  action: string;
  docs?: PickerDocument[];
};

type DocsViewInstance = {
  setIncludeFolders: (value: boolean) => DocsViewInstance;
  setSelectFolderEnabled: (value: boolean) => DocsViewInstance;
  setMimeTypes: (types: string) => DocsViewInstance;
  setMode: (mode: unknown) => DocsViewInstance;
};

type PickerBuilderInstance = {
  addView: (view: DocsViewInstance | unknown) => PickerBuilderInstance;
  setOAuthToken: (token: string) => PickerBuilderInstance;
  setDeveloperKey: (key: string) => PickerBuilderInstance;
  setAppId: (appId: string) => PickerBuilderInstance;
  setTitle: (title: string) => PickerBuilderInstance;
  setCallback: (cb: (data: PickerCallbackData) => void) => PickerBuilderInstance;
  build: () => { setVisible: (visible: boolean) => void };
};

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: TokenResponse) => void;
            error_callback?: (error: { type?: string; message?: string }) => void;
          }) => {
            requestAccessToken: (options?: { prompt?: string }) => void;
          };
        };
      };
      picker: {
        Action: { PICKED: string; CANCEL: string };
        DocsViewMode: { LIST: unknown };
        ViewId: { DOCS: unknown };
        DocsView: new (viewId?: unknown) => DocsViewInstance;
        PickerBuilder: new () => PickerBuilderInstance;
      };
    };
    gapi?: {
      load: (api: string, options: { callback: () => void; onerror?: () => void }) => void;
    };
  }
}

let scriptsPromise: Promise<void> | null = null;
let accessToken: string | null = null;
let tokenExpiresAt = 0;

function env(name: 'VITE_GOOGLE_CLIENT_ID' | 'VITE_GOOGLE_API_KEY' | 'VITE_GOOGLE_APP_ID'): string {
  const value = import.meta.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

export function isGoogleDriveConfigured(): boolean {
  return Boolean(env('VITE_GOOGLE_CLIENT_ID') && env('VITE_GOOGLE_API_KEY'));
}

export function googleDriveSetupHint(): string {
  return 'Google Drive için .env dosyasına VITE_GOOGLE_CLIENT_ID, VITE_GOOGLE_API_KEY ve VITE_GOOGLE_APP_ID ekleyin. Ayrıntılar README’de.';
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Script yüklenemedi: ${src}`)), {
        once: true,
      });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = '1';
      resolve();
    };
    script.onerror = () => reject(new Error(`Script yüklenemedi: ${src}`));
    document.head.appendChild(script);
  });
}

async function ensureGoogleApis(): Promise<void> {
  if (!scriptsPromise) {
    scriptsPromise = (async () => {
      await loadScript(GIS_SRC);
      await loadScript(GAPI_SRC);
      await new Promise<void>((resolve, reject) => {
        if (!window.gapi?.load) {
          reject(new Error('Google API yüklenemedi.'));
          return;
        }
        window.gapi.load('picker', {
          callback: () => resolve(),
          onerror: () => reject(new Error('Google Picker yüklenemedi.')),
        });
      });
    })().catch((error) => {
      scriptsPromise = null;
      throw error;
    });
  }

  await scriptsPromise;
}

function requestAccessToken(prompt?: string): Promise<string> {
  const clientId = env('VITE_GOOGLE_CLIENT_ID');
  if (!clientId) return Promise.reject(new Error(googleDriveSetupHint()));

  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) {
      reject(new Error('Google oturum istemcisi hazır değil.'));
      return;
    }

    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(
            new Error(
              response.error_description ||
                response.error ||
                'Google girişi iptal edildi veya başarısız.',
            ),
          );
          return;
        }

        accessToken = response.access_token;
        const expiresIn = Number(response.expires_in ?? 3600);
        tokenExpiresAt = Date.now() + Math.max(60, expiresIn - 60) * 1000;
        resolve(accessToken);
      },
      error_callback: (error) => {
        reject(new Error(error.message || error.type || 'Google girişi başarısız.'));
      },
    });

    tokenClient.requestAccessToken(prompt ? { prompt } : {});
  });
}

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  try {
    return await requestAccessToken('');
  } catch {
    return requestAccessToken('consent');
  }
}

function pickDriveFile(token: string): Promise<PickerDocument | null> {
  const apiKey = env('VITE_GOOGLE_API_KEY');
  const appId = env('VITE_GOOGLE_APP_ID');
  if (!apiKey) return Promise.reject(new Error(googleDriveSetupHint()));
  if (!window.google?.picker) return Promise.reject(new Error('Google Picker hazır değil.'));

  return new Promise((resolve, reject) => {
    const google = window.google;
    if (!google?.picker) {
      reject(new Error('Google Picker hazır değil.'));
      return;
    }

    try {
      const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false)
        .setMimeTypes('text/plain,application/octet-stream,text/x-dbml')
        .setMode(google.picker.DocsViewMode.LIST);

      const builder = new google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(apiKey)
        .setTitle('DBML / TXT dosyası seç')
        .setCallback((data: PickerCallbackData) => {
          if (data.action === google.picker.Action.CANCEL) {
            resolve(null);
            return;
          }
          if (data.action === google.picker.Action.PICKED) {
            const doc = data.docs?.[0];
            resolve(doc ?? null);
          }
        });

      if (appId) builder.setAppId(appId);
      builder.build().setVisible(true);
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Dosya seçici açılamadı.'));
    }
  });
}

async function downloadDriveFile(fileId: string, token: string): Promise<{ name: string; content: string }> {
  const metaResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!metaResponse.ok) {
    throw new Error('Drive dosya bilgisi alınamadı. Erişim yetkinizi kontrol edin.');
  }

  const meta = (await metaResponse.json()) as { name?: string };
  const name = meta.name || 'drive.dbml';
  const lower = name.toLowerCase();
  if (!lower.endsWith('.dbml') && !lower.endsWith('.txt')) {
    throw new Error('Yalnızca .dbml veya .txt dosyaları seçilebilir.');
  }

  const contentResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!contentResponse.ok) {
    throw new Error('Drive dosyası indirilemedi. Dosya paylaşımını kontrol edin.');
  }

  const content = await contentResponse.text();
  if (!content.trim()) throw new Error('Seçilen Drive dosyası boş.');

  return { name, content };
}

export async function pickAndLoadGoogleDriveFile(): Promise<GoogleDriveFileResult | null> {
  if (!isGoogleDriveConfigured()) {
    throw new Error(googleDriveSetupHint());
  }

  await ensureGoogleApis();
  const token = await getAccessToken();
  const picked = await pickDriveFile(token);
  if (!picked?.id) return null;

  const { name, content } = await downloadDriveFile(picked.id, token);
  return {
    id: picked.id,
    name,
    content,
    url: picked.url || `https://drive.google.com/file/d/${picked.id}/view`,
  };
}
