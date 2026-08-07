export type ThemeId = 'corp-light' | 'corp-dark' | 'dark' | 'light' | 'night' | 'sea' | 'split';

export const THEME_STORAGE_KEY = 'dbml-erd-theme';

export const THEME_OPTIONS: Array<{
  id: ThemeId;
  label: string;
  scheme: 'dark' | 'light';
  corporate?: boolean;
  swatchBg: string;
  swatchAccent: string;
  dot: string;
}> = [
  { id: 'corp-light', label: 'Nötr Açık', scheme: 'light', corporate: true, swatchBg: '#f7f7f5', swatchAccent: '#3f3f3c', dot: '#b8b8b2' },
  { id: 'corp-dark', label: 'Nötr Koyu', scheme: 'dark', corporate: true, swatchBg: '#1c1c1b', swatchAccent: '#c8c8c2', dot: '#4a4a46' },
  { id: 'light', label: 'Slate Açık', scheme: 'light', swatchBg: '#fbfcfd', swatchAccent: '#315d86', dot: '#9aa8b8' },
  { id: 'dark', label: 'Slate Koyu', scheme: 'dark', swatchBg: '#0f1419', swatchAccent: '#3d8fd1', dot: '#3a4554' },
  { id: 'sea', label: 'Teal Açık', scheme: 'light', swatchBg: '#f3f8f7', swatchAccent: '#0f766e', dot: '#8fafa9' },
  { id: 'night', label: 'Indigo Gece', scheme: 'dark', swatchBg: '#0b1020', swatchAccent: '#5eead4', dot: '#3a4568' },
  { id: 'split', label: 'Studio', scheme: 'light', swatchBg: '#d9dee6', swatchAccent: '#434b5a', dot: '#a8b3c2' },
];

export const THEME_META = Object.fromEntries(THEME_OPTIONS.map((item) => [item.id, item])) as Record<
  ThemeId,
  (typeof THEME_OPTIONS)[number]
>;

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return (
    value === 'corp-light' ||
    value === 'corp-dark' ||
    value === 'dark' ||
    value === 'light' ||
    value === 'night' ||
    value === 'sea' ||
    value === 'split'
  );
}

export function readStoredTheme(): ThemeId {
  if (typeof window === 'undefined') return 'corp-light';
  const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (isThemeId(saved)) return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'corp-dark' : 'corp-light';
}

export function applyThemeToDocument(theme: ThemeId) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.scheme = THEME_META[theme].scheme;
  document.body.style.background = THEME_META[theme].swatchBg;
}
