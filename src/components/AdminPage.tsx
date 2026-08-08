import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { LanguageSwitcher } from './LanguageSwitcher';
import { useI18n, type MessageKey } from '../lib/i18n';
import {
  addAdminMember,
  createAdminFolder,
  createAdminPermission,
  createAdminTeam,
  createAdminUser,
  deleteAdminFolder,
  deleteAdminPermission,
  deleteAdminTeam,
  deleteAdminUser,
  fetchAdminSnapshot,
  fetchDriveFolders,
  removeAdminMember,
  updateAdminFolder,
  updateAdminTeam,
  updateAdminUser,
  type AdminSnapshot,
  type DriveFolderOption,
} from '../lib/adminApi';
import { applyThemeToDocument, readStoredTheme, THEME_META, type ThemeId } from '../lib/theme';
import './dbml-erd.css';
import './admin.css';

type AdminPageProps = {
  token: string;
  username: string;
  onBack: () => void;
  onLogout: () => void;
};

type TabId = 'users' | 'teams' | 'members' | 'folders' | 'permissions';

const TABS: { id: TabId; labelKey: MessageKey }[] = [
  { id: 'users', labelKey: 'admin.tab.users' },
  { id: 'teams', labelKey: 'admin.tab.teams' },
  { id: 'members', labelKey: 'admin.tab.members' },
  { id: 'folders', labelKey: 'admin.tab.folders' },
  { id: 'permissions', labelKey: 'admin.tab.permissions' },
];

export function AdminPage({ token, username, onBack, onLogout }: AdminPageProps) {
  const { t } = useI18n();
  const [theme] = useState<ThemeId>(() => readStoredTheme());
  const [tab, setTab] = useState<TabId>('users');
  const [snapshot, setSnapshot] = useState<AdminSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [userForm, setUserForm] = useState({
    username: '',
    password: '',
    isSuperAdmin: false,
    active: true,
  });
  const [teamForm, setTeamForm] = useState({ teamName: '' });
  const [memberForm, setMemberForm] = useState({ teamId: '', username: '' });
  const [folderForm, setFolderForm] = useState({ label: '', driveFolderId: '' });
  const [driveFolders, setDriveFolders] = useState<DriveFolderOption[]>([]);
  const [driveFoldersLoading, setDriveFoldersLoading] = useState(false);
  const [permissionForm, setPermissionForm] = useState<{
    folderId: string;
    granteeType: 'user' | 'team';
    granteeId: string;
  }>({ folderId: '', granteeType: 'user', granteeId: '' });

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAdminSnapshot(token);
      setSnapshot(data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('admin.loadFailed'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dil değişiminde refetch yok
  }, [token]);

  const reloadDriveFolders = useCallback(async () => {
    setDriveFoldersLoading(true);
    try {
      const data = await fetchDriveFolders(token);
      setDriveFolders(data.folders);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('admin.driveFoldersFailed'));
    } finally {
      setDriveFoldersLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dil değişiminde refetch yok
  }, [token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  useEffect(() => {
    if (tab === 'folders') void reloadDriveFolders();
  }, [tab, reloadDriveFolders]);

  async function run(action: () => Promise<unknown>, successMessage: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(successMessage);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('admin.failed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateUser(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      await createAdminUser(token, userForm);
      setUserForm({ username: '', password: '', isSuperAdmin: false, active: true });
    }, t('admin.msg.userAdded'));
  }

  async function handleCreateTeam(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      await createAdminTeam(token, { teamName: teamForm.teamName });
      setTeamForm({ teamName: '' });
    }, t('admin.msg.teamAdded'));
  }

  async function handleCreateMember(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      await addAdminMember(token, memberForm);
      setMemberForm({ teamId: '', username: '' });
    }, t('admin.msg.memberAdded'));
  }

  async function handleCreateFolder(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      await createAdminFolder(token, {
        label: folderForm.label,
        driveFolderId: folderForm.driveFolderId,
      });
      setFolderForm({ label: '', driveFolderId: '' });
      await reloadDriveFolders();
    }, t('admin.msg.folderAdded'));
  }

  async function handleCreatePermission(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      await createAdminPermission(token, permissionForm);
      setPermissionForm({ folderId: '', granteeType: 'user', granteeId: '' });
    }, t('admin.msg.permAdded'));
  }

  return (
    <div
      className="admin-page"
      data-theme={theme}
      data-scheme={THEME_META[theme].scheme}
    >
      <header className="admin-header">
        <div>
          <p className="admin-header__eyebrow">ER · {t('admin.eyebrow')}</p>
          <h1>{t('admin.title')}</h1>
          <p className="admin-header__meta">{username}</p>
        </div>
        <div className="admin-header__actions">
          <LanguageSwitcher className="lang-switch--header" />
          <button type="button" className="admin-btn admin-btn--ghost" onClick={onBack}>
            {t('nav.backErd')}
          </button>
          <button type="button" className="admin-btn admin-btn--ghost" onClick={onLogout}>
            {t('nav.logout')}
          </button>
        </div>
      </header>

      <nav className="admin-tabs" aria-label={t('admin.tabs')}>
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`admin-tabs__item${tab === item.id ? ' is-active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </nav>

      {(error || notice) && (
        <div className={`admin-banner${error ? ' is-error' : ' is-ok'}`}>{error || notice}</div>
      )}

      {loading || !snapshot ? (
        <div className="admin-loading">{t('admin.loading')}</div>
      ) : (
        <div className="admin-body">
          {tab === 'users' && (
            <section className="admin-panel">
              <form className="admin-form" onSubmit={(event) => void handleCreateUser(event)}>
                <h2>{t('admin.newUser')}</h2>
                <div className="admin-form__grid">
                  <label>
                    {t('admin.username')}
                    <input
                      value={userForm.username}
                      onChange={(event) => setUserForm((current) => ({ ...current, username: event.target.value }))}
                      required
                    />
                  </label>
                  <label>
                    {t('admin.password')}
                    <input
                      type="password"
                      value={userForm.password}
                      onChange={(event) => setUserForm((current) => ({ ...current, password: event.target.value }))}
                      required
                      minLength={4}
                    />
                  </label>
                  <label className="admin-check">
                    <input
                      type="checkbox"
                      checked={userForm.isSuperAdmin}
                      onChange={(event) =>
                        setUserForm((current) => ({ ...current, isSuperAdmin: event.target.checked }))
                      }
                    />
                    {t('admin.superAdmin')}
                  </label>
                  <label className="admin-check">
                    <input
                      type="checkbox"
                      checked={userForm.active}
                      onChange={(event) => setUserForm((current) => ({ ...current, active: event.target.checked }))}
                    />
                    {t('admin.active')}
                  </label>
                </div>
                <button type="submit" className="admin-btn" disabled={busy}>
                  {t('admin.add')}
                </button>
              </form>

              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>{t('admin.col.user')}</th>
                      <th>{t('admin.col.role')}</th>
                      <th>{t('admin.col.status')}</th>
                      <th>{t('admin.col.password')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.users.map((user) => (
                      <tr key={user.username}>
                        <td>{user.username}</td>
                        <td>{user.isSuperAdmin ? t('admin.role.admin') : t('admin.role.user')}</td>
                        <td>{user.active ? t('admin.status.active') : t('admin.status.inactive')}</td>
                        <td>
                          <button
                            type="button"
                            className="admin-btn admin-btn--small"
                            disabled={busy}
                            onClick={() => {
                              const password = window.prompt(t('admin.promptPassword', { user: user.username }));
                              if (!password) return;
                              void run(
                                () => updateAdminUser(token, user.username, { password }),
                                t('admin.msg.passwordUpdated'),
                              );
                            }}
                          >
                            {t('admin.changePassword')}
                          </button>
                        </td>
                        <td className="admin-table__actions">
                          <button
                            type="button"
                            className="admin-btn admin-btn--small"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () =>
                                  updateAdminUser(token, user.username, {
                                    isSuperAdmin: !user.isSuperAdmin,
                                  }),
                                t('admin.msg.roleUpdated'),
                              )
                            }
                          >
                            {user.isSuperAdmin ? t('admin.removeAdmin') : t('admin.makeAdmin')}
                          </button>
                          <button
                            type="button"
                            className="admin-btn admin-btn--small"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () => updateAdminUser(token, user.username, { active: !user.active }),
                                t('admin.msg.statusUpdated'),
                              )
                            }
                          >
                            {user.active ? t('admin.deactivate') : t('admin.activate')}
                          </button>
                          <button
                            type="button"
                            className="admin-btn admin-btn--small admin-btn--danger"
                            disabled={busy}
                            onClick={() => {
                              if (!window.confirm(t('admin.confirmDeleteUser', { user: user.username }))) return;
                              void run(() => deleteAdminUser(token, user.username), t('admin.msg.userDeleted'));
                            }}
                          >
                            {t('admin.delete')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {tab === 'teams' && (
            <section className="admin-panel">
              <form className="admin-form" onSubmit={(event) => void handleCreateTeam(event)}>
                <h2>{t('admin.newTeam')}</h2>
                <p className="admin-form__hint">{t('admin.teamHint')}</p>
                <div className="admin-form__grid">
                  <label>
                    {t('admin.teamName')}
                    <input
                      value={teamForm.teamName}
                      onChange={(event) => setTeamForm({ teamName: event.target.value })}
                      required
                    />
                  </label>
                </div>
                <button type="submit" className="admin-btn" disabled={busy}>
                  {t('admin.add')}
                </button>
              </form>

              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>{t('admin.col.id')}</th>
                      <th>{t('admin.col.name')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.teams.map((team) => (
                      <tr key={team.teamId}>
                        <td>{team.teamId}</td>
                        <td>{team.teamName}</td>
                        <td className="admin-table__actions">
                          <button
                            type="button"
                            className="admin-btn admin-btn--small"
                            disabled={busy}
                            onClick={() => {
                              const teamName = window.prompt(t('admin.promptTeamName'), team.teamName);
                              if (!teamName) return;
                              void run(
                                () => updateAdminTeam(token, team.teamId, { teamName }),
                                t('admin.msg.teamUpdated'),
                              );
                            }}
                          >
                            {t('admin.rename')}
                          </button>
                          <button
                            type="button"
                            className="admin-btn admin-btn--small admin-btn--danger"
                            disabled={busy}
                            onClick={() => {
                              if (!window.confirm(t('admin.confirmDeleteTeam', { name: team.teamName }))) return;
                              void run(() => deleteAdminTeam(token, team.teamId), t('admin.msg.teamDeleted'));
                            }}
                          >
                            {t('admin.delete')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {tab === 'members' && (
            <section className="admin-panel">
              <form className="admin-form" onSubmit={(event) => void handleCreateMember(event)}>
                <h2>{t('admin.newMember')}</h2>
                <div className="admin-form__grid">
                  <label>
                    {t('admin.team')}
                    <select
                      value={memberForm.teamId}
                      onChange={(event) => setMemberForm((current) => ({ ...current, teamId: event.target.value }))}
                      required
                    >
                      <option value="">{t('admin.select')}</option>
                      {snapshot.teams.map((team) => (
                        <option key={team.teamId} value={team.teamId}>
                          {team.teamName} ({team.teamId})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t('admin.user')}
                    <select
                      value={memberForm.username}
                      onChange={(event) => setMemberForm((current) => ({ ...current, username: event.target.value }))}
                      required
                    >
                      <option value="">{t('admin.select')}</option>
                      {snapshot.users.map((user) => (
                        <option key={user.username} value={user.username}>
                          {user.username}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button type="submit" className="admin-btn" disabled={busy}>
                  {t('admin.add')}
                </button>
              </form>

              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>{t('admin.col.team')}</th>
                      <th>{t('admin.col.user')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.members.map((member) => (
                      <tr key={`${member.teamId}:${member.username}`}>
                        <td>{member.teamId}</td>
                        <td>{member.username}</td>
                        <td className="admin-table__actions">
                          <button
                            type="button"
                            className="admin-btn admin-btn--small admin-btn--danger"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () => removeAdminMember(token, member.teamId, member.username),
                                t('admin.msg.memberRemoved'),
                              )
                            }
                          >
                            {t('admin.removeMember')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {tab === 'folders' && (
            <section className="admin-panel">
              <form className="admin-form" onSubmit={(event) => void handleCreateFolder(event)}>
                <h2>{t('admin.bindFolder')}</h2>
                <p className="admin-form__hint">
                  {t('admin.folderHint')}
                </p>
                <div className="admin-form__grid">
                  <label>
                    {t('admin.driveFolder')}
                    <select
                      value={folderForm.driveFolderId}
                      onChange={(event) => {
                        const driveFolderId = event.target.value;
                        const selected = driveFolders.find((folder) => folder.id === driveFolderId);
                        setFolderForm({
                          driveFolderId,
                          label: selected?.name || folderForm.label,
                        });
                      }}
                      required
                    >
                      <option value="">
                        {driveFoldersLoading ? t('admin.loading') : t('admin.pickFolder')}
                      </option>
                      {driveFolders
                        .filter(
                          (folder) =>
                            !snapshot.folders.some((item) => item.driveFolderId === folder.id),
                        )
                        .map((folder) => (
                          <option key={folder.id} value={folder.id}>
                            {folder.fileCount > 0
                              ? t('admin.folderWithFiles', { name: folder.name, count: folder.fileCount })
                              : folder.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    {t('admin.displayName')}
                    <input
                      value={folderForm.label}
                      onChange={(event) =>
                        setFolderForm((current) => ({ ...current, label: event.target.value }))
                      }
                      required
                    />
                  </label>
                </div>
                <div className="admin-form__row">
                  <button type="submit" className="admin-btn" disabled={busy || !folderForm.driveFolderId}>
                    {t('admin.bind')}
                  </button>
                  <button
                    type="button"
                    className="admin-btn admin-btn--ghost"
                    disabled={driveFoldersLoading}
                    onClick={() => void reloadDriveFolders()}
                  >
                    {t('admin.refreshList')}
                  </button>
                </div>
              </form>

              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>{t('admin.col.id')}</th>
                      <th>{t('admin.col.label')}</th>
                      <th>{t('admin.col.driveId')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.folders.map((folder) => (
                      <tr key={folder.folderId}>
                        <td>{folder.folderId}</td>
                        <td>{folder.label}</td>
                        <td className="admin-mono">{folder.driveFolderId}</td>
                        <td className="admin-table__actions">
                          <button
                            type="button"
                            className="admin-btn admin-btn--small"
                            disabled={busy}
                            onClick={() => {
                              const label = window.prompt(t('admin.promptLabel'), folder.label);
                              if (!label) return;
                              void run(
                                () => updateAdminFolder(token, folder.folderId, { label }),
                                t('admin.msg.folderUpdated'),
                              );
                            }}
                          >
                            {t('admin.editLabel')}
                          </button>
                          <button
                            type="button"
                            className="admin-btn admin-btn--small admin-btn--danger"
                            disabled={busy}
                            onClick={() => {
                              if (!window.confirm(t('admin.confirmDeleteFolder', { name: folder.label }))) return;
                              void run(() => deleteAdminFolder(token, folder.folderId), t('admin.msg.folderDeleted'));
                            }}
                          >
                            {t('admin.delete')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {tab === 'permissions' && (
            <section className="admin-panel">
              <form className="admin-form" onSubmit={(event) => void handleCreatePermission(event)}>
                <h2>{t('admin.grantPerm')}</h2>
                <div className="admin-form__grid">
                  <label>
                    {t('admin.col.folder')}
                    <select
                      value={permissionForm.folderId}
                      onChange={(event) =>
                        setPermissionForm((current) => ({ ...current, folderId: event.target.value }))
                      }
                      required
                    >
                      <option value="">{t('admin.select')}</option>
                      {snapshot.folders.map((folder) => (
                        <option key={folder.folderId} value={folder.folderId}>
                          {folder.label} ({folder.folderId})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t('admin.targetType')}
                    <select
                      value={permissionForm.granteeType}
                      onChange={(event) =>
                        setPermissionForm((current) => ({
                          ...current,
                          granteeType: event.target.value as 'user' | 'team',
                          granteeId: '',
                        }))
                      }
                    >
                      <option value="user">{t('admin.type.user')}</option>
                      <option value="team">{t('admin.type.team')}</option>
                    </select>
                  </label>
                  <label>
                    {t('admin.target')}
                    <select
                      value={permissionForm.granteeId}
                      onChange={(event) =>
                        setPermissionForm((current) => ({ ...current, granteeId: event.target.value }))
                      }
                      required
                    >
                      <option value="">{t('admin.select')}</option>
                      {permissionForm.granteeType === 'user'
                        ? snapshot.users.map((user) => (
                            <option key={user.username} value={user.username}>
                              {user.username}
                            </option>
                          ))
                        : snapshot.teams.map((team) => (
                            <option key={team.teamId} value={team.teamId}>
                              {team.teamName} ({team.teamId})
                            </option>
                          ))}
                    </select>
                  </label>
                </div>
                <button type="submit" className="admin-btn" disabled={busy}>
                  {t('admin.add')}
                </button>
              </form>

              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>{t('admin.col.folder')}</th>
                      <th>{t('admin.col.type')}</th>
                      <th>{t('admin.col.target')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.permissions.map((permission) => (
                      <tr
                        key={`${permission.folderId}:${permission.granteeType}:${permission.granteeId}`}
                      >
                        <td>{permission.folderId}</td>
                        <td>{permission.granteeType === 'user' ? t('admin.type.user') : t('admin.type.team')}</td>
                        <td>{permission.granteeId}</td>
                        <td className="admin-table__actions">
                          <button
                            type="button"
                            className="admin-btn admin-btn--small admin-btn--danger"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () =>
                                  deleteAdminPermission(
                                    token,
                                    permission.folderId,
                                    permission.granteeType,
                                    permission.granteeId,
                                  ),
                                t('admin.msg.permDeleted'),
                              )
                            }
                          >
                            {t('admin.delete')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
