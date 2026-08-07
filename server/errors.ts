import { env } from './env.js';

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** Google / ağ hatalarını kullanıcıya anlaşılır Türkçe mesaja çevirir. */
export function friendlyGoogleError(error: unknown, context: 'read' | 'write' = 'read'): string {
  const raw = rawMessage(error);
  const code =
    error && typeof error === 'object' && 'code' in error ? Number((error as { code: unknown }).code) : NaN;

  if (/quota|rate limit|read requests per minute|write requests per minute/i.test(raw)) {
    return 'Google API kotası doldu. 1–2 dakika bekleyip tekrar deneyin.';
  }

  if (
    /permission|insufficient|caller does not have|forbidden/i.test(raw) ||
    code === 403
  ) {
    const role = context === 'write' ? 'Düzenleyici' : 'Görüntüleyici';
    const what = context === 'write' ? 'yazma' : 'okuma';
    return `Google ${what} izni yok. Sheet / Drive klasörünü service account ile ${role} paylaşın (${env.serviceAccount.client_email}).`;
  }

  if (/not found|unable to parse range|unable to parse/i.test(raw) || code === 404) {
    return 'Google Sheet sayfası bulunamadı. Kullanicilar / Ekipler / Klasorler gibi sayfa adlarını kontrol edin.';
  }

  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|fetch failed/i.test(raw)) {
    return 'Google’a bağlanılamadı. İnternet bağlantınızı kontrol edin.';
  }

  if (/invalid_grant|invalid jwt|invalid credentials/i.test(raw)) {
    return 'Service account anahtarı geçersiz. secrets JSON dosyasını ve .env yolunu kontrol edin.';
  }

  return raw || 'Beklenmeyen bir sunucu hatası oluştu.';
}

export function isQuotaError(error: unknown): boolean {
  return /quota|rate limit|requests per minute/i.test(rawMessage(error));
}
