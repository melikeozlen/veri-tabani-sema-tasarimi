import { useI18n, type Locale } from '../lib/i18n';
import './language-switcher.css';

const OPTIONS: Locale[] = ['tr', 'en'];

type LanguageSwitcherProps = {
  className?: string;
};

export function LanguageSwitcher({ className = '' }: LanguageSwitcherProps) {
  const { locale, setLocale, t } = useI18n();

  return (
    <div className={`lang-switch ${className}`.trim()} role="group" aria-label={t('lang.label')}>
      {OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          className={`lang-switch__btn${locale === option ? ' is-active' : ''}`}
          onClick={() => setLocale(option)}
          aria-pressed={locale === option}
        >
          {t(option === 'tr' ? 'lang.tr' : 'lang.en')}
        </button>
      ))}
    </div>
  );
}
