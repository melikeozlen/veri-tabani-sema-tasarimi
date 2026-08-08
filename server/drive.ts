import { drive } from './google.js';
import { env } from './env.js';
import { getAllowedFolders } from './permissions.js';
import type { AuthUser, DriveSourceContent, DriveSourceMeta, SheetFolder } from './types.js';

export type DriveFolderOption = {
  id: string;
  name: string;
  fileCount: number;
};

function isDbmlOrTxt(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.dbml') || lower.endsWith('.txt');
}

async function listFolderFiles(folder: SheetFolder): Promise<DriveSourceMeta[]> {
  const files: DriveSourceMeta[] = [];
  let pageToken: string | undefined;

  do {
    const response = await drive.files.list({
      q: `'${folder.driveFolderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    for (const file of response.data.files ?? []) {
      if (!file.id || !file.name || !isDbmlOrTxt(file.name)) continue;
      files.push({
        id: file.id,
        name: file.name,
        folderId: folder.folderId,
        folderLabel: folder.label,
      });
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return files;
}

async function countDbmlFiles(folderId: string): Promise<number> {
  let count = 0;
  let pageToken: string | undefined;

  do {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    for (const file of response.data.files ?? []) {
      if (file.name && isDbmlOrTxt(file.name)) count += 1;
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return count;
}

/** Service account’un gördüğü Drive klasörlerini listeler. */
export async function listAccessibleDriveFolders(): Promise<DriveFolderOption[]> {
  const folders: { id: string; name: string }[] = [];
  let pageToken: string | undefined;

  const root = env.driveRootFolderId;
  const query = root
    ? `'${root}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    : `mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

  do {
    const response = await drive.files.list({
      q: query,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 100,
      pageToken,
      orderBy: 'name',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: root ? 'allDrives' : 'user',
    });

    for (const file of response.data.files ?? []) {
      if (!file.id || !file.name) continue;
      folders.push({ id: file.id, name: file.name });
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  folders.sort((a, b) => a.name.localeCompare(b.name, 'tr'));

  const withCounts = await Promise.all(
    folders.map(async (folder) => ({
      id: folder.id,
      name: folder.name,
      fileCount: await countDbmlFiles(folder.id),
    })),
  );

  return withCounts;
}

export async function listAllowedSources(user: AuthUser): Promise<DriveSourceMeta[]> {
  const folders = await getAllowedFolders(user);
  const batches = await Promise.all(folders.map((folder) => listFolderFiles(folder)));
  const merged = batches.flat();
  merged.sort((a, b) => {
    const folderCmp = a.folderLabel.localeCompare(b.folderLabel, 'tr');
    if (folderCmp !== 0) return folderCmp;
    return a.name.localeCompare(b.name, 'tr');
  });
  return merged;
}

async function fileBelongsToAllowedFolder(
  fileId: string,
  allowedFolders: SheetFolder[],
): Promise<SheetFolder | null> {
  const meta = await drive.files.get({
    fileId,
    fields: 'id, name, parents',
    supportsAllDrives: true,
  });

  const parents = new Set(meta.data.parents ?? []);
  return allowedFolders.find((folder) => parents.has(folder.driveFolderId)) ?? null;
}

export async function assertSourceAccess(user: AuthUser, fileId: string): Promise<{
  id: string;
  name: string;
  folderId: string;
  folderLabel: string;
}> {
  const allowedFolders = await getAllowedFolders(user);
  const folder = await fileBelongsToAllowedFolder(fileId, allowedFolders);
  if (!folder) {
    throw Object.assign(new Error('Bu dosyaya erişim yetkiniz yok.'), { status: 403 });
  }

  const meta = await drive.files.get({
    fileId,
    fields: 'id, name',
    supportsAllDrives: true,
  });

  const name = meta.data.name || 'dosya.dbml';
  if (!isDbmlOrTxt(name)) {
    throw Object.assign(new Error('Yalnızca .dbml veya .txt dosyaları desteklenir.'), { status: 400 });
  }

  return {
    id: fileId,
    name,
    folderId: folder.folderId,
    folderLabel: folder.label,
  };
}

export async function getAllowedSourceContent(
  user: AuthUser,
  fileId: string,
): Promise<DriveSourceContent> {
  const allowed = await assertSourceAccess(user, fileId);

  const contentResponse = await drive.files.get(
    {
      fileId,
      alt: 'media',
      supportsAllDrives: true,
    },
    { responseType: 'text' },
  );

  const content =
    typeof contentResponse.data === 'string'
      ? contentResponse.data
      : String(contentResponse.data ?? '');

  if (!content.trim()) {
    throw Object.assign(new Error('Dosya boş.'), { status: 400 });
  }

  return {
    ...allowed,
    content,
  };
}

/** Super admin: yetkili Drive klasöründeki .dbml/.txt içeriğini günceller. */
export async function updateAllowedSourceContent(
  user: AuthUser,
  fileId: string,
  content: string,
): Promise<DriveSourceContent> {
  if (!user.isSuperAdmin) {
    throw Object.assign(new Error('Bu işlem için super admin gerekli.'), { status: 403 });
  }

  const trimmed = content.trim();
  if (!trimmed) {
    throw Object.assign(new Error('Dosya içeriği boş olamaz.'), { status: 400 });
  }

  const allowed = await assertSourceAccess(user, fileId);

  await drive.files.update({
    fileId,
    media: {
      mimeType: 'text/plain',
      body: content,
    },
    supportsAllDrives: true,
  });

  return {
    ...allowed,
    content,
  };
}

const BRAND_LOGO_NAMES: Record<'light' | 'dark', string[]> = {
  light: ['logo-light.svg', 'logo-light.png', 'logo-light.webp', 'logo-light.jpg', 'logo-light.jpeg'],
  dark: ['logo-dark.svg', 'logo-dark.png', 'logo-dark.webp', 'logo-dark.jpg', 'logo-dark.jpeg'],
};

const BRAND_LOGO_DIR_NAMES = new Set(['logo', 'logos', 'brand']);

function mimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return 'image/png';
}

async function findLogoInDriveFolder(
  driveFolderId: string,
  scheme: 'light' | 'dark',
): Promise<{ id: string; name: string; mimeType: string } | null> {
  const wanted = new Map(
    BRAND_LOGO_NAMES[scheme].map((name, index) => [name, index] as const),
  );
  let best: { id: string; name: string; rank: number; mimeType?: string | null } | null = null;
  let pageToken: string | undefined;

  do {
    const response = await drive.files.list({
      q: `'${driveFolderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    for (const file of response.data.files ?? []) {
      if (!file.id || !file.name) continue;
      const rank = wanted.get(file.name.toLowerCase());
      if (rank === undefined) continue;
      if (!best || rank < best.rank) {
        best = { id: file.id, name: file.name, rank, mimeType: file.mimeType };
        if (rank === 0) {
          return {
            id: file.id,
            name: file.name,
            mimeType: file.mimeType || mimeFromName(file.name),
          };
        }
      }
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  if (!best) return null;
  return {
    id: best.id,
    name: best.name,
    mimeType: best.mimeType || mimeFromName(best.name),
  };
}

async function findNamedChildFolder(
  parentId: string,
  names: Set<string>,
): Promise<string | null> {
  let pageToken: string | undefined;
  do {
    const response = await drive.files.list({
      q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    for (const file of response.data.files ?? []) {
      if (!file.id || !file.name) continue;
      if (names.has(file.name.trim().toLowerCase())) return file.id;
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return null;
}

/** Yetkili klasör + LOGO alt/kardeş klasör + üst klasör kökü. */
async function findLogoNearAllowedFolder(
  driveFolderId: string,
  scheme: 'light' | 'dark',
): Promise<{ id: string; name: string; mimeType: string } | null> {
  const searchIds: string[] = [driveFolderId];

  const nestedLogo = await findNamedChildFolder(driveFolderId, BRAND_LOGO_DIR_NAMES);
  if (nestedLogo) searchIds.push(nestedLogo);

  try {
    const meta = await drive.files.get({
      fileId: driveFolderId,
      fields: 'parents',
      supportsAllDrives: true,
    });
    for (const parentId of meta.data.parents ?? []) {
      searchIds.push(parentId);
      const siblingLogo = await findNamedChildFolder(parentId, BRAND_LOGO_DIR_NAMES);
      if (siblingLogo) searchIds.push(siblingLogo);
    }
  } catch {
    // üst klasör okunamazsa yalnızca yetkili klasörde ara
  }

  const seen = new Set<string>();
  for (const id of searchIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const found = await findLogoInDriveFolder(id, scheme);
    if (found) return found;
  }
  return null;
}

/** Yetkili Drive klasörlerinde (ve ER/LOGO gibi kardeş LOGO klasöründe) logo bulur. */
export async function getBrandLogoFile(
  user: AuthUser,
  scheme: 'light' | 'dark',
  preferredFolderId?: string,
): Promise<{ data: ArrayBuffer; mimeType: string; name: string } | null> {
  const folders = await getAllowedFolders(user);
  if (folders.length === 0) return null;

  const ordered =
    preferredFolderId && folders.some((folder) => folder.folderId === preferredFolderId)
      ? [
          ...folders.filter((folder) => folder.folderId === preferredFolderId),
          ...folders.filter((folder) => folder.folderId !== preferredFolderId),
        ]
      : folders;

  let meta: { id: string; name: string; mimeType: string } | null = null;
  for (const folder of ordered) {
    meta = await findLogoNearAllowedFolder(folder.driveFolderId, scheme);
    if (meta) break;
  }
  if (!meta) return null;

  const media = await drive.files.get(
    {
      fileId: meta.id,
      alt: 'media',
      supportsAllDrives: true,
    },
    { responseType: 'arraybuffer' },
  );

  return {
    data: media.data as ArrayBuffer,
    mimeType: meta.mimeType,
    name: meta.name,
  };
}
