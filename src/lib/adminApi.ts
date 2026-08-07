import { apiFetch } from './auth';

export type AdminUser = {
  username: string;
  isSuperAdmin: boolean;
  active: boolean;
};

export type AdminTeam = {
  teamId: string;
  teamName: string;
};

export type AdminMember = {
  teamId: string;
  username: string;
};

export type AdminFolder = {
  folderId: string;
  label: string;
  driveFolderId: string;
};

export type AdminPermission = {
  folderId: string;
  granteeType: 'user' | 'team';
  granteeId: string;
};

export type AdminSnapshot = {
  users: AdminUser[];
  teams: AdminTeam[];
  members: AdminMember[];
  folders: AdminFolder[];
  permissions: AdminPermission[];
};

export type DriveFolderOption = {
  id: string;
  name: string;
  fileCount: number;
};

export function fetchAdminSnapshot(token: string) {
  return apiFetch<AdminSnapshot>('/api/admin/snapshot', { token });
}

export function fetchDriveFolders(token: string) {
  return apiFetch<{ folders: DriveFolderOption[] }>('/api/admin/drive/folders', { token });
}

export function createAdminUser(
  token: string,
  body: { username: string; password: string; isSuperAdmin?: boolean; active?: boolean },
) {
  return apiFetch<{ user: AdminUser }>('/api/admin/users', {
    token,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function updateAdminUser(
  token: string,
  username: string,
  body: { password?: string; isSuperAdmin?: boolean; active?: boolean },
) {
  return apiFetch<{ user: AdminUser }>(`/api/admin/users/${encodeURIComponent(username)}`, {
    token,
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function deleteAdminUser(token: string, username: string) {
  return apiFetch<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(username)}`, {
    token,
    method: 'DELETE',
  });
}

export function createAdminTeam(token: string, body: { teamId?: string; teamName: string }) {
  return apiFetch<{ team: AdminTeam }>('/api/admin/teams', {
    token,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function updateAdminTeam(token: string, teamId: string, body: { teamName: string }) {
  return apiFetch<{ team: AdminTeam }>(`/api/admin/teams/${encodeURIComponent(teamId)}`, {
    token,
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function deleteAdminTeam(token: string, teamId: string) {
  return apiFetch<{ ok: boolean }>(`/api/admin/teams/${encodeURIComponent(teamId)}`, {
    token,
    method: 'DELETE',
  });
}

export function addAdminMember(token: string, body: { teamId: string; username: string }) {
  return apiFetch<{ member: AdminMember }>('/api/admin/members', {
    token,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function removeAdminMember(token: string, teamId: string, username: string) {
  return apiFetch<{ ok: boolean }>(
    `/api/admin/members/${encodeURIComponent(teamId)}/${encodeURIComponent(username)}`,
    { token, method: 'DELETE' },
  );
}

export function createAdminFolder(
  token: string,
  body: { folderId?: string; label: string; driveFolderId: string },
) {
  return apiFetch<{ folder: AdminFolder }>('/api/admin/folders', {
    token,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function updateAdminFolder(
  token: string,
  folderId: string,
  body: { label?: string; driveFolderId?: string },
) {
  return apiFetch<{ folder: AdminFolder }>(`/api/admin/folders/${encodeURIComponent(folderId)}`, {
    token,
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function deleteAdminFolder(token: string, folderId: string) {
  return apiFetch<{ ok: boolean }>(`/api/admin/folders/${encodeURIComponent(folderId)}`, {
    token,
    method: 'DELETE',
  });
}

export function createAdminPermission(
  token: string,
  body: { folderId: string; granteeType: 'user' | 'team'; granteeId: string },
) {
  return apiFetch<{ permission: AdminPermission }>('/api/admin/permissions', {
    token,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function deleteAdminPermission(
  token: string,
  folderId: string,
  granteeType: 'user' | 'team',
  granteeId: string,
) {
  return apiFetch<{ ok: boolean }>(
    `/api/admin/permissions/${encodeURIComponent(folderId)}/${encodeURIComponent(granteeType)}/${encodeURIComponent(granteeId)}`,
    { token, method: 'DELETE' },
  );
}
