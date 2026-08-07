/** Türkçe karakterleri sadeleştirip kısa id üretir. */
export function slugifyId(value: string, fallback = 'item'): string {
  const map: Record<string, string> = {
    ç: 'c',
    ğ: 'g',
    ı: 'i',
    ö: 'o',
    ş: 's',
    ü: 'u',
    Ç: 'c',
    Ğ: 'g',
    İ: 'i',
    I: 'i',
    Ö: 'o',
    Ş: 's',
    Ü: 'u',
  };

  const slug = value
    .trim()
    .split('')
    .map((char) => map[char] ?? char)
    .join('')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

  return slug || fallback;
}

export function uniqueSlug(base: string, existing: string[]): string {
  const normalizedExisting = new Set(existing.map((item) => item.toLowerCase()));
  if (!normalizedExisting.has(base.toLowerCase())) return base;

  let index = 2;
  while (normalizedExisting.has(`${base}_${index}`.toLowerCase())) {
    index += 1;
  }
  return `${base}_${index}`;
}
