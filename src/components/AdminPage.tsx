import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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

type AdminDialog =
  | {
      mode: 'confirm';
      title: string;
      message: string;
      confirmLabel: string;
      onConfirm: () => void;
    }
  | {
      mode: 'prompt';
      title: string;
      fieldLabel: string;
      value: string;
      inputType?: 'text' | 'password';
      confirmLabel: string;
      onConfirm: (value: string) => void;
    };

const TABS: { id: TabId; labelKey: MessageKey }[] = [
  { id: 'users', labelKey: 'admin.tab.users' },
  { id: 'teams', labelKey: 'admin.tab.teams' },
  { id: 'members', labelKey: 'admin.tab.members' },
  { id: 'folders', labelKey: 'admin.tab.folders' },
  { id: 'permissions', labelKey: 'admin.tab.permissions' },
];

function matchesTableSearch(query: string, values: Array<string | number | boolean | null | undefined>) {
  const normalized = query.trim().toLocaleLowerCase('tr-TR');
  if (!normalized) return true;
  return values.some((value) => String(value ?? '').toLocaleLowerCase('tr-TR').includes(normalized));
}

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
  const [tableSearch, setTableSearch] = useState('');
  const [dialog, setDialog] = useState<AdminDialog | null>(null);
  const dialogInputRef = useRef<HTMLInputElement | null>(null);
  const [dialogSession, setDialogSession] = useState(0);

  const closeDialog = useCallback(() => setDialog(null), []);

  const openConfirm = useCallback(
    (message: string, onConfirm: () => void, title?: string) => {
      setDialogSession((current) => current + 1);
      setDialog({
        mode: 'confirm',
        title: title ?? t('admin.dialog.confirmTitle'),
        message,
        confirmLabel: t('admin.delete'),
        onConfirm,
      });
    },
    [t],
  );

  const openPrompt = useCallback(
    (options: {
      title: string;
      fieldLabel: string;
      value: string;
      inputType?: 'text' | 'password';
      confirmLabel?: string;
      onConfirm: (value: string) => void;
    }) => {
      setDialogSession((current) => current + 1);
      setDialog({
        mode: 'prompt',
        title: options.title,
        fieldLabel: options.fieldLabel,
        value: options.value,
        inputType: options.inputType,
        confirmLabel: options.confirmLabel ?? t('admin.dialog.save'),
        onConfirm: options.onConfirm,
      });
    },
    [t],
  );

  useEffect(() => {
    if (!dialog || dialog.mode !== 'prompt') return;
    const id = window.setTimeout(() => {
      dialogInputRef.current?.focus();
      dialogInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, [dialogSession, dialog?.mode]);

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

  useEffect(() => {
    setTableSearch('');
  }, [tab]);

  const filteredUsers = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.users.filter((user) =>
      matchesTableSearch(tableSearch, [
        user.username,
        user.isSuperAdmin ? t('admin.role.admin') : t('admin.role.user'),
        user.active ? t('admin.status.active') : t('admin.status.inactive'),
        user.isSuperAdmin ? 'admin' : 'user',
        user.active ? 'active' : 'inactive',
      ]),
    );
  }, [snapshot, tableSearch, t]);

  const filteredTeams = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.teams.filter((team) =>
      matchesTableSearch(tableSearch, [team.teamId, team.teamName]),
    );
  }, [snapshot, tableSearch]);

  const filteredMembers = useMemo(() => {
    if (!snapshot) return [];
    const teamNameById = new Map(snapshot.teams.map((team) => [team.teamId, team.teamName]));
    return snapshot.members.filter((member) =>
      matchesTableSearch(tableSearch, [
        member.teamId,
        member.username,
        teamNameById.get(member.teamId),
      ]),
    );
  }, [snapshot, tableSearch]);

  const filteredFolders = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.folders.filter((folder) =>
      matchesTableSearch(tableSearch, [folder.folderId, folder.label, folder.driveFolderId]),
    );
  }, [snapshot, tableSearch]);

  const filteredPermissions = useMemo(() => {
    if (!snapshot) return [];
    const folderLabelById = new Map(snapshot.folders.map((folder) => [folder.folderId, folder.label]));
    const teamNameById = new Map(snapshot.teams.map((team) => [team.teamId, team.teamName]));
    return snapshot.permissions.filter((permission) =>
      matchesTableSearch(tableSearch, [
        permission.folderId,
        folderLabelById.get(permission.folderId),
        permission.granteeType,
        permission.granteeId,
        permission.granteeType === 'user' ? t('admin.type.user') : t('admin.type.team'),
        permission.granteeType === 'team' ? teamNameById.get(permission.granteeId) : undefined,
      ]),
    );
  }, [snapshot, tableSearch, t]);

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
          <p className="admin-header__eyebrow">{t('brand.eyebrow')} · {t('admin.eyebrow')}</p>
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
          <div className="admin-table-search">
            <input
              type="search"
              value={tableSearch}
              onChange={(event) => setTableSearch(event.target.value)}
              placeholder={t('admin.tableSearch')}
              aria-label={t('admin.tableSearchAria')}
            />
            {tableSearch.trim() && (
              <button
                type="button"
                className="admin-btn admin-btn--ghost admin-btn--small"
                onClick={() => setTableSearch('')}
              >
                {t('admin.tableSearchClear')}
              </button>
            )}
          </div>

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
                    {filteredUsers.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="admin-table__empty">
                          {t('admin.noMatches')}
                        </td>
                      </tr>
                    ) : (
                      filteredUsers.map((user) => (
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
                              openPrompt({
                                title: t('admin.dialog.passwordTitle'),
                                fieldLabel: t('admin.promptPassword', { user: user.username }),
                                value: '',
                                inputType: 'password',
                                onConfirm: (password) => {
                                  if (!password.trim()) return;
                                  void run(
                                    () => updateAdminUser(token, user.username, { password }),
                                    t('admin.msg.passwordUpdated'),
                                  );
                                },
                              });
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
                              openConfirm(t('admin.confirmDeleteUser', { user: user.username }), () => {
                                void run(() => deleteAdminUser(token, user.username), t('admin.msg.userDeleted'));
                              });
                            }}
                          >
                            {t('admin.delete')}
                          </button>
                        </td>
                      </tr>
                      ))
                    )}
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
                    {filteredTeams.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="admin-table__empty">
                          {t('admin.noMatches')}
                        </td>
                      </tr>
                    ) : (
                      filteredTeams.map((team) => (
                      <tr key={team.teamId}>
                        <td>{team.teamId}</td>
                        <td>{team.teamName}</td>
                        <td className="admin-table__actions">
                          <button
                            type="button"
                            className="admin-btn admin-btn--small"
                            disabled={busy}
                            onClick={() => {
                              openPrompt({
                                title: t('admin.dialog.renameTitle'),
                                fieldLabel: t('admin.promptTeamName'),
                                value: team.teamName,
                                onConfirm: (teamName) => {
                                  if (!teamName.trim()) return;
                                  void run(
                                    () => updateAdminTeam(token, team.teamId, { teamName }),
                                    t('admin.msg.teamUpdated'),
                                  );
                                },
                              });
                            }}
                          >
                            {t('admin.rename')}
                          </button>
                          <button
                            type="button"
                            className="admin-btn admin-btn--small admin-btn--danger"
                            disabled={busy}
                            onClick={() => {
                              openConfirm(t('admin.confirmDeleteTeam', { name: team.teamName }), () => {
                                void run(() => deleteAdminTeam(token, team.teamId), t('admin.msg.teamDeleted'));
                              });
                            }}
                          >
                            {t('admin.delete')}
                          </button>
                        </td>
                      </tr>
                      ))
                    )}
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
                    {filteredMembers.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="admin-table__empty">
                          {t('admin.noMatches')}
                        </td>
                      </tr>
                    ) : (
                      filteredMembers.map((member) => (
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
                      ))
                    )}
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
                    {filteredFolders.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="admin-table__empty">
                          {t('admin.noMatches')}
                        </td>
                      </tr>
                    ) : (
                      filteredFolders.map((folder) => (
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
                              openPrompt({
                                title: t('admin.dialog.labelTitle'),
                                fieldLabel: t('admin.promptLabel'),
                                value: folder.label,
                                onConfirm: (label) => {
                                  if (!label.trim()) return;
                                  void run(
                                    () => updateAdminFolder(token, folder.folderId, { label }),
                                    t('admin.msg.folderUpdated'),
                                  );
                                },
                              });
                            }}
                          >
                            {t('admin.editLabel')}
                          </button>
                          <button
                            type="button"
                            className="admin-btn admin-btn--small admin-btn--danger"
                            disabled={busy}
                            onClick={() => {
                              openConfirm(t('admin.confirmDeleteFolder', { name: folder.label }), () => {
                                void run(() => deleteAdminFolder(token, folder.folderId), t('admin.msg.folderDeleted'));
                              });
                            }}
                          >
                            {t('admin.delete')}
                          </button>
                        </td>
                      </tr>
                      ))
                    )}
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
                    {filteredPermissions.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="admin-table__empty">
                          {t('admin.noMatches')}
                        </td>
                      </tr>
                    ) : (
                      filteredPermissions.map((permission) => (
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
                            onClick={() => {
                              openConfirm(t('admin.confirmDeletePerm'), () => {
                                void run(
                                  () =>
                                    deleteAdminPermission(
                                      token,
                                      permission.folderId,
                                      permission.granteeType,
                                      permission.granteeId,
                                    ),
                                  t('admin.msg.permDeleted'),
                                );
                              });
                            }}
                          >
                            {t('admin.delete')}
                          </button>
                        </td>
                      </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}

      {dialog && (
        <div
          className="admin-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="admin-dialog-title"
          onClick={closeDialog}
        >
          <div className="admin-dialog__panel" onClick={(event) => event.stopPropagation()}>
            <h3 id="admin-dialog-title">{dialog.title}</h3>
            {dialog.mode === 'confirm' ? (
              <p className="admin-dialog__message">{dialog.message}</p>
            ) : (
              <label className="admin-dialog__field">
                <span>{dialog.fieldLabel}</span>
                <input
                  ref={dialogInputRef}
                  type={dialog.inputType ?? 'text'}
                  value={dialog.value}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDialog((current) =>
                      current && current.mode === 'prompt' ? { ...current, value } : current,
                    );
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      const value = dialog.value.trim();
                      if (!value && dialog.inputType === 'password') return;
                      if (!value && dialog.inputType !== 'password') return;
                      const onConfirm = dialog.onConfirm;
                      closeDialog();
                      onConfirm(dialog.value);
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      closeDialog();
                    }
                  }}
                />
              </label>
            )}
            <div className="admin-dialog__actions">
              <button type="button" className="admin-btn admin-btn--ghost" onClick={closeDialog}>
                {t('admin.cancel')}
              </button>
              {dialog.mode === 'confirm' ? (
                <button
                  type="button"
                  className="admin-btn admin-btn--danger"
                  onClick={() => {
                    const onConfirm = dialog.onConfirm;
                    closeDialog();
                    onConfirm();
                  }}
                >
                  {dialog.confirmLabel}
                </button>
              ) : (
                <button
                  type="button"
                  className="admin-btn"
                  disabled={!dialog.value.trim()}
                  onClick={() => {
                    const value = dialog.value.trim();
                    if (!value) return;
                    const onConfirm = dialog.onConfirm;
                    closeDialog();
                    onConfirm(dialog.value);
                  }}
                >
                  {dialog.confirmLabel}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
