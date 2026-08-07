import { useEffect, useState, type FormEvent } from 'react';
import { LanguageSwitcher } from './LanguageSwitcher';
import { useI18n } from '../lib/i18n';
import {
  applyThemeToDocument,
  readStoredTheme,
  THEME_META,
  type ThemeId,
} from '../lib/theme';
import './dbml-erd.css';
import './login.css';

type LoginPageProps = {
  onLogin: (username: string, password: string) => Promise<void>;
};

export function LoginPage({ onLogin }: LoginPageProps) {
  const { t } = useI18n();
  const [theme] = useState<ThemeId>(() => readStoredTheme());
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onLogin(username.trim(), password);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('login.failed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="login-page"
      data-theme={theme}
      data-scheme={THEME_META[theme].scheme}
    >
      <LanguageSwitcher className="lang-switch--login" />
      <div className="login-page__glow" aria-hidden="true" />
      <form className="login-card" onSubmit={(event) => void handleSubmit(event)}>
        <p className="login-card__eyebrow">{t('brand.eyebrow')}</p>
        <h1 className="login-card__title">{t('login.title')}</h1>

        <label className="login-field">
          <span>{t('login.username')}</span>
          <input
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
            autoFocus
          />
        </label>

        <label className="login-field">
          <span>{t('login.password')}</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>

        {error && <div className="login-card__error">{error}</div>}

        <button type="submit" className="login-card__submit" disabled={submitting}>
          {submitting ? t('login.submitting') : t('login.submit')}
        </button>
      </form>
    </div>
  );
}
