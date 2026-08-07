import { env } from './env.js';
import { sheets } from './google.js';
import type {
  GranteeType,
  SheetFolder,
  SheetPermission,
  SheetTeam,
  SheetTeamMember,
  SheetUser,
} from './types.js';

const SHEET_READ_CACHE_TTL_MS = 45_000;

type CacheEntry = {
  expiresAt: number;
  value: string[][];
};

const readCache = new Map<string, CacheEntry>();
const inflightReads = new Map<string, Promise<string[][]>>();

function cacheKey(range: string): string {
  return range.trim().toLowerCase();
}

function invalidateSheetCache(tab?: string) {
  if (!tab) {
    readCache.clear();
    return;
  }
  const prefix = tab.trim().toLowerCase();
  for (const key of readCache.keys()) {
    if (key === prefix || key.startsWith(`${prefix}!`)) {
      readCache.delete(key);
    }
  }
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_');
}

function headerIndex(headers: string[], aliases: string[]): number {
  const normalized = headers.map(normalizeHeader);
  for (const alias of aliases) {
    const idx = normalized.indexOf(normalizeHeader(alias));
    if (idx >= 0) return idx;
  }
  return -1;
}

function cell(row: string[], index: number): string {
  if (index < 0) return '';
  return (row[index] ?? '').trim();
}

function isTruthy(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'evet' || v === 'x';
}

async function readSheet(range: string): Promise<string[][]> {
  const key = cacheKey(range);
  const cached = readCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value.map((row) => [...row]);
  }

  const pending = inflightReads.get(key);
  if (pending) {
    const value = await pending;
    return value.map((row) => [...row]);
  }

  const request = (async () => {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: env.sheetId,
      range,
    });
    const values = response.data.values;
    const normalized =
      !values || values.length === 0
        ? []
        : values.map((row) => row.map((cellValue) => String(cellValue ?? '')));

    readCache.set(key, {
      expiresAt: Date.now() + SHEET_READ_CACHE_TTL_MS,
      value: normalized,
    });
    return normalized;
  })();

  inflightReads.set(key, request);
  try {
    const value = await request;
    return value.map((row) => [...row]);
  } finally {
    inflightReads.delete(key);
  }
}

async function writeSheet(tab: string, values: string[][]): Promise<void> {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: env.sheetId,
    range: tab,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: env.sheetId,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
  invalidateSheetCache(tab);
}

export async function loadUsers(): Promise<SheetUser[]> {
  const rows = await readSheet('Kullanicilar');
  if (rows.length < 2) return [];

  const headers = rows[0];
  const usernameIdx = headerIndex(headers, ['username', 'kullanici_adi', 'kullaniciadi', 'user']);
  const passwordIdx = headerIndex(headers, ['password_hash', 'password', 'sifre', 'sifre_hash']);
  const adminIdx = headerIndex(headers, ['is_super_admin', 'super_admin', 'superadmin']);
  const activeIdx = headerIndex(headers, ['aktif', 'active', 'enabled']);

  if (usernameIdx < 0 || passwordIdx < 0) {
    throw new Error('Kullanicilar sayfasında username ve password_hash sütunları gerekli.');
  }

  return rows.slice(1).flatMap((row) => {
    const username = cell(row, usernameIdx);
    const passwordHash = cell(row, passwordIdx);
    if (!username || !passwordHash) return [];
    return [
      {
        username,
        passwordHash,
        isSuperAdmin: isTruthy(cell(row, adminIdx)),
        active: activeIdx < 0 ? true : isTruthy(cell(row, activeIdx)),
      },
    ];
  });
}

export async function saveUsers(users: SheetUser[]): Promise<void> {
  await writeSheet('Kullanicilar', [
    ['username', 'password_hash', 'is_super_admin', 'aktif'],
    ...users.map((user) => [
      user.username,
      user.passwordHash,
      user.isSuperAdmin ? 'TRUE' : 'FALSE',
      user.active ? 'TRUE' : 'FALSE',
    ]),
  ]);
}

export async function loadTeams(): Promise<SheetTeam[]> {
  const rows = await readSheet('Ekipler');
  if (rows.length < 2) return [];
  const headers = rows[0];
  const idIdx = headerIndex(headers, ['team_id', 'ekip_id', 'id']);
  const nameIdx = headerIndex(headers, ['team_name', 'ekip_adi', 'name', 'ad']);
  if (idIdx < 0) return [];

  return rows.slice(1).flatMap((row) => {
    const teamId = cell(row, idIdx);
    if (!teamId) return [];
    return [{ teamId, teamName: cell(row, nameIdx) || teamId }];
  });
}

export async function saveTeams(teams: SheetTeam[]): Promise<void> {
  await writeSheet('Ekipler', [
    ['team_id', 'team_name'],
    ...teams.map((team) => [team.teamId, team.teamName]),
  ]);
}

export async function loadTeamMembers(): Promise<SheetTeamMember[]> {
  const rows = await readSheet('EkipUyeleri');
  if (rows.length < 2) return [];
  const headers = rows[0];
  const teamIdx = headerIndex(headers, ['team_id', 'ekip_id']);
  const userIdx = headerIndex(headers, ['username', 'kullanici_adi', 'user']);
  if (teamIdx < 0 || userIdx < 0) return [];

  return rows.slice(1).flatMap((row) => {
    const teamId = cell(row, teamIdx);
    const username = cell(row, userIdx);
    if (!teamId || !username) return [];
    return [{ teamId, username }];
  });
}

export async function saveTeamMembers(members: SheetTeamMember[]): Promise<void> {
  await writeSheet('EkipUyeleri', [
    ['team_id', 'username'],
    ...members.map((member) => [member.teamId, member.username]),
  ]);
}

export async function loadFolders(): Promise<SheetFolder[]> {
  const rows = await readSheet('Klasorler');
  if (rows.length < 2) return [];
  const headers = rows[0];
  const idIdx = headerIndex(headers, ['folder_id', 'klasor_id', 'id']);
  const labelIdx = headerIndex(headers, ['label', 'ad', 'name', 'baslik']);
  const driveIdx = headerIndex(headers, ['drive_folder_id', 'drive_id', 'google_folder_id']);
  if (idIdx < 0 || driveIdx < 0) {
    throw new Error('Klasorler sayfasında folder_id ve drive_folder_id sütunları gerekli.');
  }

  return rows.slice(1).flatMap((row) => {
    const folderId = cell(row, idIdx);
    const driveFolderId = cell(row, driveIdx);
    if (!folderId || !driveFolderId) return [];
    return [
      {
        folderId,
        label: cell(row, labelIdx) || folderId,
        driveFolderId,
      },
    ];
  });
}

export async function saveFolders(folders: SheetFolder[]): Promise<void> {
  await writeSheet('Klasorler', [
    ['folder_id', 'label', 'drive_folder_id'],
    ...folders.map((folder) => [folder.folderId, folder.label, folder.driveFolderId]),
  ]);
}

export async function loadPermissions(): Promise<SheetPermission[]> {
  const rows = await readSheet('Yetkiler');
  if (rows.length < 2) return [];
  const headers = rows[0];
  const folderIdx = headerIndex(headers, ['folder_id', 'klasor_id']);
  const typeIdx = headerIndex(headers, ['grantee_type', 'type', 'tip', 'hedef_tip']);
  const idIdx = headerIndex(headers, ['grantee_id', 'hedef', 'hedef_id', 'id']);
  if (folderIdx < 0 || typeIdx < 0 || idIdx < 0) return [];

  return rows.slice(1).flatMap((row) => {
    const folderId = cell(row, folderIdx);
    const rawType = cell(row, typeIdx).toLowerCase();
    const granteeId = cell(row, idIdx);
    if (!folderId || !granteeId) return [];

    let granteeType: GranteeType | null = null;
    if (rawType === 'user' || rawType === 'kullanici' || rawType === 'kisi' || rawType === 'person') {
      granteeType = 'user';
    } else if (rawType === 'team' || rawType === 'ekip' || rawType === 'group') {
      granteeType = 'team';
    }
    if (!granteeType) return [];

    return [{ folderId, granteeType, granteeId }];
  });
}

export async function savePermissions(permissions: SheetPermission[]): Promise<void> {
  await writeSheet('Yetkiler', [
    ['folder_id', 'grantee_type', 'grantee_id'],
    ...permissions.map((permission) => [
      permission.folderId,
      permission.granteeType,
      permission.granteeId,
    ]),
  ]);
}

export async function loadAdminSnapshot() {
  const [users, teams, members, folders, permissions] = await Promise.all([
    loadUsers(),
    loadTeams(),
    loadTeamMembers(),
    loadFolders(),
    loadPermissions(),
  ]);

  return {
    users: users.map(({ passwordHash: _passwordHash, ...rest }) => rest),
    teams,
    members,
    folders,
    permissions,
  };
}
