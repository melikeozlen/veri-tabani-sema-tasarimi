import { hashPassword } from './auth.js';
import {
  loadFolders,
  loadPermissions,
  loadTeamMembers,
  loadTeams,
  loadUsers,
  saveFolders,
  savePermissions,
  saveTeamMembers,
  saveTeams,
  saveUsers,
} from './sheet.js';
import { slugifyId, uniqueSlug } from './slug.js';
import type {
  GranteeType,
  SheetFolder,
  SheetPermission,
  SheetTeam,
  SheetTeamMember,
  SheetUser,
} from './types.js';

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

export async function createUser(input: {
  username: string;
  password: string;
  isSuperAdmin?: boolean;
  active?: boolean;
}): Promise<SheetUser> {
  const username = input.username.trim();
  if (!username) throw Object.assign(new Error('Kullanıcı adı gerekli.'), { status: 400 });
  if (!input.password || input.password.length < 4) {
    throw Object.assign(new Error('Şifre en az 4 karakter olmalı.'), { status: 400 });
  }

  const users = await loadUsers();
  if (users.some((user) => normalizeKey(user.username) === normalizeKey(username))) {
    throw Object.assign(new Error('Bu kullanıcı adı zaten var.'), { status: 409 });
  }

  const next: SheetUser = {
    username,
    passwordHash: await hashPassword(input.password),
    isSuperAdmin: Boolean(input.isSuperAdmin),
    active: input.active !== false,
  };
  await saveUsers([...users, next]);
  return next;
}

export async function updateUser(
  username: string,
  input: {
    password?: string;
    isSuperAdmin?: boolean;
    active?: boolean;
  },
): Promise<SheetUser> {
  const users = await loadUsers();
  const index = users.findIndex((user) => normalizeKey(user.username) === normalizeKey(username));
  if (index < 0) throw Object.assign(new Error('Kullanıcı bulunamadı.'), { status: 404 });

  const current = users[index];
  const next: SheetUser = {
    ...current,
    isSuperAdmin: input.isSuperAdmin ?? current.isSuperAdmin,
    active: input.active ?? current.active,
  };

  if (typeof input.password === 'string' && input.password.trim()) {
    if (input.password.length < 4) {
      throw Object.assign(new Error('Şifre en az 4 karakter olmalı.'), { status: 400 });
    }
    next.passwordHash = await hashPassword(input.password);
  }

  users[index] = next;
  await saveUsers(users);
  return next;
}

export async function deleteUser(username: string): Promise<void> {
  const users = await loadUsers();
  const remaining = users.filter((user) => normalizeKey(user.username) !== normalizeKey(username));
  if (remaining.length === users.length) {
    throw Object.assign(new Error('Kullanıcı bulunamadı.'), { status: 404 });
  }
  if (!remaining.some((user) => user.isSuperAdmin && user.active)) {
    throw Object.assign(new Error('En az bir aktif super admin kalmalı.'), { status: 400 });
  }

  await saveUsers(remaining);

  const members = await loadTeamMembers();
  await saveTeamMembers(
    members.filter((member) => normalizeKey(member.username) !== normalizeKey(username)),
  );

  const permissions = await loadPermissions();
  await savePermissions(
    permissions.filter(
      (permission) =>
        !(permission.granteeType === 'user' && normalizeKey(permission.granteeId) === normalizeKey(username)),
    ),
  );
}

export async function createTeam(input: { teamId?: string; teamName: string }): Promise<SheetTeam> {
  const teamName = input.teamName.trim();
  if (!teamName) throw Object.assign(new Error('Ekip adı gerekli.'), { status: 400 });

  const teams = await loadTeams();
  const requestedId = input.teamId?.trim();
  const teamId = requestedId
    ? requestedId
    : uniqueSlug(
        slugifyId(teamName, 'ekip'),
        teams.map((team) => team.teamId),
      );

  if (teams.some((team) => normalizeKey(team.teamId) === normalizeKey(teamId))) {
    throw Object.assign(new Error('Bu ekip ID zaten var.'), { status: 409 });
  }

  const next = { teamId, teamName };
  await saveTeams([...teams, next]);
  return next;
}

export async function updateTeam(
  teamId: string,
  input: { teamName: string },
): Promise<SheetTeam> {
  const teams = await loadTeams();
  const index = teams.findIndex((team) => normalizeKey(team.teamId) === normalizeKey(teamId));
  if (index < 0) throw Object.assign(new Error('Ekip bulunamadı.'), { status: 404 });

  const next = { ...teams[index], teamName: input.teamName.trim() || teams[index].teamName };
  teams[index] = next;
  await saveTeams(teams);
  return next;
}

export async function deleteTeam(teamId: string): Promise<void> {
  const teams = await loadTeams();
  const remaining = teams.filter((team) => normalizeKey(team.teamId) !== normalizeKey(teamId));
  if (remaining.length === teams.length) {
    throw Object.assign(new Error('Ekip bulunamadı.'), { status: 404 });
  }
  await saveTeams(remaining);

  const members = await loadTeamMembers();
  await saveTeamMembers(
    members.filter((member) => normalizeKey(member.teamId) !== normalizeKey(teamId)),
  );

  const permissions = await loadPermissions();
  await savePermissions(
    permissions.filter(
      (permission) =>
        !(permission.granteeType === 'team' && normalizeKey(permission.granteeId) === normalizeKey(teamId)),
    ),
  );
}

export async function addTeamMember(input: {
  teamId: string;
  username: string;
}): Promise<SheetTeamMember> {
  const teamId = input.teamId.trim();
  const username = input.username.trim();
  if (!teamId || !username) {
    throw Object.assign(new Error('Ekip ve kullanıcı gerekli.'), { status: 400 });
  }

  const [teams, users, members] = await Promise.all([loadTeams(), loadUsers(), loadTeamMembers()]);
  if (!teams.some((team) => normalizeKey(team.teamId) === normalizeKey(teamId))) {
    throw Object.assign(new Error('Ekip bulunamadı.'), { status: 404 });
  }
  if (!users.some((user) => normalizeKey(user.username) === normalizeKey(username))) {
    throw Object.assign(new Error('Kullanıcı bulunamadı.'), { status: 404 });
  }
  if (
    members.some(
      (member) =>
        normalizeKey(member.teamId) === normalizeKey(teamId) &&
        normalizeKey(member.username) === normalizeKey(username),
    )
  ) {
    throw Object.assign(new Error('Kullanıcı zaten bu ekipte.'), { status: 409 });
  }

  const next = { teamId, username };
  await saveTeamMembers([...members, next]);
  return next;
}

export async function removeTeamMember(teamId: string, username: string): Promise<void> {
  const members = await loadTeamMembers();
  const remaining = members.filter(
    (member) =>
      !(
        normalizeKey(member.teamId) === normalizeKey(teamId) &&
        normalizeKey(member.username) === normalizeKey(username)
      ),
  );
  if (remaining.length === members.length) {
    throw Object.assign(new Error('Üyelik bulunamadı.'), { status: 404 });
  }
  await saveTeamMembers(remaining);
}

export async function createFolder(input: {
  folderId?: string;
  label: string;
  driveFolderId: string;
}): Promise<SheetFolder> {
  const driveFolderId = input.driveFolderId.trim();
  const label = input.label.trim();
  if (!driveFolderId) {
    throw Object.assign(new Error('Drive klasörü seçilmeli.'), { status: 400 });
  }
  if (!label) {
    throw Object.assign(new Error('Etiket gerekli.'), { status: 400 });
  }

  const folders = await loadFolders();
  if (folders.some((folder) => folder.driveFolderId === driveFolderId)) {
    throw Object.assign(new Error('Bu Drive klasörü zaten ekli.'), { status: 409 });
  }

  const requestedId = input.folderId?.trim();
  const folderId = requestedId
    ? requestedId
    : uniqueSlug(
        slugifyId(label, 'klasor'),
        folders.map((folder) => folder.folderId),
      );

  if (folders.some((folder) => normalizeKey(folder.folderId) === normalizeKey(folderId))) {
    throw Object.assign(new Error('Bu klasör ID zaten var.'), { status: 409 });
  }

  const next = { folderId, label, driveFolderId };
  await saveFolders([...folders, next]);
  return next;
}

export async function updateFolder(
  folderId: string,
  input: { label?: string; driveFolderId?: string },
): Promise<SheetFolder> {
  const folders = await loadFolders();
  const index = folders.findIndex((folder) => normalizeKey(folder.folderId) === normalizeKey(folderId));
  if (index < 0) throw Object.assign(new Error('Klasör bulunamadı.'), { status: 404 });

  const current = folders[index];
  const next: SheetFolder = {
    ...current,
    label: input.label?.trim() || current.label,
    driveFolderId: input.driveFolderId?.trim() || current.driveFolderId,
  };
  folders[index] = next;
  await saveFolders(folders);
  return next;
}

export async function deleteFolder(folderId: string): Promise<void> {
  const folders = await loadFolders();
  const remaining = folders.filter((folder) => normalizeKey(folder.folderId) !== normalizeKey(folderId));
  if (remaining.length === folders.length) {
    throw Object.assign(new Error('Klasör bulunamadı.'), { status: 404 });
  }
  await saveFolders(remaining);

  const permissions = await loadPermissions();
  await savePermissions(
    permissions.filter((permission) => normalizeKey(permission.folderId) !== normalizeKey(folderId)),
  );
}

export async function createPermission(input: {
  folderId: string;
  granteeType: GranteeType;
  granteeId: string;
}): Promise<SheetPermission> {
  const folderId = input.folderId.trim();
  const granteeId = input.granteeId.trim();
  const granteeType = input.granteeType;
  if (!folderId || !granteeId || (granteeType !== 'user' && granteeType !== 'team')) {
    throw Object.assign(new Error('Geçersiz yetki bilgisi.'), { status: 400 });
  }

  const [folders, users, teams, permissions] = await Promise.all([
    loadFolders(),
    loadUsers(),
    loadTeams(),
    loadPermissions(),
  ]);

  if (!folders.some((folder) => normalizeKey(folder.folderId) === normalizeKey(folderId))) {
    throw Object.assign(new Error('Klasör bulunamadı.'), { status: 404 });
  }
  if (granteeType === 'user') {
    if (!users.some((user) => normalizeKey(user.username) === normalizeKey(granteeId))) {
      throw Object.assign(new Error('Kullanıcı bulunamadı.'), { status: 404 });
    }
  } else if (!teams.some((team) => normalizeKey(team.teamId) === normalizeKey(granteeId))) {
    throw Object.assign(new Error('Ekip bulunamadı.'), { status: 404 });
  }

  if (
    permissions.some(
      (permission) =>
        normalizeKey(permission.folderId) === normalizeKey(folderId) &&
        permission.granteeType === granteeType &&
        normalizeKey(permission.granteeId) === normalizeKey(granteeId),
    )
  ) {
    throw Object.assign(new Error('Bu yetki zaten var.'), { status: 409 });
  }

  const next = { folderId, granteeType, granteeId };
  await savePermissions([...permissions, next]);
  return next;
}

export async function deletePermission(
  folderId: string,
  granteeType: GranteeType,
  granteeId: string,
): Promise<void> {
  const permissions = await loadPermissions();
  const remaining = permissions.filter(
    (permission) =>
      !(
        normalizeKey(permission.folderId) === normalizeKey(folderId) &&
        permission.granteeType === granteeType &&
        normalizeKey(permission.granteeId) === normalizeKey(granteeId)
      ),
  );
  if (remaining.length === permissions.length) {
    throw Object.assign(new Error('Yetki bulunamadı.'), { status: 404 });
  }
  await savePermissions(remaining);
}
