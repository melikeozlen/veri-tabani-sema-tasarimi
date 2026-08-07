import { useEffect, useMemo, useState } from 'react';
import { AdminPage } from './components/AdminPage';
import { DbmlErdViewer, type DbmlSource } from './components/DbmlErdViewer';
import { LanguageSwitcher } from './components/LanguageSwitcher';
import { LoginPage } from './components/LoginPage';
import './components/dbml-erd.css';
import './components/login.css';
import { fetchSourceContent, fetchSourceList } from './lib/auth';
import { useI18n } from './lib/i18n';
import { applyThemeToDocument, readStoredTheme, THEME_META } from './lib/theme';
import { useAuth } from './lib/useAuth';

const dbmlModules = import.meta.glob('./**/*.dbml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function toSource(path: string, content: string): DbmlSource {
  const fileName = path.split('/').pop() ?? path;
  return {
    id: path,
    name: fileName,
    label: fileName.replace(/\.dbml$/i, ''),
    content,
    kind: 'local',
  };
}

function sourceDisplayName(fileName: string): string {
  return fileName.replace(/\.(dbml|txt)$/i, '');
}

function AuthenticatedApp({
  token,
  username,
  isSuperAdmin,
  onLogout,
}: {
  token: string;
  username: string;
  isSuperAdmin: boolean;
  onLogout: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const [view, setView] = useState<'erd' | 'admin'>('erd');

  const localSources = useMemo(
    () =>
      Object.entries(dbmlModules)
        .map(([path, content]) => toSource(path, content))
        .sort((a, b) => a.name.localeCompare(b.name, locale)),
    [locale],
  );

  const [driveSources, setDriveSources] = useState<DbmlSource[]>([]);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [sourcesLoading, setSourcesLoading] = useState(true);

  useEffect(() => {
    if (view !== 'erd') return;

    let cancelled = false;

    (async () => {
      setSourcesLoading(true);
      setSourcesError(null);
      try {
        const list = await fetchSourceList(token);
        const loaded = await Promise.all(
          list.map(async (item) => {
            const full = await fetchSourceContent(token, item.id);
            const source: DbmlSource = {
              id: `drive:${full.id}`,
              name: full.name,
              label: `${full.folderLabel} · ${sourceDisplayName(full.name)}`,
              content: full.content,
              kind: 'drive',
              url: `https://drive.google.com/file/d/${full.id}/view`,
            };
            return source;
          }),
        );
        if (!cancelled) setDriveSources(loaded);
      } catch (error) {
        if (!cancelled) {
          setDriveSources([]);
          setSourcesError(
            error instanceof Error ? error.message : t('sources.loadFailed'),
          );
        }
      } finally {
        if (!cancelled) setSourcesLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Dil değişiminde yeniden çekme — yalnızca oturum / ERD görünümü.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t bilerek hariç
  }, [token, view]);

  const sources = useMemo(
    () => [...driveSources, ...localSources],
    [driveSources, localSources],
  );

  if (view === 'admin' && isSuperAdmin) {
    return (
      <AdminPage
        token={token}
        username={username}
        onBack={() => setView('erd')}
        onLogout={() => void onLogout()}
      />
    );
  }

  return (
    <DbmlErdViewer
      sources={sources}
      title={t('app.titleSuffix')}
      height="100vh"
      userLabel={username}
      isSuperAdmin={isSuperAdmin}
      authToken={token}
      sourcesLoading={sourcesLoading}
      sourcesError={sourcesError}
      onLogout={() => void onLogout()}
      onOpenAdmin={isSuperAdmin ? () => setView('admin') : undefined}
      onDriveSourceUpdated={(sourceId, content) => {
        setDriveSources((current) =>
          current.map((source) =>
            source.id === sourceId ? { ...source, content } : source,
          ),
        );
      }}
    />
  );
}

export default function App() {
  const auth = useAuth();
  const { t } = useI18n();
  const theme = readStoredTheme();

  useEffect(() => {
    if (auth.loading || !auth.user) {
      applyThemeToDocument(theme);
    }
  }, [auth.loading, auth.user, theme]);

  if (auth.loading) {
    return (
      <div
        className="login-page"
        data-theme={theme}
        data-scheme={THEME_META[theme].scheme}
      >
        <LanguageSwitcher className="lang-switch--login" />
        <div className="login-card">
          <p className="login-card__eyebrow">{t('brand.eyebrow')}</p>
          <h1 className="login-card__title">{t('app.sessionCheck')}</h1>
        </div>
      </div>
    );
  }

  if (!auth.user || !auth.token) {
    return <LoginPage onLogin={auth.login} />;
  }

  return (
    <AuthenticatedApp
      token={auth.token}
      username={auth.user.username}
      isSuperAdmin={auth.user.isSuperAdmin}
      onLogout={auth.logout}
    />
  );
}
