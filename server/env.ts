import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(process.cwd(), '.env') });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Eksik ortam değişkeni: ${name}`);
  return value;
}

function optional(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

export type ServiceAccountCredentials = {
  client_email: string;
  private_key: string;
};

function loadServiceAccount(): ServiceAccountCredentials {
  // Production (Railway): email + key tercih edilir.
  const email = optional('GOOGLE_SERVICE_ACCOUNT_EMAIL');
  const privateKey = optional('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n');
  if (email && privateKey) {
    return { client_email: email, private_key: privateKey };
  }

  const filePath = optional('GOOGLE_SERVICE_ACCOUNT_FILE');
  if (filePath) {
    // Yanlışlıkla email bu alana yazılmışsa net hata ver.
    if (filePath.includes('@') && !filePath.includes('/') && !/\.json$/i.test(filePath)) {
      throw new Error(
        'GOOGLE_SERVICE_ACCOUNT_FILE dosya yolu olmalı. Email için GOOGLE_SERVICE_ACCOUNT_EMAIL, anahtar için GOOGLE_PRIVATE_KEY kullanın.',
      );
    }

    const absolute = resolve(process.cwd(), filePath);
    try {
      const raw = JSON.parse(readFileSync(absolute, 'utf8')) as {
        client_email?: string;
        private_key?: string;
      };
      if (!raw.client_email || !raw.private_key) {
        throw new Error('Service account JSON içinde client_email ve private_key olmalı.');
      }
      return {
        client_email: raw.client_email,
        private_key: raw.private_key,
      };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new Error(
          `Service account dosyası bulunamadı: ${filePath}. Railway’de GOOGLE_SERVICE_ACCOUNT_FILE’ı silip GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY kullanın.`,
        );
      }
      throw error;
    }
  }

  throw new Error(
    'GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY veya GOOGLE_SERVICE_ACCOUNT_FILE tanımlayın.',
  );
}

export const env = {
  port: Number(optional('API_PORT', optional('PORT', '3001'))) || 3001,
  sessionSecret: required('SESSION_SECRET'),
  sheetId: required('GOOGLE_SHEET_ID'),
  driveRootFolderId: optional('GOOGLE_DRIVE_ROOT_FOLDER_ID'),
  tokenTtlDays: Number(optional('SESSION_TTL_DAYS', '7')) || 7,
  serviceAccount: loadServiceAccount(),
};
