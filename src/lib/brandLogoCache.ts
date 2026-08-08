const KEY_PREFIX = 'er-diyagrami-brand-logo:';

export type BrandLogoScheme = 'light' | 'dark';

export function readBrandLogoCache(scheme: BrandLogoScheme): string | null {
  try {
    const value = window.localStorage.getItem(`${KEY_PREFIX}${scheme}`);
    return value && value.startsWith('data:') ? value : null;
  } catch {
    return null;
  }
}

export function writeBrandLogoCache(scheme: BrandLogoScheme, dataUrl: string): void {
  if (!dataUrl.startsWith('data:')) return;
  try {
    window.localStorage.setItem(`${KEY_PREFIX}${scheme}`, dataUrl);
  } catch {
    // kota / private mode — sessizce yoksay
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Logo okunamadı'));
    reader.readAsDataURL(blob);
  });
}
