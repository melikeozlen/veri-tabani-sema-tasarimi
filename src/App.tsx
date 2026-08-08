import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminPage } from './components/AdminPage';
import { DbmlErdViewer, type DbmlSource } from './components/DbmlErdViewer';
import { LoginPage } from './components/LoginPage';
import './components/dbml-erd.css';
import './components/login.css';
import { fetchSourceContent, fetchSourceList } from './lib/auth';
import { useI18n } from './lib/i18n';
import { applyThemeToDocument, readStoredTheme } from './lib/theme';
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

const LOCAL_SOURCES: DbmlSource[] = Object.entries(dbmlModules)
  .map(([path, content]) => toSource(path, content))
  .sort((a, b) => a.name.localeCompare(b.name, 'en'));

function AuthenticatedApp({
  token,
  username,
  isSuperAdmin,
  onLogout,
  sessionNotice,
  onDismissNotice,
}: {
  token: string;
  username: string;
  isSuperAdmin: boolean;
  onLogout: () => Promise<void>;
  sessionNotice?: string | null;
  onDismissNotice?: () => void;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<'erd' | 'admin'>('erd');

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
    () => [...driveSources, ...LOCAL_SOURCES],
    [driveSources],
  );

  const handleBack = useCallback(() => setView('erd'), []);
  const handleOpenAdmin = useCallback(() => setView('admin'), []);
  const handleLogout = useCallback(() => {
    void onLogout();
  }, [onLogout]);
  const handleDriveSourceUpdated = useCallback((sourceId: string, content: string) => {
    setDriveSources((current) =>
      current.map((source) =>
        source.id === sourceId ? { ...source, content } : source,
      ),
    );
  }, []);

  if (view === 'admin' && isSuperAdmin) {
    return (
      <AdminPage
        token={token}
        username={username}
        onBack={handleBack}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <>
      {sessionNotice && (
        <div className="app-session-notice" role="status">
          <span>{t('app.sessionNetwork')}</span>
          <button type="button" onClick={onDismissNotice}>
            ×
          </button>
        </div>
      )}
      <DbmlErdViewer
        sources={sources}
        title={t('app.titleSuffix')}
        height="100vh"
        userLabel={username}
        isSuperAdmin={isSuperAdmin}
        authToken={token}
        sourcesLoading={sourcesLoading}
        sourcesError={sourcesError}
        onLogout={handleLogout}
        onOpenAdmin={isSuperAdmin ? handleOpenAdmin : undefined}
        onDriveSourceUpdated={handleDriveSourceUpdated}
      />
    </>
  );
}

export default function App() {
  const auth = useAuth();
  const theme = readStoredTheme();

  useEffect(() => {
    if (auth.loading || !auth.user) {
      applyThemeToDocument(theme);
    }
  }, [auth.loading, auth.user, theme]);

  // IndexedDB okunurken boş bırak — sunucu /me için bekleme ekranı yok
  if (auth.loading) {
    return null;
  }

  if (!auth.user || !auth.token) {
    return (
      <LoginPage
        onLogin={auth.login}
        initialError={auth.authError}
        onClearInitialError={auth.clearAuthError}
      />
    );
  }

  return (
    <AuthenticatedApp
      token={auth.token}
      username={auth.user.username}
      isSuperAdmin={auth.user.isSuperAdmin}
      onLogout={auth.logout}
      sessionNotice={auth.sessionNotice}
      onDismissNotice={auth.clearSessionNotice}
    />
  );
}
